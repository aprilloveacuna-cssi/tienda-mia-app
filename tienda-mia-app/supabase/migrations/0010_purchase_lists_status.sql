-- Purchase Lists were originally hard-deleted with no way back. This adds a
-- status so "delete" becomes an archive (recoverable) by default, with actual
-- permanent deletion as a separate, more deliberate action.
alter table purchase_lists add column if not exists status text not null default 'active' check (status in ('active', 'archived'));
