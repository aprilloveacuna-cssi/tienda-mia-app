-- Units sold each day that came specifically from a batch that was near
-- its expiration date AT THE TIME of that sale (not today) — traced through
-- the actual batch each sale line drew from via FIFO consumption, joined to
-- that batch's real expiration date. This is a per-day flow (how much moved
-- that day), not a running balance like the qty/value trends — a day with
-- zero near-expiry sales correctly shows 0, not a carried-forward total.
create or replace function get_daily_near_expiry_sales(date_from date, date_to date, alert_days integer default 15, product_ids uuid[] default null)
returns table (day date, near_expiry_qty numeric) as $$
  with requested_days as (
    select generate_series(date_from, date_to, interval '1 day')::date as day
  ),
  sales_by_day as (
    select
      il.occurred_at::date as d,
      sum(-il.quantity_change) as qty
    from inventory_ledger il
    join batches b on b.id = il.batch_id
    where il.transaction_type = 'Sale'
    and il.occurred_at::date between date_from and date_to
    and b.expiration_date is not null
    and b.expiration_date <= (il.occurred_at::date + alert_days)
    and (product_ids is null or il.product_id = any(product_ids))
    group by il.occurred_at::date
  )
  select rd.day, coalesce(sbd.qty, 0) as near_expiry_qty
  from requested_days rd
  left join sales_by_day sbd on sbd.d = rd.day
  order by rd.day;
$$ language sql stable;
