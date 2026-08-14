-- Optional expiration date per counted line — mainly for kickstarting
-- inventory after a wipe, where every item's first count is a real starting
-- batch with a real shelf-life, not just a quantity correction.
alter table physical_count_lines add column if not exists expiration_date date;
