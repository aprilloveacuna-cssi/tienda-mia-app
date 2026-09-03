-- A simple lump-sum expense log for Kitchen's weekly market buying — separate
-- from Weekly Purchases (which tracks itemized ingredient-by-ingredient
-- costs). This is for when only a total "spent this much at the market"
-- figure is available, used to compute Kitchen's actual profit against real
-- sales revenue for the same period.
create table if not exists kitchen_market_expenses (
  id uuid primary key default gen_random_uuid(),
  week_start date not null,
  week_end date not null,
  amount numeric not null,
  notes text,
  created_at timestamptz not null default now()
);

alter table kitchen_market_expenses enable row level security;
drop policy if exists allow_all_kitchen_market_expenses on kitchen_market_expenses;
create policy require_login_kitchen_market_expenses on kitchen_market_expenses for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
