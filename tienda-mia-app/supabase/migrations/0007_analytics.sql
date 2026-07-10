-- 0007_analytics.sql
-- Phase 3. These are write targets for a scheduled job (nightly Edge Function
-- or cron), not something the app computes live on page load — that's what
-- keeps the Dashboard fast regardless of how much sales history exists.

create table if not exists analytics_cache (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products (id),
  metric text not null, -- e.g. 'velocity_daily', 'abc_class', 'days_of_inventory'
  value numeric(14, 4),
  computed_at timestamptz not null default now(),
  unique (product_id, metric)
);

create table if not exists purchase_recommendations (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products (id),
  computed_at timestamptz not null default now(),
  recommended_quantity numeric(14, 3),
  priority text check (priority in ('Critical', 'NeedsPurchaseThursday', 'CanWait', 'Overstocked')),
  reason text,
  days_of_stock_remaining numeric(10, 2)
);

create index if not exists idx_purchase_rec_product on purchase_recommendations (product_id);
