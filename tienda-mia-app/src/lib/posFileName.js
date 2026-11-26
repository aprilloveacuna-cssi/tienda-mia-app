// Reads the sale date and POS terminal out of a POS report's file name.
// Kept in its own file so the report parser itself is left alone.

// A real calendar date (rejects Feb 31, month 13, years that cannot be a POS export).
function toIsoDate(y, m, d) {
  const year = Number(y)
  const month = Number(m)
  const day = Number(d)
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null
  const dt = new Date(Date.UTC(year, month - 1, day))
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Reads the date and POS terminal out of a POS report's file name.
 *
 * dateConfidence says how far to trust the date:
 *   'exact'   — a format with only one sensible reading: MMDDYYYY (the POS's own
 *               naming, e.g. SOLD_ITEM_REPORT_11122026_POS1.xls), YYYYMMDD, or
 *               year-first like 2026-11-12. These go straight into an import.
 *   'guessed' — a format that could be read two ways (11-12-2026 might be
 *               November 12th or 11 December) or has a two-digit year. The Sales
 *               page asks for confirmation instead of trusting it.
 *   null      — no date found; saleDate is null.
 */
export function extractDateAndTerminalFromFilename(filename) {
  const terminalMatch = filename.match(/POS\s*-?\s*(\d+)/i)
  const posTerminal = terminalMatch ? terminalMatch[1] : null

  let saleDate = null
  let dateConfidence = null

  // 1. MMDDYYYY run together — what the POS itself produces.
  let m = filename.match(/(\d{2})(\d{2})(\d{4})/)
  if (m) {
    saleDate = toIsoDate(m[3], m[1], m[2])
    if (saleDate) dateConfidence = 'exact'
  }

  // 2. YYYYMMDD run together.
  if (!saleDate) {
    m = filename.match(/(?:^|\D)(20\d{2})(\d{2})(\d{2})(?:\D|$)/)
    if (m) {
      saleDate = toIsoDate(m[1], m[2], m[3])
      if (saleDate) dateConfidence = 'exact'
    }
  }

  // 3. Year first with separators: 2026-11-12, 2026_11_12, 2026.11.12
  if (!saleDate) {
    m = filename.match(/(?:^|\D)(20\d{2})[-_. ](\d{1,2})[-_. ](\d{1,2})(?:\D|$)/)
    if (m) {
      saleDate = toIsoDate(m[1], m[2], m[3])
      if (saleDate) dateConfidence = 'exact'
    }
  }

  // 4. Month-first (or day-first) with separators and a four-digit year: 11-12-2026.
  if (!saleDate) {
    m = filename.match(/(?:^|\D)(\d{1,2})[-_. ](\d{1,2})[-_. ](20\d{2})(?:\D|$)/)
    if (m) {
      const first = Number(m[1])
      const second = Number(m[2])
      // Month-day-year, like the POS; only when the first number cannot be a month is it read day-first.
      saleDate = first <= 12 ? toIsoDate(m[3], m[1], m[2]) : toIsoDate(m[3], m[2], m[1])
      if (saleDate && !(first <= 12 || second <= 12)) saleDate = null
      if (saleDate) dateConfidence = 'guessed'
    }
  }

  // 5. Two-digit year: 11-12-26, 11_12_26
  if (!saleDate) {
    m = filename.match(/(?:^|\D)(\d{1,2})[-_.](\d{1,2})[-_.](\d{2})(?:\D|$)/)
    if (m && Number(m[3]) >= 20 && Number(m[3]) <= 60) {
      saleDate = toIsoDate(2000 + Number(m[3]), m[1], m[2])
      if (saleDate) dateConfidence = 'guessed'
    }
  }

  return { saleDate, posTerminal, dateConfidence }
}
