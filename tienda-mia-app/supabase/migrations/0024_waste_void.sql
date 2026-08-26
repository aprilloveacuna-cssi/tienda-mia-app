-- Lets a waste record be voided (e.g. management ended up buying expired
-- stock instead of it actually being discarded) without editing or deleting
-- the original record — same pattern as voiding a sale or purchase.
alter table waste add column if not exists status text not null default 'posted' check (status in ('posted', 'voided'));
