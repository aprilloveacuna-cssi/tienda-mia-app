-- Physical counts now reconcile against BATCHES, not just the product total.
--
-- Before: posting a count only ever compared the counted number to the
-- product's total, and a decrease (or any line without a typed expiration
-- date) was a product-level adjustment that touched no batch. Batches kept
-- their old quantities, so the batch cards drifted away from the real total,
-- and an item counted under two expiration dates was compared against the
-- full system total once per line (a product that was already right could
-- end up at zero).
--
-- Now, per product, ALL of its unposted lines in the count are added up and
-- compared with the system quantity as of the count date, and the difference
-- is applied to batches the same way sales consume them:
--
--   * FEWER on the shelf than the system says -> the missing units come off
--     the OLDEST batches first (the same FIFO order Sales uses), emptying one
--     batch before moving to the next.
--   * MORE on the shelf than the system says -> the extra units go onto the
--     MOST RECENT batch that still has stock, and share its expiration date.
--   * The item has no batch with stock at all (starting inventory after a
--     wipe) -> there's nothing to follow, so new batches are created: one per
--     count line, using the expiration date typed on that line if any.
--
-- Expiration dates typed on a count line are therefore only used in that last
-- case; staff don't track them while counting, and an item that already has
-- batches follows them instead. An existing batch's own date is never changed
-- by a count (that stays the "Edit date" action on the batch).
--
-- Units that sit in no batch (left over from older product-level
-- adjustments) can't be taken from a batch; if a shortage is bigger than
-- what the batches hold, the rest is a product-level adjustment as before,
-- and the preview says so.
--
-- apply_count_for_product(..., p_dry_run => true) returns exactly what
-- posting would do without writing anything — the screen's preview and the
-- real posting run the very same code, so they can't disagree.

-- Adjustments tied to a batch should be valued at that batch's cost, not the
-- product's current cost, or the daily inventory value history would be off
-- whenever the two differ. Everything else about the trigger is unchanged.
create or replace function post_adjustment_to_ledger()
returns trigger as $$
begin
  insert into inventory_ledger (
    product_id, batch_id, transaction_type, quantity_change,
    unit_cost_at_transaction, source_module, source_reference_id, remarks, created_by
  ) values (
    new.product_id, new.batch_id, 'Adjustment', new.adjustment_quantity,
    coalesce(
      (select unit_cost from batches where id = new.batch_id),
      (select current_cost from products where id = new.product_id)
    ),
    'Adjustments', new.id, new.reason || coalesce(' — ' || new.remarks, ''), new.created_by
  );
  return new;
end;
$$ language plpgsql;

create or replace function apply_count_for_product(
  p_count_id uuid,
  p_product_id uuid,
  p_reason text default null,
  p_dry_run boolean default false
) returns jsonb
language plpgsql
as $$
declare
  v_count physical_counts%rowtype;
  v_product products%rowtype;
  v_counted numeric;
  v_system numeric;
  v_variance numeric;
  v_need numeric;
  v_take numeric;
  v_offset numeric;
  v_steps jsonb := '[]'::jsonb;
  v_has_lines boolean;
  v_new_batch_id uuid;
  b record;
  l record;
  s jsonb;
begin
  select * into v_count from physical_counts where id = p_count_id;
  if not found then
    raise exception 'That count no longer exists.';
  end if;
  select * into v_product from products where id = p_product_id;
  if not found then
    raise exception 'That product no longer exists.';
  end if;

  select exists (
    select 1 from physical_count_lines
    where physical_count_id = p_count_id and product_id = p_product_id and not posted
  ) into v_has_lines;
  if not v_has_lines then
    return jsonb_build_object('status', 'nothing_to_post', 'product_id', p_product_id, 'product_name', v_product.name, 'steps', '[]'::jsonb);
  end if;

  select coalesce(sum(counted_qty), 0) into v_counted
  from physical_count_lines
  where physical_count_id = p_count_id and product_id = p_product_id and not posted;

  -- Same cutoff as get_inventory_as_of(), so this agrees with the System Qty
  -- column on the screen.
  select coalesce(sum(quantity_change), 0) into v_system
  from inventory_ledger
  where product_id = p_product_id
    and occurred_at < (v_count.count_date + interval '1 day');

  v_variance := v_counted - v_system;

  if v_variance = 0 then
    return jsonb_build_object(
      'status', 'matches', 'product_id', p_product_id, 'product_name', v_product.name,
      'system_qty', v_system, 'counted_total', v_counted, 'variance', 0, 'steps', '[]'::jsonb
    );
  end if;

  -- ---------- build the plan ----------
  if v_variance < 0 then
    v_need := -v_variance;
    for b in
      select bc.batch_id, bc.remaining_quantity, bx.expiration_date, bx.received_date
      from batch_cache bc
      join batches bx on bx.id = bc.batch_id
      where bc.product_id = p_product_id and bc.remaining_quantity > 0
      order by bc.fifo_sequence asc
      for update of bc
    loop
      exit when v_need <= 0;
      v_take := least(b.remaining_quantity, v_need);
      v_steps := v_steps || jsonb_build_array(jsonb_build_object(
        'kind', 'remove_from_batch', 'batch_id', b.batch_id, 'quantity', v_take,
        'batch_remaining', b.remaining_quantity,
        'expiration_date', b.expiration_date, 'received_date', b.received_date));
      v_need := v_need - v_take;
    end loop;
    if v_need > 0 then
      v_steps := v_steps || jsonb_build_array(jsonb_build_object('kind', 'adjust_untracked', 'quantity', -v_need));
    end if;
  else
    select bc.batch_id, bc.remaining_quantity, bx.expiration_date, bx.received_date
    into b
    from batch_cache bc
    join batches bx on bx.id = bc.batch_id
    where bc.product_id = p_product_id and bc.remaining_quantity > 0
    order by bc.fifo_sequence desc
    limit 1
    for update of bc;

    if found then
      v_steps := jsonb_build_array(jsonb_build_object(
        'kind', 'add_to_batch', 'batch_id', b.batch_id, 'quantity', v_variance,
        'batch_remaining', b.remaining_quantity,
        'expiration_date', b.expiration_date, 'received_date', b.received_date));
    else
      -- Nothing to follow: starting inventory. One new batch per count line,
      -- covering what was counted; whatever the system wrongly held for this
      -- item (a negative from overselling, or units sitting in no batch) is
      -- cancelled out with a product-level adjustment so the total lands on
      -- exactly what was counted.
      for l in
        select counted_qty, expiration_date
        from physical_count_lines
        where physical_count_id = p_count_id and product_id = p_product_id and not posted and counted_qty > 0
        -- Earliest expiry first so the soonest-expiring stock is created
        -- first and therefore sells first (FIFO follows creation order); then
        -- a stable tiebreak so the result never depends on row order — lines
        -- added together by a CSV import share one timestamp.
        order by expiration_date asc nulls last, created_at, id
      loop
        v_steps := v_steps || jsonb_build_array(jsonb_build_object(
          'kind', 'new_batch', 'quantity', l.counted_qty, 'expiration_date', l.expiration_date,
          'received_date', v_count.count_date));
      end loop;
      v_offset := v_variance - v_counted; -- = minus what the system held
      if v_offset <> 0 then
        v_steps := v_steps || jsonb_build_array(jsonb_build_object('kind', 'adjust_untracked', 'quantity', v_offset));
      end if;
    end if;
  end if;

  if p_dry_run then
    return jsonb_build_object(
      'status', 'planned', 'dry_run', true, 'product_id', p_product_id, 'product_name', v_product.name,
      'system_qty', v_system, 'counted_total', v_counted, 'variance', v_variance, 'steps', v_steps
    );
  end if;

  -- ---------- apply it ----------
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Add a reason before posting — it applies to every adjustment this creates.';
  end if;

  for s in select * from jsonb_array_elements(v_steps) loop
    if s->>'kind' = 'remove_from_batch' then
      insert into adjustments (product_id, batch_id, adjustment_type, reason, reference_number, remarks, old_value, new_value)
      values (p_product_id, (s->>'batch_id')::uuid, 'Count Correction', p_reason, v_count.count_number,
              'Physical count dated ' || v_count.count_date || ' — oldest batch first',
              (s->>'batch_remaining')::numeric, (s->>'batch_remaining')::numeric - (s->>'quantity')::numeric);

    elsif s->>'kind' = 'add_to_batch' then
      insert into adjustments (product_id, batch_id, adjustment_type, reason, reference_number, remarks, old_value, new_value)
      values (p_product_id, (s->>'batch_id')::uuid, 'Count Correction', p_reason, v_count.count_number,
              'Physical count dated ' || v_count.count_date || ' — added to the most recent batch',
              (s->>'batch_remaining')::numeric, (s->>'batch_remaining')::numeric + (s->>'quantity')::numeric);

    elsif s->>'kind' = 'new_batch' then
      insert into batches (product_id, source_type, received_quantity, unit_cost, expiration_date, received_date)
      values (p_product_id, 'BeginningInventory', (s->>'quantity')::numeric, coalesce(v_product.current_cost, 0),
              nullif(s->>'expiration_date', '')::date, v_count.count_date)
      returning id into v_new_batch_id;
      insert into adjustments (product_id, batch_id, adjustment_type, reason, reference_number, remarks, old_value, new_value)
      values (p_product_id, v_new_batch_id, 'Count Correction', p_reason, v_count.count_number,
              'Physical count dated ' || v_count.count_date || ' — starting batch',
              0, (s->>'quantity')::numeric);

    else -- adjust_untracked
      insert into adjustments (product_id, batch_id, adjustment_type, reason, reference_number, remarks, old_value, new_value)
      values (p_product_id, null, 'Count Correction', p_reason, v_count.count_number,
              'Physical count dated ' || v_count.count_date || ' — units not held in any batch',
              v_system, v_system + (s->>'quantity')::numeric);
    end if;
  end loop;

  update physical_count_lines set posted = true
  where physical_count_id = p_count_id and product_id = p_product_id and not posted;

  return jsonb_build_object(
    'status', 'applied', 'dry_run', false, 'product_id', p_product_id, 'product_name', v_product.name,
    'system_qty', v_system, 'counted_total', v_counted, 'variance', v_variance, 'steps', v_steps
  );
end;
$$;

-- What posting would do for every product in a count that still has unposted
-- lines — one call for the whole screen. Writes nothing.
create or replace function count_posting_plan(p_count_id uuid)
returns jsonb
language plpgsql
as $$
declare
  v_out jsonb := '[]'::jsonb;
  v_pid uuid;
begin
  for v_pid in
    select distinct product_id from physical_count_lines
    where physical_count_id = p_count_id and not posted
  loop
    v_out := v_out || jsonb_build_array(apply_count_for_product(p_count_id, v_pid, null, true));
  end loop;
  return v_out;
end;
$$;

-- Supabase's API keeps a cached list of functions; without this the new ones
-- can come back as "not found in the schema cache" until the cache refreshes.
notify pgrst, 'reload schema';
