-- Replaces the hardcoded EOQ assumptions in Analytics (₱50/order, 20% holding
-- rate) with real, adjustable settings.
insert into settings (key, value) values ('EOQ_ORDERING_COST', '50') on conflict (key) do nothing;
insert into settings (key, value) values ('EOQ_HOLDING_COST_PCT', '20') on conflict (key) do nothing;
