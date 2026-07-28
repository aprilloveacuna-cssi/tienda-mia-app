-- Purchase Lists: a manual planning/cost-analysis tool. Completely separate
-- from real Purchases — creating, editing, or deleting these never touches
-- Inventory or writes to inventory_ledger. Exists purely so a list survives
-- navigating away, and so past lists are kept as real history over time.

create table if not exists purchase_lists (
  id uuid primary key default gen_random_uuid(),
  list_number text unique not null,
  label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create sequence if not exists purchase_lists_number_seq start 1;

create or replace function set_purchase_list_number()
returns trigger as $$
begin
  if new.list_number is null then
    new.list_number := 'PL-' || lpad(nextval('purchase_lists_number_seq')::text, 6, '0');
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_set_purchase_list_number on purchase_lists;
create trigger trg_set_purchase_list_number
before insert on purchase_lists
for each row execute function set_purchase_list_number();

create table if not exists purchase_list_lines (
  id uuid primary key default gen_random_uuid(),
  purchase_list_id uuid not null references purchase_lists (id) on delete cascade,
  product_id uuid not null references products (id),
  quantity numeric not null,
  unit_cost numeric not null default 0,
  packaging_note text,
  created_at timestamptz not null default now()
);

-- Same permissive RLS policy used everywhere else in this app so far.
alter table purchase_lists enable row level security;
drop policy if exists allow_all_purchase_lists on purchase_lists;
create policy allow_all_purchase_lists on purchase_lists for all using (true) with check (true);

alter table purchase_list_lines enable row level security;
drop policy if exists allow_all_purchase_list_lines on purchase_list_lines;
create policy allow_all_purchase_list_lines on purchase_list_lines for all using (true) with check (true);
