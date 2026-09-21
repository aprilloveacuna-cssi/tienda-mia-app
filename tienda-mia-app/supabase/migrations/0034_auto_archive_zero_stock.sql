-- Auto-archives products that have sat at 0 (or negative) stock for
-- AUTO_ARCHIVE_ZERO_STOCK_DAYS straight (default 21). "Straight" is
-- computed from real ledger history, not just today's snapshot: it finds
-- the last date each product's running stock was ever above zero, and only
-- archives if that was far enough in the past. A product that's never once
-- been above zero uses its own created_at as the starting point instead.
--
-- Kitchen and unlimited_stock items are excluded — same reasoning as Stock
-- Alerts and the Buy 1 Take 1 recommendations already use: a made-to-order
-- item sitting at 0 isn't a meaningful "this is discontinued" signal.
-- Already-archived products are excluded too, since there's nothing to do.
--
-- Deliberately NOT automatic the moment stock hits 0 — see the note on
-- Products' Stock column: a product briefly out of stock while waiting on
-- a reorder is normal and shouldn't be discontinued. Only a full,
-- uninterrupted 3-week (by default) stretch trips this.
insert into settings (key, value)
values ('AUTO_ARCHIVE_ZERO_STOCK_DAYS', '21')
on conflict (key) do nothing;

create or replace function auto_archive_stale_zero_stock()
returns table (product_id uuid, name text, zero_since date) as $$
declare
  days_threshold integer;
begin
  select coalesce((select value::integer from settings where key = 'AUTO_ARCHIVE_ZERO_STOCK_DAYS'), 21)
    into days_threshold;

  return query
  with running as (
    select
      il.product_id,
      il.occurred_at,
      sum(il.quantity_change) over (partition by il.product_id order by il.occurred_at, il.id) as running_total
    from inventory_ledger il
  ),
  last_positive as (
    select r.product_id, max(r.occurred_at) as last_positive_at
    from running r
    where r.running_total > 0
    group by r.product_id
  ),
  candidates as (
    select
      p.id as candidate_id,
      p.name as candidate_name,
      coalesce(lp.last_positive_at::date, p.created_at::date) as candidate_zero_since
    from products p
    join inventory_cache ic on ic.product_id = p.id
    left join last_positive lp on lp.product_id = p.id
    where p.status = 'active'
      and ic.current_stock <= 0
      and coalesce(p.business_unit, '') <> 'KITCHEN'
      and coalesce(p.category, '') <> 'KITCHEN'
      and coalesce(p.unlimited_stock, false) = false
      and coalesce(lp.last_positive_at::date, p.created_at::date) <= current_date - days_threshold
  ),
  archived as (
    update products
    set status = 'archived'
    where id in (select candidate_id from candidates)
    returning id
  )
  select a.id, c.candidate_name, c.candidate_zero_since
  from archived a
  join candidates c on c.candidate_id = a.id;
end;
$$ language plpgsql;
