-- Senior Citizen and PWD discounts are both a flat percentage off, computed
-- identically — one setting covers both rather than tracking them separately.
insert into settings (key, value)
values ('SENIOR_PWD_DISCOUNT_PCT', '20')
on conflict (key) do nothing;
