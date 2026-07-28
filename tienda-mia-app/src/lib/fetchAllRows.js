import { supabase } from './supabaseClient'

/**
 * Supabase (via PostgREST) caps a single request at 1000 rows by default —
 * past that, rows are silently dropped, not errored. That's invisible until
 * a table crosses the threshold, at which point things that depend on
 * "every row" (product matching, reports, analytics) start quietly missing
 * data with no error anywhere. This fetches every page until none are left,
 * so nothing above 1000 rows ever goes missing again.
 *
 * Usage mirrors a normal query, just call it with the table/columns/order
 * instead of chaining .select() yourself:
 *   const { data, error } = await fetchAllRows('products', 'id, name, barcode', 'name')
 */
export async function fetchAllRows(table, columns = '*', orderBy = null, options = {}) {
  const pageSize = 1000
  let allRows = []
  let from = 0
  // Most tables use a standard `id` primary key — a few (cache/snapshot
  // tables keyed by what they summarize, like inventory_cache by product_id)
  // don't, so the tiebreaker column is overridable via options.tiebreaker.
  const tiebreaker = options.tiebreaker ?? 'id'

  while (true) {
    let query = supabase.from(table).select(columns)
    if (orderBy) query = query.order(orderBy, { ascending: options.ascending ?? true })
    // Always add a stable secondary sort. Without this, rows that tie on the
    // primary sort column (e.g. duplicate product names) can be ordered
    // inconsistently between successive paged requests — Postgres is free
    // to break ties differently each time — which silently skips or
    // duplicates rows sitting right at a page boundary.
    query = query.order(tiebreaker, { ascending: true })
    query = query.range(from, from + pageSize - 1)

    const { data, error } = await query
    if (error) return { data: null, error }

    allRows = allRows.concat(data ?? [])
    if (!data || data.length < pageSize) break
    from += pageSize
  }

  return { data: allRows, error: null }
}
