-- Fix: adjustments have never recorded a cost at the time they were posted.
-- Purchases and Sales both correctly write unit_cost_at_transaction; the
-- adjustment trigger never has, leaving every adjustment's cost impact as
-- null. This has been true since the app's first version — it isn't
-- specific to today's feature, but it does mean any historical value
-- calculation built from this column would silently treat every past
-- physical-count correction as having zero value impact. Fixing this going
-- forward: use the product's current cost at the moment the adjustment
-- posts. This does not and cannot fix already-posted adjustments — there
-- was never a recorded cost for those, so there's nothing to recover.
create or replace function post_adjustment_to_ledger()
returns trigger as $$
begin
  insert into inventory_ledger (
    product_id, batch_id, transaction_type, quantity_change,
    unit_cost_at_transaction, source_module, source_reference_id, remarks, created_by
  ) values (
    new.product_id, new.batch_id, 'Adjustment', new.adjustment_quantity,
    (select current_cost from products where id = new.product_id),
    'Adjustments', new.id, new.reason || coalesce(' — ' || new.remarks, ''), new.created_by
  );
  return new;
end;
$$ language plpgsql;

-- Total inventory value (summed across every product, or a filtered set)
-- as of each day in a date range. Uses unit_cost_at_transaction where it
-- was recorded (Purchases, Sales, and Adjustments posted after this fix
-- ships), and falls back to the product's current cost for any older entry
-- that never recorded one (every adjustment posted before this migration).
-- That fallback is an approximation for those specific entries — it uses
-- today's cost, not whatever the true cost was on that historical date,
-- since that number was never captured and cannot be recovered now.
create or replace function get_daily_inventory_value(date_from date, date_to date, product_ids uuid[] default null)
returns table (day date, total_value numeric) as $$
  with daily_change as (
    select
      il.occurred_at::date as d,
      sum(il.quantity_change * coalesce(il.unit_cost_at_transaction, p.current_cost, 0)) as value_change
    from inventory_ledger il
    join products p on p.id = il.product_id
    where il.occurred_at::date <= date_to
    and (product_ids is null or il.product_id = any(product_ids))
    group by il.occurred_at::date
  ),
  cumulative as (
    select d, sum(value_change) over (order by d) as running_total
    from daily_change
  ),
  requested_days as (
    select generate_series(date_from, date_to, interval '1 day')::date as day
  )
  select
    rd.day,
    coalesce(
      (select c.running_total from cumulative c where c.d <= rd.day order by c.d desc limit 1),
      0
    ) as total_value
  from requested_days rd
  order by rd.day;
$$ language sql stable;
