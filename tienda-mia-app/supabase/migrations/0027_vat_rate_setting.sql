-- Makes the VAT rate visible and editable in Settings, instead of only
-- living as a hardcoded constant in the code. This is still a national tax
-- rate, not a business preference — the app warns clearly before letting it
-- be changed, since it affects Sales, Reports, and Kitchen calculations
-- everywhere at once.
insert into settings (key, value, description) values
  ('VAT_RATE_PCT', '12', 'National VAT rate. Used two ways: (1) regular sales back out VAT as price x (rate / (100 + rate)); (2) Senior/PWD discounted sales divide by (1 + rate/100) to get the VAT-exclusive price, then apply the discount to that. Changing this affects every VAT and discount figure across Sales, Reports, and Kitchen at once.')
on conflict (key) do nothing;
