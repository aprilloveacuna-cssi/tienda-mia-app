-- 0005_retail_and_kitchen.sql
-- Phase 2 tables. Structure only for now — FIFO-costing and production-posting
-- logic (the equivalent of post_purchase() in 0004) gets built alongside the
-- Sales and Kitchen UI modules, once there's a real screen to test them against.

create table if not exists sales (
  id uuid primary key default gen_random_uuid(),
  sale_number text unique,
  sale_date timestamptz not null default now(),
  pos_terminal text,
  cashier text,
  status text not null default 'posted' check (status in ('posted', 'voided')),
  total_amount numeric(14, 2) not null default 0
);

create sequence if not exists sales_number_seq;

create or replace function set_sale_number()
returns trigger as $$
begin
  if new.sale_number is null then
    new.sale_number := 'SALE-' || lpad(nextval('sales_number_seq')::text, 6, '0');
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_set_sale_number on sales;
create trigger trg_set_sale_number
  before insert on sales
  for each row execute function set_sale_number();

create table if not exists sale_lines (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references sales (id) on delete restrict,
  product_id uuid not null references products (id),
  quantity numeric(14, 3) not null,
  unit_price numeric(12, 4) not null,
  line_total numeric(14, 2) generated always as (quantity * unit_price) stored,
  fifo_cost numeric(14, 2), -- filled in when the sale posts against batch_cache
  gross_profit numeric(14, 2)
);

create index if not exists idx_sale_lines_sale on sale_lines (sale_id);
create index if not exists idx_sale_lines_product on sale_lines (product_id);

create table if not exists recipes (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products (id), -- the finished good this recipe produces
  yield_quantity numeric(12, 3) not null default 1,
  prep_loss_pct numeric(5, 2) not null default 0,
  packaging_cost numeric(12, 2) not null default 0,
  labor_cost numeric(12, 2) not null default 0,
  overhead_cost numeric(12, 2) not null default 0,
  version int not null default 1,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now()
);

create table if not exists recipe_ingredients (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references recipes (id) on delete cascade,
  ingredient_product_id uuid not null references products (id),
  quantity_per_yield numeric(12, 4) not null,
  unit text
);

create index if not exists idx_recipe_ingredients_recipe on recipe_ingredients (recipe_id);

create table if not exists kitchen_production (
  id uuid primary key default gen_random_uuid(),
  production_number text unique,
  production_date date not null default current_date,
  recipe_id uuid not null references recipes (id),
  quantity_produced numeric(14, 3) not null,
  finished_batch_id uuid references batches (id),
  total_cost numeric(14, 2),
  cost_per_unit numeric(12, 4),
  produced_by text,
  created_at timestamptz not null default now()
);

create sequence if not exists production_number_seq;

create or replace function set_production_number()
returns trigger as $$
begin
  if new.production_number is null then
    new.production_number := 'PROD-' || lpad(nextval('production_number_seq')::text, 6, '0');
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_set_production_number on kitchen_production;
create trigger trg_set_production_number
  before insert on kitchen_production
  for each row execute function set_production_number();
