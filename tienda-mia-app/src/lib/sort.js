import { useState } from 'react'

/**
 * Tracks which column a table is sorted by and which direction. Clicking the
 * same header again flips direction; clicking a new header starts ascending.
 */
export function useSort(defaultKey = null, defaultDir = 'asc') {
  const [sortKey, setSortKey] = useState(defaultKey)
  const [sortDir, setSortDir] = useState(defaultDir)

  function toggleSort(key) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  return { sortKey, sortDir, toggleSort }
}

/**
 * Sorts a copy of `rows` by whatever `accessor(row, sortKey)` returns.
 * Numbers sort numerically; everything else sorts as text (case/number aware).
 * Nullish values always sink to the bottom regardless of direction.
 */
/**
 * Sorts a copy of `rows` by whatever `accessor(row, sortKey)` returns.
 * Real numbers sort numerically. Strings that are ENTIRELY numeric once a
 * trailing unit/label is stripped (e.g. "45.00", "24 pcs") also sort
 * numerically — this matters because many table cells display a formatted
 * string (toFixed, "+ unit") rather than a raw number. Anything else sorts
 * as text (case/number aware). Nullish values always sink to the bottom.
 */
function asNumberIfPossible(v) {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const match = v.trim().match(/^-?\d+(\.\d+)?/)
    if (match && match[0].length > 0) {
      // only treat it as numeric if there's nothing but the unit/label after the number
      const rest = v.trim().slice(match[0].length).trim()
      if (rest === '' || /^[a-zA-Z%]+$/.test(rest)) return Number(match[0])
    }
  }
  return null
}

export function sortRows(rows, sortKey, sortDir, accessor) {
  if (!sortKey) return rows
  const sorted = [...rows].sort((a, b) => {
    const av = accessor(a, sortKey)
    const bv = accessor(b, sortKey)
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    const an = asNumberIfPossible(av)
    const bn = asNumberIfPossible(bv)
    if (an !== null && bn !== null) return an - bn
    return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' })
  })
  return sortDir === 'asc' ? sorted : sorted.reverse()
}
