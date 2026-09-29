-- Reactivates an archived product the moment real movement is recorded for
-- it — a trigger on inventory_ledger itself rather than something added to
-- Sales/Purchases/Kitchen individually, since every one of those (and any
-- CSV/POS import) already funnels through this one table regardless of
-- which page or path wrote it.
--
-- Not every transaction_type counts as "this is back in business" though:
--   Sale, Purchase, KitchenProduction — always reactivate. A real sale, a
--     restock, or a fresh kitchen batch is exactly the signal that means a
--     discontinued product is active again.
--   Adjustment — only reactivates when quantity_change is positive (stock
--     found going up). A negative Adjustment is a correction bringing
--     stock down — exactly the shape of the bulk zero-out fix used
--     earlier — and shouldn't un-discontinue anything.
--   Waste, Void, Return — never reactivate. These are cleanup/reversal
--     events, not a deliberate decision to carry the product again —
--     disposing old phantom stock from a discontinued item, for instance,
--     shouldn't bring it back.
create or replace function reactivate_product_on_movement()
returns trigger as $$
begin
  if new.transaction_type in ('Sale', 'Purchase', 'KitchenProduction')
     or (new.transaction_type = 'Adjustment' and new.quantity_change > 0)
  then
    update products
    set status = 'active'
    where id = new.product_id and status = 'archived';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_reactivate_product_on_movement on inventory_ledger;
create trigger trg_reactivate_product_on_movement
after insert on inventory_ledger
for each row
execute function reactivate_product_on_movement();
