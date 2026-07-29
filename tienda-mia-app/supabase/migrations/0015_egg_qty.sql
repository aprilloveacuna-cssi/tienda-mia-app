-- Tracks eggs the same way rice_cups tracks rice — how many eggs a single
-- unit of this product represents when sold (e.g. a Silog item = 1, a
-- "double egg" add-on = 2). Purely a reporting tally, same as rice_cups.
alter table products add column if not exists egg_qty numeric;
