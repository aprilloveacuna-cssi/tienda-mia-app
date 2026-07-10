-- 0002_purchasing.sql
-- Receiving inventory. Posting a purchase line creates a batch and (via
-- 0003_inventory.sql's ledger) is the only legitimate way stock enters the system
-- other than Kitchen Production, Adjustments, Returns, or Beginning Inventory.

create table if not exists purchases (
  id uuid primary key default gen_random_uuid(),
  purchase_number text unique,
  purchase_date date not null default current_date,
  invoice_number text,
  supplier text,
  status text not null default 'draft' check (status in ('draft', 'posted', 'voided')),
  total_cost numeric(14, 2) not null default 0,
  created_by text,
  created_at timestamptz not null default now()
);

create sequence if not exists purchases_number_seq;

create or replace function set_purchase_number()
returns trigger as $$
begin
  if new.purchase_number is null then
    new.purchase_number := 'PO-' || lpad(nextval('purchases_number_seq')::text, 6, '0');
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_set_purchase_number on purchases;
create trigger trg_set_purchase_number
  before insert on purchases
  for each row execute function set_purchase_number();

create table if not exists batches (
  id uuid primary key default gen_random_uuid(),
  batch_number text unique,
  product_id uuid not null references products (id),
  source_type text not null check (source_type in ('Purchase', 'KitchenProduction', 'BeginningInventory')),
  source_reference_id uuid,
  received_quantity numeric(14, 3) not null,
  unit_cost numeric(12, 4) not null default 0,
  expiration_date date,
  received_date date not null default current_date,
  status text not null default 'active' check (status in ('active', 'depleted', 'expired', 'disposed')),
  created_at timestamptz not null default now()
);

create index if not exists idx_batches_product on batches (product_id);
create index if not exists idx_batches_status on batches (status);

create sequence if not exists batches_number_seq;

create or replace function set_batch_number()
returns trigger as $$
begin
  if new.batch_number is null then
    new.batch_number := 'BATCH-' || lpad(nextval('batches_number_seq')::text, 6, '0');
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_set_batch_number on batches;
create trigger trg_set_batch_number
  before insert on batches
  for each row execute function set_batch_number();

create table if not exists purchase_lines (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references purchases (id) on delete restrict,
  product_id uuid not null references products (id),
  quantity numeric(14, 3) not null,
  unit_cost numeric(12, 4) not null,
  total_cost numeric(14, 2) generated always as (quantity * unit_cost) stored,
  expiration_date date,
  batch_id uuid references batches (id), -- filled in when the line is posted
  created_at timestamptz not null default now()
);

create index if not exists idx_purchase_lines_purchase on purchase_lines (purchase_id);
create index if not exists idx_purchase_lines_product on purchase_lines (product_id);
