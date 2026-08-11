-- Physical Counts: a monthly reconciliation workflow that needs to survive
-- across sessions — a full store count can take days, not one sitting.
-- Structured like purchase_lists: a header per count (draft or completed),
-- with lines that persist as they're added, not just held in memory.

create table if not exists physical_counts (
  id uuid primary key default gen_random_uuid(),
  count_number text unique not null,
  label text,
  status text not null default 'draft' check (status in ('draft', 'completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create sequence if not exists physical_counts_number_seq start 1;

create or replace function set_physical_count_number()
returns trigger as $$
begin
  if new.count_number is null then
    new.count_number := 'PC-' || lpad(nextval('physical_counts_number_seq')::text, 6, '0');
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_set_physical_count_number on physical_counts;
create trigger trg_set_physical_count_number
before insert on physical_counts
for each row execute function set_physical_count_number();

create table if not exists physical_count_lines (
  id uuid primary key default gen_random_uuid(),
  physical_count_id uuid not null references physical_counts (id) on delete cascade,
  product_id uuid not null references products (id),
  counted_qty numeric not null,
  posted boolean not null default false,
  created_at timestamptz not null default now()
);

alter table physical_counts enable row level security;
drop policy if exists allow_all_physical_counts on physical_counts;
create policy allow_all_physical_counts on physical_counts for all using (true) with check (true);

alter table physical_count_lines enable row level security;
drop policy if exists allow_all_physical_count_lines on physical_count_lines;
create policy allow_all_physical_count_lines on physical_count_lines for all using (true) with check (true);
