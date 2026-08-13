-- Lets one product have more than one barcode (e.g. a supplier occasionally
-- prints a different code on the same item). products.barcode remains the
-- "primary" barcode shown everywhere; this table holds every additional one.
create table if not exists product_barcodes (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products (id) on delete cascade,
  barcode text not null unique,
  created_at timestamptz not null default now()
);

create index if not exists idx_product_barcodes_product on product_barcodes (product_id);

-- Every barcode that already exists on a product becomes its first entry
-- here too, so barcode-matching logic can check one place consistently
-- without missing anything already in use.
insert into product_barcodes (product_id, barcode)
select id, barcode from products
where barcode is not null and barcode <> ''
on conflict (barcode) do nothing;

alter table product_barcodes enable row level security;
drop policy if exists allow_all_product_barcodes on product_barcodes;
create policy allow_all_product_barcodes on product_barcodes for all using (true) with check (true);
