-- Same calculation as before, but now also reports whether each day's
-- cumulative total includes any transaction that never recorded a real
-- cost (only possible for Adjustments posted before the trigger fix in
-- migration 0029). Once an uncosted entry enters the running total, every
-- day from that point forward is flagged — the estimate doesn't wash out,
-- it carries forward permanently, since this is a cumulative balance.
-- This does not fix the historical data (that's not possible — the real
-- cost for those old entries was never captured and cannot be recovered),
-- it makes clear exactly which numbers are real and which are estimated.
create or replace function get_daily_inventory_value(date_from date, date_to date, product_ids uuid[] default null)
returns table (day date, total_value numeric, has_estimate boolean) as $$
  with daily_change as (
    select
      il.occurred_at::date as d,
      sum(il.quantity_change * coalesce(il.unit_cost_at_transaction, p.current_cost, 0)) as value_change,
      bool_or(il.unit_cost_at_transaction is null) as had_null_cost_entry
    from inventory_ledger il
    join products p on p.id = il.product_id
    where il.occurred_at::date <= date_to
    and (product_ids is null or il.product_id = any(product_ids))
    group by il.occurred_at::date
  ),
  cumulative as (
    select
      d,
      sum(value_change) over (order by d) as running_total,
      bool_or(had_null_cost_entry) over (order by d) as running_has_estimate
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
    ) as total_value,
    coalesce(
      (select c.running_has_estimate from cumulative c where c.d <= rd.day order by c.d desc limit 1),
      false
    ) as has_estimate
  from requested_days rd
  order by rd.day;
$$ language sql stable;
