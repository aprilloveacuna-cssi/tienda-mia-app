-- Senior/PWD discount lines have always charged the right price — VAT
-- backed out of the selling price first, then 20% off that VAT-exclusive
-- amount. What's changing is how the reduction gets recorded: it was one
-- combined discount_amount (VAT-exempt portion + the 20% discount, lumped
-- together); this splits it into two real figures, since BIR/Senior-PWD
-- reporting needs them separately, not combined.
--
-- discount_amount is being redefined going forward to mean only the 20%
-- discount portion. Every place that reads it as "total reduction" (the
-- Discounts figures in Reports.jsx and Kitchen.jsx) needs to sum it with
-- the new vat_exempt_amount instead — handled in those files, not here.
alter table sale_lines add column if not exists vat_exempt_amount numeric(12, 2);

-- Backfill: exact, not approximated, because the original selling price is
-- fully recoverable from what's already stored — old discount_amount was
-- computed as quantity * (selling_price - unit_price), so
-- unit_price + old_discount_amount/quantity gives back the exact original
-- selling_price, regardless of what discount % was used at the time. From
-- there the VAT-exempt/discount split only needs today's VAT_RATE_PCT,
-- which is exact here since it's confirmed to have never changed.
with vat as (
  select value::numeric as pct from settings where key = 'VAT_RATE_PCT'
),
recovered as (
  select
    sl.id,
    sl.quantity,
    sl.unit_price,
    (sl.unit_price + sl.discount_amount / sl.quantity) as recovered_selling_price
  from sale_lines sl
  where sl.is_discounted = true and sl.quantity > 0
)
update sale_lines sl
set
  vat_exempt_amount = round(r.quantity * (r.recovered_selling_price - r.recovered_selling_price / (1 + v.pct / 100)), 2),
  discount_amount = round(r.quantity * (r.recovered_selling_price / (1 + v.pct / 100) - r.unit_price), 2)
from recovered r, vat v
where sl.id = r.id;
