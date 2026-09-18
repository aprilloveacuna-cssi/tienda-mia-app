-- Total inventory quantity (summed across every product, or a specific set
-- of products when filtered) as of each day in a date range. Built to avoid
-- the cost of the existing get_inventory_as_of() function, which does a
-- full ledger scan every time it's called — running that once per day
-- across a month-long range would mean 30+ full scans. This does one pass
-- over the ledger (grouped by day), then a cheap running total over that
-- much smaller per-day set.
--
-- product_ids: pass the currently-filtered product list (matching whatever
-- Type/Category filter is active on the page) so the trend stays consistent
-- with the live Total Qty figure above it. Pass null to include everything.
create or replace function get_daily_inventory_totals(date_from date, date_to date, product_ids uuid[] default null)
returns table (day date, total_qty numeric) as $$
  with daily_change as (
    select occurred_at::date as d, sum(quantity_change) as net_change
    from inventory_ledger
    where occurred_at::date <= date_to
    and (product_ids is null or product_id = any(product_ids))
    group by occurred_at::date
  ),
  cumulative as (
    select d, sum(net_change) over (order by d) as running_total
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
    ) as total_qty
  from requested_days rd
  order by rd.day;
$$ language sql stable;

