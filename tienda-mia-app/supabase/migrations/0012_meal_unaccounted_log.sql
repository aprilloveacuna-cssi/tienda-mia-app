-- Purely a side-monitoring log — never touches Sales, Inventory, or the
-- ledger. Lets a manually-logged description (e.g. "staff lunch July 1")
-- reduce the "unaccounted for" gap between what's been sold and what's been
-- explained, the same way disposing an expired batch clears an alert.
create table if not exists meal_unaccounted_log (
  id uuid primary key default gen_random_uuid(),
  log_date date not null default current_date,
  quantity numeric not null,
  description text not null,
  total_price numeric,
  created_at timestamptz not null default now()
);

alter table meal_unaccounted_log enable row level security;
drop policy if exists allow_all_meal_unaccounted_log on meal_unaccounted_log;
create policy allow_all_meal_unaccounted_log on meal_unaccounted_log for all using (true) with check (true);
