-- 0001_core.sql
-- Products master data, dropdown Lists, and key-value Settings.
-- Products never stores a quantity — see 0003_inventory.sql for why.

create extension if not exists pgcrypto;

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  sku text unique,
  barcode text unique not null,
  name text not null,
  brand text,
  category text,
  business_unit text,
  product_type text,
  unit text,
  selling_price numeric(12, 2) default 0,
  current_cost numeric(12, 2) default 0, -- maintained by the app on purchase/production, not hand-edited
  image_url text,                        -- points at Supabase Storage; the file itself never lives here
  minimum_stock numeric(12, 2) default 0,
  reorder_point numeric(12, 2) default 0,
  safety_stock numeric(12, 2) default 0,
  status text not null default 'active' check (status in ('active', 'archived')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_products_status on products (status);
create index if not exists idx_products_category on products (category);

-- Auto-generate a human-readable SKU (SKU-000001) on insert, if one wasn't supplied.
create sequence if not exists products_sku_seq;

create or replace function set_product_sku()
returns trigger as $$
begin
  if new.sku is null then
    new.sku := 'SKU-' || lpad(nextval('products_sku_seq')::text, 6, '0');
  end if;
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_set_product_sku on products;
create trigger trg_set_product_sku
  before insert on products
  for each row execute function set_product_sku();

create or replace function touch_updated_at()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_products_updated_at on products;
create trigger trg_products_updated_at
  before update on products
  for each row execute function touch_updated_at();

-- Centralized dropdown values, so validation lives in one place instead of
-- being hardcoded per form field.
create table if not exists lists (
  id uuid primary key default gen_random_uuid(),
  list_type text not null,
  value text not null,
  active boolean not null default true,
  unique (list_type, value)
);

-- Seed a starting set so the Products form has real dropdowns on first run.
insert into lists (list_type, value) values
  ('Category', 'Grocery'),
  ('Category', 'Beverages'),
  ('Category', 'Snacks'),
  ('Category', 'Bakery'),
  ('Category', 'Raw Materials'),
  ('Category', 'Household'),
  ('ProductType', 'Retail Item'),
  ('ProductType', 'Raw Material'),
  ('ProductType', 'Finished Good'),
  ('BusinessUnit', 'Retail'),
  ('BusinessUnit', 'Kitchen'),
  ('Unit', 'pcs'),
  ('Unit', 'kg'),
  ('Unit', 'g'),
  ('Unit', 'L'),
  ('Unit', 'ml'),
  ('Unit', 'pack'),
  ('AdjustmentType', 'Count Correction'),
  ('AdjustmentType', 'Damage'),
  ('AdjustmentType', 'System Error Fix'),
  ('WasteReason', 'Expired'),
  ('WasteReason', 'Damaged'),
  ('WasteReason', 'Spoiled'),
  ('ReturnReason', 'Customer Changed Mind'),
  ('ReturnReason', 'Wrong Item'),
  ('ReturnReason', 'Defective')
on conflict (list_type, value) do nothing;

create table if not exists settings (
  key text primary key,
  value text not null,
  description text
);

insert into settings (key, value, description) values
  ('PURCHASING_DAY', 'Thursday', 'Day of week purchase recommendations are generated for'),
  ('DEFAULT_SAFETY_STOCK_PCT', '20', 'Default safety stock as a percent of average weekly demand'),
  ('FORECAST_WINDOW_WEEKS', '8', 'How many weeks of sales history forecasting looks back on'),
  ('DEFAULT_LEAD_TIME_DAYS', '3', 'Default supplier lead time when a product has none set')
on conflict (key) do nothing;
