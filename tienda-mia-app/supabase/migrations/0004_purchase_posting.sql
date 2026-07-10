-- 0004_purchase_posting.sql
-- The person filling the Purchases form only ever touches `purchases` and
-- `purchase_lines`. Flipping a purchase to 'posted' is what creates batches
-- and writes to the ledger — this keeps "receiving" a deliberate action
-- instead of something that happens silently on every line edit.

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

      insert into inventory_ledger (product_id, batch_id, transaction_type, quantity_change, unit_cost_at_transaction, source_module, source_reference_id, created_by)
      values (line.product_id, new_batch_id, 'Purchase', line.quantity, line.unit_cost, 'Purchases', new.id, new.created_by);

      -- Current cost reflects the most recent purchase price
      update products set current_cost = line.unit_cost where id = line.product_id;
    end loop;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_post_purchase on purchases;
create trigger trg_post_purchase
  after update on purchases
  for each row execute function post_purchase();

-- Voiding never deletes history — it writes an equal-and-opposite ledger
-- row for every movement the purchase originally created.
create or replace function void_purchase()
returns trigger as $$
begin
  if new.status = 'voided' and old.status = 'posted' then
    insert into inventory_ledger (product_id, batch_id, transaction_type, quantity_change, unit_cost_at_transaction, source_module, source_reference_id, remarks, created_by)
    select l.product_id, l.batch_id, 'Void', -l.quantity_change, l.unit_cost_at_transaction, 'Purchases', new.id,
           'Reversal of voided purchase ' || new.purchase_number, new.created_by
    from inventory_ledger l
    where l.source_module = 'Purchases' and l.source_reference_id = new.id and l.transaction_type = 'Purchase';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_void_purchase on purchases;
create trigger trg_void_purchase
  after update on purchases
  for each row execute function void_purchase();
