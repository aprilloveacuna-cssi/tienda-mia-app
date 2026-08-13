-- Fixes post_purchase() so ledger entries are dated to when the purchase
-- actually happened (purchase_date), not whenever the row got inserted.
-- Needed for any "as of a date" calculation to be trustworthy — without
-- this, a purchase posted today for a date last week would be
-- misattributed to today.
create or replace function post_purchase()
returns trigger as $$
declare
  line record;
  new_batch_id uuid;
begin
  if new.status = 'posted' and old.status is distinct from 'posted' then
    for line in select * from purchase_lines where purchase_id = new.id and batch_id is null loop
      insert into batches (product_id, source_type, source_reference_id, received_quantity, unit_cost, expiration_date, received_date)
      values (line.product_id, 'Purchase', line.id, line.quantity, line.unit_cost, line.expiration_date, new.purchase_date)
      returning id into new_batch_id;

      update purchase_lines set batch_id = new_batch_id where id = line.id;

      update products set current_cost = line.unit_cost where id = line.product_id;

      insert into inventory_ledger (product_id, batch_id, transaction_type, quantity_change, unit_cost_at_transaction, source_module, source_reference_id, occurred_at, created_by)
      values (line.product_id, new_batch_id, 'Purchase', line.quantity, line.unit_cost, 'Purchases', new.id, new.purchase_date, new.created_by);
    end loop;
  end if;
  return new;
end;
$$ language plpgsql;

-- Physical Count needs to compare against stock as it stood on the count's
-- own date, not live numbers — a count spanning several days would otherwise
-- get polluted by sales/purchases entered while the count was still open.
alter table physical_counts add column if not exists count_date date not null default current_date;

-- Recomputes stock straight from the ledger up to a cutoff, entirely
-- independent of inventory_cache (which only ever reflects "right now").
-- Aggregated server-side since the ledger can be large.
create or replace function get_inventory_as_of(cutoff_date date)
returns table (product_id uuid, stock numeric) as $$
  select product_id, sum(quantity_change) as stock
  from inventory_ledger
  where occurred_at < (cutoff_date + interval '1 day')
  group by product_id;
$$ language sql stable;
