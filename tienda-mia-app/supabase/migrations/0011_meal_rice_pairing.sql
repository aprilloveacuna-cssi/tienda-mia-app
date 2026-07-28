-- Supports the Meal/Only + Rice tracking pattern:
--  - pairs_with_product_id: links a "X Meal" product to its "X Only" counterpart
--    (or any two products that should be counted together in reports), so
--    combined sold totals can be reported without recording two sales.
--  - rice_cups: how many cups of rice a single unit of this product represents
--    when sold (e.g. Rice = 1, Half Rice = 0.5, any "X Meal" = 1, "X Only" = 0).
--    Used purely for a reporting tally, not inventory deduction.
--  - unlimited_stock: this product never blocks a sale for insufficient stock —
--    for items like Rice where real batch-level stock isn't tracked precisely.
alter table products add column if not exists pairs_with_product_id uuid references products (id);
alter table products add column if not exists rice_cups numeric;
alter table products add column if not exists unlimited_stock boolean not null default false;
