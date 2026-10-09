-- Fixes a posted purchase line that was entered under the wrong item: moves
-- the quantity off that item and onto the right one, as a single all-or-
-- nothing step.
--
-- Nothing in the ledger is edited — it's append-only by design. Instead:
--   * a NEGATIVE 'Purchase' row takes the quantity back out of the wrong
--     item's batch, and
--   * a new batch is created for the right item with a matching POSITIVE
--     'Purchase' row, both dated to the purchase itself (same reasoning as
--     0018: "as of a date" numbers stay trustworthy) and both pointing at the
--     purchase, exactly like the rows posting wrote.
-- Recording the correction as Purchase rows is deliberate: voiding the whole
-- purchase later reverses every Purchase row it owns (see void_purchase), so
-- the correction rows get reversed right along with the originals and every
-- item nets back to zero.
--
-- Only stock still on hand can be moved. If some of the line was already
-- sold, the rest can't be pulled back out from under those sales, so the
-- most that can move is what's left in the batch.
--
-- Side effects handled, since posting had them too:
--   * Posting a purchase overwrites the product's current_cost with the line's
--     unit cost — so the wrong item picked up a cost that isn't its own. When
--     the whole line leaves it and it still carries that cost, it goes back to
--     its previous purchase price (if there is one). The right item gets the
--     line's cost unless it has a more recent purchase.
--   * The reactivate-on-movement trigger treats any Purchase row as activity;
--     the right item should come back if it was archived, the wrong one
--     shouldn't just because stock left it — so its status is put back.
--   * Back-dated ledger rows move inventory_cache.last_movement_at to the
--     purchase date; that's reset to the product's real latest movement.
create or replace function move_purchase_line_to_product(
  p_line_id uuid,
  p_new_product_id uuid,
  p_quantity numeric default null,
  p_reason text default null
) returns jsonb
language plpgsql
as $$
declare
  v_line purchase_lines%rowtype;
  v_purchase purchases%rowtype;
  v_old_product products%rowtype;
  v_new_product products%rowtype;
  v_old_batch batches%rowtype;
  v_remaining numeric;
  v_qty numeric;
  v_full boolean;
  v_target_line_id uuid;
  v_new_batch_id uuid;
  v_prev_cost numeric;
  v_cost_restored boolean := false;
  v_remark_old text;
  v_remark_new text;
begin
  select * into v_line from purchase_lines where id = p_line_id for update;
  if not found then
    raise exception 'That purchase line no longer exists.';
  end if;

  select * into v_purchase from purchases where id = v_line.purchase_id for update;
  if v_purchase.status <> 'posted' then
    raise exception 'Only lines on a posted purchase can be moved — this purchase is %.', v_purchase.status;
  end if;
  if v_line.batch_id is null then
    raise exception 'This line has no batch yet, so there is no stock to move.';
  end if;
  if v_line.product_id = p_new_product_id then
    raise exception 'Pick a different item than the one already on the line.';
  end if;

  select * into v_new_product from products where id = p_new_product_id;
  if not found then
    raise exception 'The item to move to doesn''t exist.';
  end if;
  select * into v_old_product from products where id = v_line.product_id;
  select * into v_old_batch from batches where id = v_line.batch_id;

  v_qty := coalesce(p_quantity, v_line.quantity);
  if v_qty <= 0 or v_qty > v_line.quantity then
    raise exception 'The quantity to move must be more than 0 and no more than the line''s % .', v_line.quantity;
  end if;
  v_full := (v_qty = v_line.quantity);

  select remaining_quantity into v_remaining from batch_cache where batch_id = v_line.batch_id for update;
  v_remaining := coalesce(v_remaining, 0);
  if v_remaining < v_qty then
    raise exception 'Only % of the % on this line are still in stock — the rest was already sold or removed, so at most % can be moved.',
      trim_scale(v_remaining), trim_scale(v_line.quantity), trim_scale(v_remaining);
  end if;

  -- Costs first: the ledger writes below recalculate inventory_value off
  -- current_cost, same ordering rule post_purchase() follows.
  if v_full and v_old_product.current_cost is not distinct from v_line.unit_cost then
    select pl.unit_cost into v_prev_cost
    from purchase_lines pl
    join purchases pu on pu.id = pl.purchase_id
    where pl.product_id = v_line.product_id
      and pl.id <> v_line.id
      and pu.status = 'posted'
      and pl.batch_id is not null
    order by pu.purchase_date desc, pl.created_at desc
    limit 1;
    if found then
      update products set current_cost = v_prev_cost where id = v_line.product_id;
      v_cost_restored := true;
    end if;
  end if;

  if not exists (
    select 1
    from purchase_lines pl
    join purchases pu on pu.id = pl.purchase_id
    where pl.product_id = p_new_product_id
      and pu.status = 'posted'
      and pl.batch_id is not null
      and pu.purchase_date > v_purchase.purchase_date
  ) then
    update products set current_cost = v_line.unit_cost where id = p_new_product_id;
  end if;

  -- The line(s): the whole line changes item, or it's split in two.
  if v_full then
    v_target_line_id := v_line.id;
  else
    insert into purchase_lines (purchase_id, product_id, quantity, unit_cost, expiration_date)
    values (v_line.purchase_id, p_new_product_id, v_qty, v_line.unit_cost, v_line.expiration_date)
    returning id into v_target_line_id;
    update purchase_lines set quantity = quantity - v_qty where id = v_line.id;
  end if;

  -- The new batch carries over the old batch's expiration date as it stands
  -- now (it may have been edited since receiving).
  insert into batches (product_id, source_type, source_reference_id, received_quantity, unit_cost, expiration_date, received_date)
  values (p_new_product_id, 'Purchase', v_target_line_id, v_qty, v_line.unit_cost, v_old_batch.expiration_date, v_purchase.purchase_date)
  returning id into v_new_batch_id;

  if v_full then
    update purchase_lines set product_id = p_new_product_id, batch_id = v_new_batch_id where id = v_line.id;
  else
    update purchase_lines set batch_id = v_new_batch_id where id = v_target_line_id;
  end if;

  -- The wrong item's batch never really received these units.
  update batches set received_quantity = received_quantity - v_qty where id = v_line.batch_id;

  v_remark_old := 'Moved ' || trim_scale(v_qty)::text || ' to ' || v_new_product.name
    || ' — ' || v_purchase.purchase_number || ' was entered under the wrong item'
    || coalesce(' (' || nullif(trim(p_reason), '') || ')', '');
  v_remark_new := 'Moved ' || trim_scale(v_qty)::text || ' from ' || v_old_product.name
    || ' — ' || v_purchase.purchase_number || ' was entered under the wrong item'
    || coalesce(' (' || nullif(trim(p_reason), '') || ')', '');

  insert into inventory_ledger (product_id, batch_id, transaction_type, quantity_change, unit_cost_at_transaction, source_module, source_reference_id, occurred_at, remarks, created_by)
  values
    (v_line.product_id, v_line.batch_id, 'Purchase', -v_qty, v_line.unit_cost, 'Purchases', v_purchase.id, v_purchase.purchase_date, v_remark_old, v_purchase.created_by),
    (p_new_product_id, v_new_batch_id, 'Purchase', v_qty, v_line.unit_cost, 'Purchases', v_purchase.id, v_purchase.purchase_date, v_remark_new, v_purchase.created_by);

  -- Undo the side effects of those rows described at the top.
  update products set status = v_old_product.status
  where id = v_line.product_id and status is distinct from v_old_product.status;

  update inventory_cache ic
  set last_movement_at = (select max(l.occurred_at) from inventory_ledger l where l.product_id = ic.product_id)
  where ic.product_id in (v_line.product_id, p_new_product_id);

  return jsonb_build_object(
    'moved_quantity', v_qty,
    'from_product', v_old_product.name,
    'to_product', v_new_product.name,
    'whole_line', v_full,
    'new_line_id', v_target_line_id,
    'old_cost_restored', v_cost_restored,
    'old_cost_now', (select current_cost from products where id = v_line.product_id)
  );
end;
$$;

-- Supabase's API keeps a cached list of functions; without this the new one
-- can come back as "not found in the schema cache" until the cache refreshes.
notify pgrst, 'reload schema';
