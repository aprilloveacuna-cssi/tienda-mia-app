import * as XLSX from 'xlsx'

/**
 * Parses the "Items Sold" Crystal Reports export used by both POS
 * terminals. The report has several rows of business/address boilerplate
 * before the real header, then data rows (barcode, description, qty,
 * amount) separated by blank spacer rows, ending in a TOTAL row.
 *
 * Column positions are located by header label, not hardcoded position —
 * except for one confirmed quirk: the QTY and AMOUNT header labels sit one
 * column to the right of where their actual data lives in every row below.
 * This was verified directly against real exports from both terminals, not
 * assumed. CODE isn't affected the same way, so it's read at its own
 * header's column directly.
 *
 * Because that offset is a specific, verified quirk rather than a general
 * rule, this also cross-checks its own output against the report's printed
 * TOTAL row (search for any number in that row matching the computed sums,
 * not a specific column) — if it doesn't match, the caller gets a clear
 * warning instead of a silently wrong import.
 */
export function parsePosReportWorkbook(arrayBuffer) {
  const workbook = XLSX.read(arrayBuffer, { type: 'array' })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  const rows2d = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })

  let headerRowIdx = -1
  let codeCol = -1
  let qtyHeaderCol = -1
  let amountCol = -1

  for (let r = 0; r < rows2d.length; r++) {
    const row = rows2d[r] ?? []
    let foundCode = -1
    let foundQty = -1
    let foundAmount = -1
    for (let c = 0; c < row.length; c++) {
      const cell = String(row[c] ?? '').trim().toUpperCase()
      if (cell === 'CODE') foundCode = c
      if (cell.includes('QTY')) foundQty = c
      if (cell === 'AMOUNT') foundAmount = c
    }
    if (foundCode >= 0 && foundAmount >= 0) {
      headerRowIdx = r
      codeCol = foundCode
      qtyHeaderCol = foundQty
      amountCol = foundAmount
      break
    }
  }

  if (headerRowIdx === -1) {
    return {
      error:
        'Could not find the expected CODE and AMOUNT columns in this file — it may not be the same report layout this was built for.',
    }
  }

  const qtyDataCol = qtyHeaderCol >= 0 ? qtyHeaderCol - 1 : -1
  const amountDataCol = amountCol - 1

  const dataRows = []
  const numbersInTotalRow = []
  let foundTotalRow = false

  for (let r = headerRowIdx + 1; r < rows2d.length; r++) {
    const row = rows2d[r] ?? []
    const isTotalRow = row.some((v) => String(v ?? '').trim().toUpperCase().startsWith('TOTAL'))
    if (isTotalRow) {
      foundTotalRow = true
      for (const v of row) {
        if (v === '' || v === null || v === undefined) continue
        const n = Number(v)
        if (!isNaN(n)) numbersInTotalRow.push(n)
      }
      continue
    }

    const codeVal = row[codeCol]
    if (codeVal === undefined || codeVal === null || String(codeVal).trim() === '') continue

    const qtyVal = qtyDataCol >= 0 ? row[qtyDataCol] : undefined
    const amountVal = row[amountDataCol]
    if (qtyVal === undefined || qtyVal === null || qtyVal === '' || isNaN(Number(qtyVal))) continue
    if (amountVal === undefined || amountVal === null || amountVal === '' || isNaN(Number(amountVal))) continue

    dataRows.push({
      barcode: String(codeVal).trim(),
      qty: Number(qtyVal),
      amount: Number(amountVal),
    })
  }

  const computedQtySum = dataRows.reduce((s, r) => s + r.qty, 0)
  const computedAmountSum = dataRows.reduce((s, r) => s + r.amount, 0)

  let validationWarning = null
  if (foundTotalRow) {
    const qtyMatches = numbersInTotalRow.some((n) => Math.abs(n - computedQtySum) < 0.01)
    const amountMatches = numbersInTotalRow.some((n) => Math.abs(n - computedAmountSum) < 0.01)
    if (!qtyMatches || !amountMatches) {
      validationWarning = `Parsed ${dataRows.length} lines totaling ${computedQtySum} units / ${computedAmountSum.toFixed(2)}, but that doesn't match this report's own printed total — please review carefully before importing.`
    }
  } else {
    validationWarning = `Parsed ${dataRows.length} lines totaling ${computedQtySum} units / ${computedAmountSum.toFixed(2)} — couldn't find a TOTAL row in this file to cross-check against, so this hasn't been independently verified.`
  }

  return { dataRows, computedQtySum, computedAmountSum, validationWarning }
}

// Filenames follow SOLD_ITEM(S)_REPORT_MMDDYYYY_POS<n>.xls — pulls the date
// and terminal out so the person doesn't have to retype them for every
// daily import. Returns nulls if the filename doesn't match; the caller
// should leave the existing form values alone in that case, not clear them.
export function extractDateAndTerminalFromFilename(filename) {
  const dateMatch = filename.match(/(\d{2})(\d{2})(\d{4})/)
  const terminalMatch = filename.match(/POS\s*-?\s*(\d+)/i)

  let saleDate = null
  if (dateMatch) {
    const [, mm, dd, yyyy] = dateMatch
    const month = Number(mm)
    const day = Number(dd)
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      saleDate = `${yyyy}-${mm}-${dd}`
    }
  }

  const posTerminal = terminalMatch ? terminalMatch[1] : null

  return { saleDate, posTerminal }
}
