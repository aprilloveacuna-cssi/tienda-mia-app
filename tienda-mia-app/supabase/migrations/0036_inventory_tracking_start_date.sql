-- Marks the earliest date real batch/inventory data can be trusted from.
-- A sale dated before this (backfilling an old month's report, say) still
-- gets recorded normally for Reports and Analytics, but Sales.jsx skips
-- FIFO consumption and posts no inventory_ledger rows for it at all — see
-- the note on inventoryTrackingStartDate in Sales.jsx for the full
-- reasoning. Defaults to the date given when this was set up; change it in
-- Settings if that's ever wrong.
insert into settings (key, value)
values ('INVENTORY_TRACKING_START_DATE', '2026-07-01')
on conflict (key) do nothing;
