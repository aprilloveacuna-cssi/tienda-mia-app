-- Tracks which sale lines were Senior/PWD discounted and by how much, so
-- daily remittance can be reconciled against gross vs actual collected amounts.
alter table sale_lines add column if not exists is_discounted boolean not null default false;
alter table sale_lines add column if not exists discount_amount numeric not null default 0;
