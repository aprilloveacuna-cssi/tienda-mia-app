-- Fixes a pre-existing bug: every Senior/PWD-discounted sale_line, going
-- back to the start of this app's history, had the exact same flat
-- discount_amount and vat_exempt_amount (₱4.64 / ₱5.36) regardless of the
-- product's actual price — not something migration 0037 introduced, since
-- it already predates that migration. 0037's backfill only inherited this
-- problem, because it worked backward from the old discount_amount, which
-- was never correctly computed in the first place.
--
-- unit_price on these lines is trustworthy — run forward through the real
-- formula, it consistently reconstructs to clean, sensible sticker prices
-- (verified against many real rows before writing this). So this recomputes
-- forward from unit_price and SENIOR_PWD_DISCOUNT_PCT instead of relying on
-- the old, evidently-wrong discount_amount:
--   unit_price = vatExclusivePrice * (1 - discountPct/100)
--   => vatExclusivePrice = unit_price / (1 - discountPct/100)
-- from there, vat_exempt_amount and discount_amount follow the same way
-- they do going forward in Sales.jsx.
--
-- This assumes SENIOR_PWD_DISCOUNT_PCT has always been the same value it is
-- today — confirmed before running this.
with vat as (
  select value::numeric as pct from settings where key = 'VAT_RATE_PCT'
),
discount_setting as (
  select value::numeric as pct from settings where key = 'SENIOR_PWD_DISCOUNT_PCT'
),
recomputed as (
  select
    sl.id,
    sl.quantity,
    sl.unit_price,
    (sl.unit_price / (1 - d.pct / 100)) as vat_exclusive_price
  from sale_lines sl, discount_setting d
  where sl.is_discounted = true and d.pct < 100
)
update sale_lines sl
set
  vat_exempt_amount = round(r.quantity * r.vat_exclusive_price * v.pct / 100, 2),
  discount_amount = round(r.quantity * (r.vat_exclusive_price - r.unit_price), 2)
from recomputed r, vat v
where sl.id = r.id;
