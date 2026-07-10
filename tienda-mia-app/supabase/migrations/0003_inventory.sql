-- 0003_inventory.sql
-- The core rule of this whole schema: inventory is never hand-edited.
-- inventory_ledger is append-only and is the only source of truth for stock.
-- inventory_cache / batch_cache are snapshots the app keeps in sync incrementally
-- (small write per transaction) so reads stay fast at 100k+ rows instead of
-- re-summing the ledger on every page load.

create table if not exists inventory_ledger (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  product_id uuid not null references products (id),
  batch_id uuid references batches (id),
  transaction_type text not null check (
    transaction_type in (
      'Purchase', 'Sale', 'KitchenConsumption', 'KitchenProduction',
      'Adjustment', 'Return', 'Waste', 'BeginningInventory', 'Void'
    )
  ),
  quantity_change numeric(14, 3) not null, -- positive = in, negative = out
  unit_cost_at_transaction numeric(12, 4),
  source_module text not null,
  source_reference_id uuid,
  remarks text,
  created_by text
);

-- No update/delete policy is defined on purpose — corrections are new rows
-- (transaction_type = 'Void') that reference the original, never edits.
create index if not exists idx_ledger_product on inventory_ledger (product_id);
create index if not exists idx_ledger_batch on inventory_ledger (batch_id);
create index if not exists idx_ledger_type on inventory_ledger (transaction_type);
create index if not exists idx_ledger_occurred_at on inventory_ledger (occurred_at);

create table if not exists inventory_cache (
  product_id uuid primary key references products (id),
  current_stock numeric(14, 3) not null default 0,
  inventory_value numeric(14, 2) not null default 0,
  reserved_stock numeric(14, 3) not null default 0,
  available_stock numeric(14, 3) not null default 0,
  last_movement_at timestamptz
);

create table if not exists batch_cache (
  batch_id uuid primary key references batches (id),
  product_id uuid not null references products (id),
  remaining_quantity numeric(14, 3) not null default 0,
  unit_cost numeric(12, 4) not null default 0,
  expiration_date date,
  fifo_sequence bigint not null
);

create index if not exists idx_batch_cache_product_fifo on batch_cache (product_id, fifo_sequence);

create sequence if not exists batch_fifo_seq;

-- Keeps inventory_cache and batch_cache in sync every time a ledger row is written.
-- This is what makes reads O(1) instead of O(all history) at scale.
create or replace function apply_ledger_entry()
returns trigger as $$
begin
  -- Roll up the product-level snapshot
  insert into inventory_cache (product_id, current_stock, inventory_value, available_stock, last_movement_at)
  values (new.product_id, new.quantity_change, 0, new.quantity_change, new.occurred_at)
  on conflict (product_id) do update
    set current_stock = inventory_cache.current_stock + new.quantity_change,
        available_stock = inventory_cache.available_stock + new.quantity_change,
        last_movement_at = new.occurred_at;

  -- Recompute inventory value off current cost (kept simple; FIFO-weighted value
  -- can replace this once batch_cache carries enough history to sum accurately)
  update inventory_cache ic
  set inventory_value = ic.current_stock * coalesce((select current_cost from products where id = new.product_id), 0)
  where ic.product_id = new.product_id;

  -- Roll up the batch-level snapshot, when this movement is tied to a batch
  if new.batch_id is not null then
    insert into batch_cache (batch_id, product_id, remaining_quantity, unit_cost, expiration_date, fifo_sequence)
    select new.batch_id, new.product_id, new.quantity_change, coalesce(new.unit_cost_at_transaction, 0),
           b.expiration_date, nextval('batch_fifo_seq')
    from batches b where b.id = new.batch_id
    on conflict (batch_id) do update
      set remaining_quantity = batch_cache.remaining_quantity + new.quantity_change;
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_apply_ledger_entry on inventory_ledger;
create trigger trg_apply_ledger_entry
  after insert on inventory_ledger
  for each row execute function apply_ledger_entry();

create table if not exists adjustments (
  id uuid primary key default gen_random_uuid(),
  adjustment_number text unique,
  adjustment_date date not null default current_date,
  product_id uuid not null references products (id),
  batch_id uuid references batches (id),
  adjustment_type text not null,
  reason text not null,
  reference_number text,
  old_value numeric(14, 3) not null,
  new_value numeric(14, 3) not null,
  adjustment_quantity numeric(14, 3) generated always as (new_value - old_value) stored,
  remarks text,
  created_by text,
  created_at timestamptz not null default now()
);

create sequence if not exists adjustments_number_seq;

create or replace function set_adjustment_number()
returns trigger as $$
begin
  if new.adjustment_number is null then
    new.adjustment_number := 'ADJ-' || lpad(nextval('adjustments_number_seq')::text, 6, '0');
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_set_adjustment_number on adjustments;
create trigger trg_set_adjustment_number
  before insert on adjustments
  for each row execute function set_adjustment_number();

-- Every adjustment writes its own ledger row automatically — the person filling
-- the form only ever touches `adjustments`, never the ledger directly.
create or replace function post_adjustment_to_ledger()
returns trigger as $$
begin
  insert into inventory_ledger (
    product_id, batch_id, transaction_type, quantity_change,
    source_module, source_reference_id, remarks, created_by
  ) values (
    new.product_id, new.batch_id, 'Adjustment', new.adjustment_quantity,
    'Adjustments', new.id, new.reason || coalesce(' — ' || new.remarks, ''), new.created_by
  );
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_post_adjustment on adjustments;
create trigger trg_post_adjustment
  after insert on adjustments
  for each row execute function post_adjustment_to_ledger();

create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  app_user text,
  module text not null,
  record_id text,
  action text not null,
  old_value jsonb,
  new_value jsonb
);

create index if not exists idx_audit_module on audit_log (module);
