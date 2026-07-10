-- 0006_ops.sql
-- Returns, Waste, and the POS import queue. Same append-only philosophy as
-- everything else — a return or waste event is a record with its own ledger
-- entry, never a direct edit to inventory.

create table if not exists returns (
  id uuid primary key default gen_random_uuid(),
  return_number text unique,
  return_date date not null default current_date,
  return_type text not null check (return_type in ('Customer', 'Supplier')),
  reference_type text,      -- 'Sale' or 'Purchase'
  reference_id uuid,
  product_id uuid not null references products (id),
  quantity numeric(14, 3) not null,
  reason text,
  restock boolean not null default false,
  created_by text,
  created_at timestamptz not null default now()
);

create sequence if not exists returns_number_seq;

create or replace function set_return_number()
returns trigger as $$
begin
  if new.return_number is null then
    new.return_number := 'RET-' || lpad(nextval('returns_number_seq')::text, 6, '0');
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_set_return_number on returns;
create trigger trg_set_return_number
  before insert on returns
  for each row execute function set_return_number();

create table if not exists waste (
  id uuid primary key default gen_random_uuid(),
  waste_number text unique,
  waste_date date not null default current_date,
  product_id uuid not null references products (id),
  batch_id uuid references batches (id),
  quantity numeric(14, 3) not null,
  reason text not null,
  disposed_by text,
  remarks text,
  created_at timestamptz not null default now()
);

create sequence if not exists waste_number_seq;

create or replace function set_waste_number()
returns trigger as $$
begin
  if new.waste_number is null then
    new.waste_number := 'WST-' || lpad(nextval('waste_number_seq')::text, 6, '0');
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_set_waste_number on waste;
create trigger trg_set_waste_number
  before insert on waste
  for each row execute function set_waste_number();

create table if not exists pos_import_log (
  id uuid primary key default gen_random_uuid(),
  imported_at timestamptz not null default now(),
  file_name text,
  status text not null default 'processing' check (status in ('processing', 'completed', 'failed')),
  unmatched_count int not null default 0
);

create table if not exists pos_unmatched_items (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references pos_import_log (id) on delete cascade,
  pos_item_name text,
  pos_barcode text,
  resolved boolean not null default false,
  linked_product_id uuid references products (id)
);

create index if not exists idx_pos_unmatched_import on pos_unmatched_items (import_id);
