-- New setting: how many days before expiration something shows up in
-- Dashboard's Expiry Alerts and gets the amber "attention" color in
-- Inventory's batch cards. Was hardcoded to 15 in both places.
insert into settings (key, value, description) values
  ('EXPIRY_ALERT_DAYS', '15', 'How many days before expiration a batch shows up in Expiry Alerts and gets flagged in Inventory')
on conflict (key) do nothing;

-- Backfill descriptions that were never written when these settings were
-- first added — the app's Settings page already shows this text once it's
-- here, no code change needed for this part.
update settings set description = 'Percent off the VAT-exclusive price for Senior/PWD sales — applied the same way to both, since the math is identical'
where key = 'SENIOR_PWD_DISCOUNT_PCT' and description is null;

update settings set description = 'Estimated pesos it costs to place one purchase order (staff time, processing) — used in Analytics'' EOQ calculation to size how much to order at once'
where key = 'EOQ_ORDERING_COST' and description is null;

update settings set description = 'Yearly cost of holding stock, as a percent of what it''s worth — covers things like spoilage risk and tied-up cash. Used alongside EOQ ordering cost in Analytics'
where key = 'EOQ_HOLDING_COST_PCT' and description is null;
