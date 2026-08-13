-- For every product currently sitting at negative stock, finds the exact
-- date its running balance first crossed below zero — computed fresh from
-- the full ledger history via a running total, not a guess.
create or replace function get_first_negative_date()
returns table (product_id uuid, first_negative_date date, current_stock numeric) as $$
  with running as (
    select
      product_id,
      occurred_at,
      sum(quantity_change) over (partition by product_id order by occurred_at, id) as running_total
    from inventory_ledger
  ),
  first_negative as (
    select product_id, min(occurred_at) as first_negative_at
    from running
    where running_total < 0
    group by product_id
  )
  select fn.product_id, fn.first_negative_at::date, ic.current_stock
  from first_negative fn
  join inventory_cache ic on ic.product_id = fn.product_id
  where ic.current_stock < 0;
$$ language sql stable;
