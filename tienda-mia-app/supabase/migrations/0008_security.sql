-- 0008_security.sql
-- IMPORTANT — read before running in anything beyond local testing.
--
-- This turns RLS on (so nothing is silently wide open by default) but the
-- policy below allows any request through, because there's no login screen
-- yet for the app to authenticate against. This is intentionally permissive
-- so the scaffold works today — it is NOT the end state.
--
-- Before real staff start using this with real data, replace the single
-- "allow_all" policy per table with role-aware ones once Supabase Auth is
-- wired into the app, e.g.:
--   create policy "cashiers_read_products" on products
--     for select using (auth.role() = 'authenticated');
--   create policy "managers_write_products" on products
--     for insert, update using (auth.jwt() ->> 'role' = 'manager');
-- so cashiers can log sales but can't edit Products/Settings, matching the
-- role separation the original spec called for.

do $$
declare
  t text;
begin
  for t in select unnest(array[
    'products', 'lists', 'settings',
    'purchases', 'purchase_lines', 'batches',
    'inventory_ledger', 'inventory_cache', 'batch_cache', 'adjustments', 'audit_log',
    'sales', 'sale_lines', 'recipes', 'recipe_ingredients', 'kitchen_production',
    'returns', 'waste', 'pos_import_log', 'pos_unmatched_items',
    'analytics_cache', 'purchase_recommendations'
  ])
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists allow_all_%I on %I', t, t);
    execute format(
      'create policy allow_all_%I on %I for all using (true) with check (true)', t, t
    );
  end loop;
end $$;
