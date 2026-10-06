import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Trash2, Check, Ban, AlertTriangle, Upload, FileDown, Pencil } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { fetchAllRows } from '../lib/fetchAllRows'
import SlidePanel from '../components/SlidePanel'
import StatusChip from '../components/StatusChip'
import ProductPicker from '../components/ProductPicker'
import SortableTh from '../components/SortableTh'
import SearchBar from '../components/SearchBar'
import { useSort, sortRows } from '../lib/sort'
import { parseCsv, normalizeHeader, downloadFile } from '../lib/csv'
import { normalizeSearchText } from '../lib/search'
import { parsePosReportWorkbook, extractDateAndTerminalFromFilename } from '../lib/posReportParser'
import { resolveProductByCode } from '../lib/productMatch'

const EMPTY_LINE_FORM = { product_id: '', quantity: '', unit_price: '' }

function today() {
  return new Date().toISOString().slice(0, 10)
}

const SALE_LINE_HEADER_ALIASES = {
  barcode: 'barcode', sku: 'sku',
  quantity: 'quantity', qty: 'quantity',
  unitprice: 'unit_price', price: 'unit_price',
  totalprice: 'total_price', total: 'total_price', saletotal: 'total_price',
  description: 'description', itemdescription: 'description', productdescription: 'description',
}

// Same fallback-to-free-text behavior as Products.jsx's own SelectOrText —
// a dropdown of known values once any exist, plain text until then, so
// quick-add never becomes a second, inconsistent way to spell a category
// or unit that already exists under a different casing/spelling.
function SelectOrText({ value, onChange, options, placeholder }) {
  if (options && options.length > 0) {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} className="input">
        <option value="">{placeholder || 'Select…'}</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    )
  }
  return <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="input" />
}

function statusTone(status) {
  return status === 'voided' ? 'critical' : 'ok'
}

// Builds the CSV text for a set of sale lines — one row per line plus a
// TOTAL row (voided sales are listed but never counted in the totals). Shared
// by the date-range download on the Sales list and the single-sale download
// in the detail panel, so both always produce the same columns and the same
// numbers. Each row is { l: saleLine, sale: saleHeader }; callers decide the
// row order.
function buildSalesCsv(rows) {
  const q = (v) => {
    const s = v == null ? '' : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const money = (n) => Number(n || 0).toFixed(2)

  const header = [
    'Date', 'Sale #', 'Terminal', 'Cashier', 'Status', 'Barcode', 'SKU', 'Product', 'Category', 'Qty', 'Unit',
    'Unit Price', 'Line Total', 'Type', 'Discount (SC/PWD)', 'Less VAT', 'B1T1 Giveaway', 'FIFO Cost', 'Profit', 'Corrected After Posting',
  ]
  const totals = { qty: 0, lineTotal: 0, discount: 0, lessVat: 0, b1t1: 0, cost: 0, profit: 0 }
  const out = [header.map(q).join(',')]

  for (const { l, sale } of rows) {
    const qty = Number(l.quantity)
    const lineTotal = qty * Number(l.unit_price)
    // Same guard as the reports: these two columns are only meaningful on
    // a line actually flagged as Senior/PWD (or B1T1 for the giveaway).
    const discount = l.is_discounted ? Number(l.discount_amount ?? 0) : 0
    const lessVat = l.is_discounted ? Number(l.vat_exempt_amount ?? 0) : 0
    const b1t1 = l.is_b1t1 ? Number(l.discount_amount ?? 0) : 0
    const type = l.is_discounted ? 'Senior/PWD' : l.is_b1t1 ? 'B1T1' : 'Regular'
    const counted = sale.status !== 'voided'
    if (counted) {
      totals.qty += qty
      totals.lineTotal += lineTotal
      totals.discount += discount
      totals.lessVat += lessVat
      totals.b1t1 += b1t1
      totals.cost += Number(l.fifo_cost ?? 0)
      totals.profit += Number(l.gross_profit ?? 0)
    }
    out.push(
      [
        String(sale.sale_date).slice(0, 10), sale.sale_number, sale.pos_terminal ?? '', sale.cashier ?? '', sale.status,
        l.product?.barcode ?? '', l.product?.sku ?? '', l.product?.name ?? '', l.product?.category ?? '',
        qty, l.product?.unit ?? '', money(l.unit_price), money(lineTotal), type, money(discount), money(lessVat), money(b1t1),
        money(l.fifo_cost), money(l.gross_profit), l.price_edited_at || l.discounted_qty_edited_at ? 'Yes' : '',
      ]
        .map(q)
        .join(',')
    )
  }
  out.push('')
  out.push(
    [
      'TOTAL (voided excluded)', '', '', '', '', '', '', '', '', totals.qty, '', '', money(totals.lineTotal), '',
      money(totals.discount), money(totals.lessVat), money(totals.b1t1), money(totals.cost), money(totals.profit), '',
    ]
      .map(q)
      .join(',')
  )
  return out.join('\r\n')
}

// Takes the first `n` units out of a FIFO consumption list, splitting a batch
// entry in two if the cut falls inside it. Returns [taken, rest].
function takeUnits(consumption, n) {
  const taken = []
  const rest = []
  let need = n
  for (const c of consumption) {
    if (need <= 1e-9) {
      rest.push(c)
    } else if (c.qty <= need + 1e-9) {
      taken.push(c)
      need -= c.qty
    } else {
      taken.push({ ...c, qty: need })
      rest.push({ ...c, qty: c.qty - need })
      need = 0
    }
  }
  return [taken, rest]
}

// Splits `splitQty` units off a line being built and gives them a different
// price, as their own line. Nothing is posted yet, so stock can be divided
// exactly: the units run in order — real batch units first (in FIFO order),
// then any open/oversold tail — the original line keeps the first
// (quantity − splitQty) of them and the new line takes the rest. Total
// quantity, total batch consumption, and total cost are unchanged.
//
// If the original was a Senior/PWD line, it keeps its status (discount and
// VAT-exempt scale down with its quantity) and the split-off units become a
// plain line at the new price — a discounted split has its own tool.
// Returns [remainingLine, splitLine].
function splitLineAtPrice(line, splitQty, newPrice) {
  const total = Number(line.quantity)
  const remainingQty = total - splitQty
  const consumption = line.consumption ?? []
  const consumedTotal = consumption.reduce((sum, c) => sum + c.qty, 0)
  const consumptionCost = consumption.reduce((sum, c) => sum + c.qty * c.unit_cost, 0)

  const [remainTaken, splitTaken] = takeUnits(consumption, Math.min(remainingQty, consumedTotal))

  // Cost of units not covered by a batch (open/oversold, or a backfilled
  // line with no batches at all) is whatever the line already carried beyond
  // its batch cost, spread evenly over those units.
  const uncoveredUnits = Math.max(0, total - consumedTotal)
  const uncoveredCostPerUnit = uncoveredUnits > 1e-9 ? (Number(line.fifo_cost ?? 0) - consumptionCost) / uncoveredUnits : 0
  const remainingUncovered = Math.max(0, remainingQty - consumedTotal)
  const remainingCost =
    remainTaken.reduce((sum, c) => sum + c.qty * c.unit_cost, 0) + remainingUncovered * uncoveredCostPerUnit
  const splitCost = Number(line.fifo_cost ?? 0) - remainingCost

  // Open/oversold quantity as the line itself declared it (the tail units).
  const declaredOpen = line.openQty
  const remainingOpen =
    declaredOpen === undefined ? undefined : Math.max(0, remainingQty - (total - declaredOpen))
  const splitOpen = declaredOpen === undefined ? undefined : declaredOpen - remainingOpen

  const ratio = remainingQty / total
  const remainingLine = {
    ...line,
    quantity: remainingQty,
    line_total: remainingQty * Number(line.unit_price),
    consumption: remainTaken,
    fifo_cost: remainingCost,
    gross_profit: remainingQty * Number(line.unit_price) - remainingCost,
    ...(remainingOpen === undefined ? {} : { openQty: remainingOpen, isOversold: Boolean(line.isOversold) && remainingOpen > 0 }),
    ...(line.is_discounted
      ? {
          discount_amount: Number(line.discount_amount ?? 0) * ratio,
          vat_exempt_amount: line.vat_exempt_amount == null ? line.vat_exempt_amount : Number(line.vat_exempt_amount) * ratio,
        }
      : {}),
  }
  const splitLine = {
    ...line,
    tempId: crypto.randomUUID(),
    quantity: splitQty,
    unit_price: newPrice,
    line_total: splitQty * newPrice,
    consumption: splitTaken,
    fifo_cost: splitCost,
    gross_profit: splitQty * newPrice - splitCost,
    is_discounted: false,
    discount_amount: 0,
    vat_exempt_amount: null,
    ...(splitOpen === undefined ? {} : { openQty: splitOpen, isOversold: Boolean(line.isOversold) && splitOpen > 0 }),
    oversoldNote: null,
    splitOff: true,
  }
  return [remainingLine, splitLine]
}

export default function Sales() {
  const [sales, setSales] = useState([])

  const { sortKey: saleSortKey, sortDir: saleSortDir, toggleSort: toggleSaleSort } = useSort('sale_date', 'desc')
  const { sortKey: lineSortKey, sortDir: lineSortDir, toggleSort: toggleLineSort } = useSort(null)
  function saleSortAccessor(row, key) {
    if (key === 'total_amount') return Number(row.total_amount ?? 0)
    if (key === 'sale_date') return new Date(row.sale_date).getTime()
    return row[key]
  }
  const sortedSales = sortRows(sales, saleSortKey, saleSortDir, saleSortAccessor)

  // Ticking sales in the list to void several at once.
  const [selectedSaleIds, setSelectedSaleIds] = useState([])
  const [bulkVoidBusy, setBulkVoidBusy] = useState(false)
  const [bulkVoidMsg, setBulkVoidMsg] = useState('')
  const [search, setSearch] = useState('')
  const searchedSales = search.trim()
    ? sortedSales.filter((s) => {
        const q = normalizeSearchText(search)
        return (
          normalizeSearchText(s.sale_number).includes(q) ||
          normalizeSearchText(s.pos_terminal).includes(q) ||
          normalizeSearchText(s.cashier).includes(q)
        )
      })
    : sortedSales

  // Selection only ever counts sales that are visible right now (so a search
  // can't leave hidden, still-ticked sales to be voided by surprise) and not
  // already voided.
  const selectedSaleIdSet = new Set(selectedSaleIds)
  const votableSales = searchedSales.filter((s) => s.status === 'posted')
  const selectedVisibleSales = votableSales.filter((s) => selectedSaleIdSet.has(s.id))
  const allVotableSelected = votableSales.length > 0 && selectedVisibleSales.length === votableSales.length

  function toggleSaleSelected(id) {
    setSelectedSaleIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
  }

  function toggleAllVotable() {
    const visibleIds = new Set(votableSales.map((s) => s.id))
    setSelectedSaleIds((cur) =>
      allVotableSelected ? cur.filter((id) => !visibleIds.has(id)) : [...new Set([...cur, ...visibleIds])]
    )
  }
  const [products, setProducts] = useState([])
  const [extraBarcodeMap, setExtraBarcodeMap] = useState({}) // cleanedBarcode -> product_id, for additional barcodes beyond the primary one
  const activeProducts = products.filter((p) => p.status === 'active')
  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState('')

  const [panelOpen, setPanelOpen] = useState(false)
  const [mode, setMode] = useState('new') // 'new' | 'view'
  const [pendingLines, setPendingLines] = useState([]) // not yet saved to DB
  const [viewedSale, setViewedSale] = useState(null)
  const [viewedLines, setViewedLines] = useState([])
  // Editing a posted line's price — price only, quantity/inventory/FIFO
  // cost are never touched here.
  const [editingLineId, setEditingLineId] = useState(null)
  const [editPriceDraft, setEditPriceDraft] = useState('')
  const [editReasonDraft, setEditReasonDraft] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  // Moving quantity between a discounted line and its regular-price
  // sibling — a separate action from the price edit above, since it
  // touches two rows (or creates/removes one) instead of one.
  const [editingDiscountQtyLineId, setEditingDiscountQtyLineId] = useState(null)
  const [editDiscountQtyDraft, setEditDiscountQtyDraft] = useState('')
  const [editDiscountQtyReason, setEditDiscountQtyReason] = useState('')
  const [editDiscountQtySaving, setEditDiscountQtySaving] = useState(false)
  // Splitting off some quantity of a line at a different, arbitrary price —
  // distinct from Edit discounted qty (which specifically moves quantity
  // between the Senior/PWD-formula price and the regular price). This
  // always creates a plain (not discounted, not B1T1) new line for the
  // split-off portion, since a discounted split has its own tool already.
  const [splitPriceLineId, setSplitPriceLineId] = useState(null)
  const [splitQtyDraft, setSplitQtyDraft] = useState('')
  const [splitPriceDraft, setSplitPriceDraft] = useState('')
  const [splitReasonDraft, setSplitReasonDraft] = useState('')
  const [splitSaving, setSplitSaving] = useState(false)
  // Download of sales detail for a date or date range — one row per sale line.
  const [exportFrom, setExportFrom] = useState(today())
  const [exportTo, setExportTo] = useState(today())
  const [exportIncludeVoided, setExportIncludeVoided] = useState(false)
  const [exportBusy, setExportBusy] = useState(false)
  const [exportMsg, setExportMsg] = useState('')
  // Set while a day is being reimported: { date, terminal, saleNumber }. Locks
  // the new-sale form to that day and makes the POS file import refuse a file
  // for any other day or terminal.
  const [reimportContext, setReimportContext] = useState(null)
  // Splitting a line of the sale being built (imported or typed) at a
  // different price — the form for it opens under the line.
  const [splitPendingId, setSplitPendingId] = useState(null)
  const [splitPendingQty, setSplitPendingQty] = useState('')
  const [splitPendingPrice, setSplitPendingPrice] = useState('')
  useEffect(() => {
    if (!panelOpen) setReimportContext(null)
  }, [panelOpen])
  const [headerForm, setHeaderForm] = useState({ pos_terminal: '', cashier: '', sale_date: today() })

  const importFileInputRef = useRef(null)
  const posReportFileInputRef = useRef(null)
  const [posReportValidationWarning, setPosReportValidationWarning] = useState(null)
  // When selected files span more than one date, each date becomes its own
  // sale — this holds the remaining ones, processed one at a time as each
  // prior sale gets completed.
  const [dateImportQueue, setDateImportQueue] = useState([])
  const [dateImportQueueTotal, setDateImportQueueTotal] = useState(0)
  const [importPanelOpen, setImportPanelOpen] = useState(false)
  const [importPreviewValid, setImportPreviewValid] = useState([])
  const [importPreviewSkipped, setImportPreviewSkipped] = useState([])
  // Which skipped row (by rowNum) currently has its quick-add form open,
  // plus that form's draft values.
  const [quickAddRowNum, setQuickAddRowNum] = useState(null)
  const [quickAddForm, setQuickAddForm] = useState({ name: '', unit: '', category: '', selling_price: '', current_cost: '' })
  // Same known-values dropdown (falling back to free text until any exist)
  // that Products.jsx already uses for these two fields — quick-add
  // shouldn't be a second, inconsistent way to enter a brand-new category
  // or unit spelling.
  const [categoryOptions, setCategoryOptions] = useState([])
  const [unitOptions, setUnitOptions] = useState([])
  const [quickAddSaving, setQuickAddSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importParsing, setImportParsing] = useState(false)
  const [lineForm, setLineForm] = useState(EMPTY_LINE_FORM)
  const [lineWarning, setLineWarning] = useState('')

  const [quickReceiveOpen, setQuickReceiveOpen] = useState(false)
  const [quickReceiveForm, setQuickReceiveForm] = useState({ quantity: '', unit_cost: '', expiration_date: '' })
  const [quickReceiveSaving, setQuickReceiveSaving] = useState(false)
  const [quickReceiveError, setQuickReceiveError] = useState('')
  const [saving, setSaving] = useState(false)
  const [discountPct, setDiscountPct] = useState(20)
  const [vatRatePct, setVatRatePct] = useState(12)
  // Real batch/inventory tracking only goes back this far — a sale dated
  // before it (backfilling an old month's report, say) still gets recorded
  // normally for revenue/Analytics/Reports, but skips FIFO consumption and
  // posts no inventory_ledger rows at all, since there's no real stock data
  // from back then to draw from or affect.
  const [inventoryTrackingStartDate, setInventoryTrackingStartDate] = useState('')
  const isBackfillSale = Boolean(
    headerForm.sale_date && inventoryTrackingStartDate && headerForm.sale_date < inventoryTrackingStartDate
  )

  // Manual add-line price mismatch resolution
  const [priceMismatch, setPriceMismatch] = useState(null) // { recordedPrice, givenPrice }
  const [discountMode, setDiscountMode] = useState(false)
  const [discountQtyDraft, setDiscountQtyDraft] = useState('')

  // Buy 1 Take 1 — a separate mode from the Senior/PWD discount flow above,
  // since it isn't triggered by a price mismatch: the cashier picks it
  // deliberately, usually to move near-expiry stock. See migration 0032 for
  // why this stays off is_discounted.
  const [b1t1Mode, setB1t1Mode] = useState(false)
  const [b1t1PriceDraft, setB1t1PriceDraft] = useState('')

  // Bulk import price mismatch resolution
  const [importMismatches, setImportMismatches] = useState([])

  async function loadSales() {
    setLoading(true)
    setErrorMsg('')
    const { data, error } = await supabase
      .from('sales')
      .select('*')
      .order('sale_date', { ascending: false })
    if (error) {
      setErrorMsg('Could not reach Supabase. Check your .env values and that migrations have run.')
    } else {
      setSales(data ?? [])
    }
    setLoading(false)
  }

  // Downloads every sale line for the chosen date(s) as a CSV — one row per
  // line, with a totals row at the bottom, so a single day can be checked
  // straight against a terminal's Z-reading (the Line Total sum is the
  // Z-read's DAILY SALES). Voided sales are left out by default, same as the
  // Daily POS Summary and the Z-read itself.
  //
  // Dates follow the same convention as Reports.jsx: the calendar date of
  // sale_date as stored (first 10 characters), not shifted to local time.
  async function downloadSalesExport() {
    if (!exportFrom || !exportTo || exportFrom > exportTo) {
      setExportMsg('Pick a valid date range — "From" can\'t be after "To".')
      return
    }
    setExportBusy(true)
    setExportMsg('')

    // PostgREST silently stops at 1000 rows per request, so everything here
    // is paged — same reason fetchAllRows exists.
    async function fetchPaged(buildQuery) {
      const pageSize = 1000
      let all = []
      let from = 0
      while (true) {
        const { data, error } = await buildQuery().range(from, from + pageSize - 1)
        if (error) throw error
        all = all.concat(data ?? [])
        if (!data || data.length < pageSize) break
        from += pageSize
      }
      return all
    }

    try {
      const startIso = `${exportFrom}T00:00:00Z`
      const endExclusive = new Date(`${exportTo}T00:00:00Z`)
      endExclusive.setUTCDate(endExclusive.getUTCDate() + 1)
      const endIso = endExclusive.toISOString()

      const salesInRange = await fetchPaged(() =>
        supabase
          .from('sales')
          .select('id, sale_number, sale_date, pos_terminal, cashier, status')
          .gte('sale_date', startIso)
          .lt('sale_date', endIso)
          .order('sale_date', { ascending: true })
          .order('id', { ascending: true })
      )
      const included = salesInRange.filter((s) => exportIncludeVoided || s.status !== 'voided')
      if (included.length === 0) {
        setExportMsg(
          `No ${exportIncludeVoided ? '' : 'non-voided '}sales found for ${exportFrom === exportTo ? exportFrom : `${exportFrom} to ${exportTo}`}.`
        )
        setExportBusy(false)
        return
      }

      const saleById = Object.fromEntries(included.map((s) => [s.id, s]))
      const ids = included.map((s) => s.id)
      let lines = []
      for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50)
        const chunkLines = await fetchPaged(() =>
          supabase
            .from('sale_lines')
            .select('*, product:products(name, sku, barcode, unit, category)')
            .in('sale_id', chunk)
            .order('id', { ascending: true })
        )
        lines = lines.concat(chunkLines)
      }

      const rows = lines
        .map((l) => ({ l, sale: saleById[l.sale_id] }))
        .filter((r) => r.sale)
        .sort((a, b) => {
          const ad = String(a.sale.sale_date)
          const bd = String(b.sale.sale_date)
          if (ad !== bd) return ad < bd ? -1 : 1
          const an = String(a.sale.pos_terminal ?? '')
          const bn = String(b.sale.pos_terminal ?? '')
          if (an !== bn) return an.localeCompare(bn, undefined, { numeric: true })
          const sn = String(a.sale.sale_number).localeCompare(String(b.sale.sale_number), undefined, { numeric: true })
          if (sn !== 0) return sn
          return String(a.l.product?.name ?? '').localeCompare(String(b.l.product?.name ?? ''))
        })

      const csv = buildSalesCsv(rows)

      const fileName = exportFrom === exportTo ? `sales_${exportFrom}.csv` : `sales_${exportFrom}_to_${exportTo}.csv`
      // BOM so Excel opens it as UTF-8 instead of guessing an encoding.
      downloadFile(fileName, '\uFEFF' + csv, 'text/csv;charset=utf-8;')
      setExportMsg(`Downloaded ${rows.length} line${rows.length === 1 ? '' : 's'} from ${included.length} sale${included.length === 1 ? '' : 's'}.`)
    } catch (err) {
      setExportMsg(`Could not download: ${err.message ?? err}`)
    }
    setExportBusy(false)
  }

  async function loadProducts() {
    const { data, error } = await fetchAllRows(
      'products',
      'id, sku, name, unit, selling_price, current_cost, barcode, status, business_unit, category, unlimited_stock, pairs_with_product_id',
      'name'
    )
    if (!error) setProducts(data ?? [])
  }

  async function loadDiscountSetting() {
    const { data } = await supabase.from('settings').select('value').eq('key', 'SENIOR_PWD_DISCOUNT_PCT').maybeSingle()
    if (data) setDiscountPct(Number(data.value))
  }

  async function loadVatRateSetting() {
    const { data } = await supabase.from('settings').select('value').eq('key', 'VAT_RATE_PCT').maybeSingle()
    if (data) setVatRatePct(Number(data.value))
  }

  async function loadInventoryTrackingStartDate() {
    const { data } = await supabase.from('settings').select('value').eq('key', 'INVENTORY_TRACKING_START_DATE').maybeSingle()
    if (data) setInventoryTrackingStartDate(data.value)
  }

  async function loadQuickAddLists() {
    const { data } = await supabase.from('lists').select('list_type, value').eq('active', true).order('value')
    if (!data) return
    setCategoryOptions(data.filter((r) => r.list_type === 'Category').map((r) => r.value))
    setUnitOptions(data.filter((r) => r.list_type === 'Unit').map((r) => r.value))
  }

  async function loadExtraBarcodes() {
    const { data, error } = await fetchAllRows('product_barcodes', 'product_id, barcode')
    if (error) {
      setErrorMsg(`Could not load additional barcodes — imports won't match them until this is fixed: ${error.message}`)
      return
    }
    const map = {}
    for (const row of data ?? []) {
      const cleaned = (row.barcode ?? '')
        .normalize('NFKC')
        // eslint-disable-next-line no-misleading-character-class -- intentional list of individual invisible chars, not a ZWJ sequence
        .replace(/[\s\u200B\u200C\u200D\u2060\uFEFF\u00AD]/g, '')
        .toUpperCase()
      map[cleaned] = row.product_id
    }
    setExtraBarcodeMap(map)
  }

  useEffect(() => {
    loadSales()
    loadProducts()
    loadDiscountSetting()
    loadVatRateSetting()
    loadInventoryTrackingStartDate()
    loadQuickAddLists()
    loadExtraBarcodes()
  }, [])

  function openNew() {
    openNewPrefilled({ pos_terminal: '', cashier: '', sale_date: today() }, null)
  }

  function openNewPrefilled(header, reimport) {
    setMode('new')
    setReimportContext(reimport)
    setHeaderForm(header)
    setPendingLines([])
    setLineForm(EMPTY_LINE_FORM)
    setLineWarning('')
    setErrorMsg('')
    setDateImportQueue([])
    setDateImportQueueTotal(0)
    setPosReportValidationWarning(null)
    setPanelOpen(true)
    loadProducts()
  }

  // Downloads just the sale open in the detail panel — same columns and
  // numbers as the date-range download on the list, in the order currently
  // shown on screen (so sorting the table first sorts the file too). Works
  // for voided sales as well; those lines are listed but not counted in the
  // totals.
  function downloadViewedSale() {
    if (!viewedSale) return
    const ordered = sortRows(viewedLines, lineSortKey, lineSortDir, (row, key) =>
      key === 'product' ? row.product?.name : key === 'category' ? row.product?.category : row[key]
    )
    const csv = buildSalesCsv(ordered.map((l) => ({ l, sale: viewedSale })))
    downloadFile(`${viewedSale.sale_number}.csv`, '\uFEFF' + csv, 'text/csv;charset=utf-8;')
  }

  async function openView(sale) {
    setMode('view')
    setViewedSale(sale)
    setErrorMsg('')
    const { data } = await supabase
      .from('sale_lines')
      .select('*, product:products(name, sku, barcode, unit, category, selling_price)')
      .eq('sale_id', sale.id)
    setViewedLines(data ?? [])
    setPanelOpen(true)
  }

  function startEditPrice(line) {
    setEditingDiscountQtyLineId(null) // mutually exclusive with a qty edit in progress
    setSplitPriceLineId(null)
    setEditingLineId(line.id)
    setEditPriceDraft(String(line.is_b1t1 ? line.b1t1_price : line.unit_price))
    setEditReasonDraft('')
  }

  function cancelEditPrice() {
    setEditingLineId(null)
  }

  // Recomputes everything downstream of a price correction — profit always,
  // and for a Senior/PWD or Buy 1 Take 1 line, the discount/VAT-exempt
  // split too, using the same formulas Sales.jsx uses when a line is first
  // created. Never touches quantity, consumption, or fifo_cost — the price
  // was wrong, not what physically left the shelf.
  async function saveEditPrice(line) {
    const newPriceInput = Number(editPriceDraft)
    if (!newPriceInput || newPriceInput <= 0) return
    if (!editReasonDraft.trim()) {
      setErrorMsg('A reason is required to correct a posted price.')
      return
    }
    setEditSaving(true)
    setErrorMsg('')

    const qty = Number(line.quantity)
    const fifoCost = Number(line.fifo_cost ?? 0)
    let payload = {
      original_unit_price: line.original_unit_price ?? line.unit_price,
      price_edited_at: new Date().toISOString(),
      price_edit_reason: editReasonDraft.trim(),
    }

    if (line.is_b1t1) {
      // Editing the price per set, not the blended per-unit price shown in
      // the table — that's the number a cashier would actually recognize.
      // fullValue uses the product's CURRENT selling price, same as when
      // the line was first created — if that price has changed since this
      // sale, the recomputed discount_amount reflects today's price, not
      // what it was back then.
      const newB1t1Price = newPriceInput
      const sets = qty / 2
      const chargedTotal = sets * newB1t1Price
      const newUnitPrice = chargedTotal / qty
      const fullValue = qty * Number(line.product?.selling_price ?? 0)
      payload = {
        ...payload,
        unit_price: newUnitPrice,
        b1t1_price: newB1t1Price,
        discount_amount: fullValue - chargedTotal,
        gross_profit: chargedTotal - fifoCost,
      }
    } else if (line.is_discounted) {
      const newUnitPrice = newPriceInput
      const vatExclusive = newUnitPrice / (1 - discountPct / 100)
      const sellingPrice = vatExclusive * (1 + vatRatePct / 100)
      payload = {
        ...payload,
        unit_price: newUnitPrice,
        vat_exempt_amount: qty * (sellingPrice - vatExclusive),
        discount_amount: qty * (vatExclusive - newUnitPrice),
        gross_profit: qty * newUnitPrice - fifoCost,
      }
    } else {
      const newUnitPrice = newPriceInput
      payload = {
        ...payload,
        unit_price: newUnitPrice,
        gross_profit: qty * newUnitPrice - fifoCost,
      }
    }

    const { error } = await supabase.from('sale_lines').update(payload).eq('id', line.id)
    if (error) {
      setErrorMsg(`Could not update price: ${error.message}`)
      setEditSaving(false)
      return
    }

    await openView(viewedSale)
    setEditingLineId(null)
    setEditSaving(false)
  }

  function startEditDiscountQty(line) {
    setEditingLineId(null) // mutually exclusive with a price edit in progress
    setSplitPriceLineId(null)
    const sibling = viewedLines.find(
      (s) =>
        s.product_id === line.product_id &&
        s.id !== line.id &&
        (line.is_discounted ? !s.is_discounted && !s.is_b1t1 : s.is_discounted)
    )
    const currentDiscountedQty = line.is_discounted ? line.quantity : sibling?.quantity ?? 0
    setEditingDiscountQtyLineId(line.id)
    setEditDiscountQtyDraft(String(currentDiscountedQty))
    setEditDiscountQtyReason('')
  }

  function cancelEditDiscountQty() {
    setEditingDiscountQtyLineId(null)
  }

  // Moves quantity between a discounted line and its regular-price sibling
  // (same product, same sale) — works starting from either side, including
  // a plain regular line with no discount at all yet, in which case the
  // discounted line gets created fresh. Never changes their combined
  // total, so inventory and quantity sold are untouched. Cost is
  // reallocated between the two by weighted average (combined fifo_cost ÷
  // combined quantity), not re-traced to specific batches — an honest
  // approximation, since the physical consumption already happened and
  // wasn't recorded per discount-status, only per line.
  async function saveEditDiscountQty(line) {
    const newDiscountedQty = Number(editDiscountQtyDraft)
    if (isNaN(newDiscountedQty) || newDiscountedQty < 0) return
    if (!editDiscountQtyReason.trim()) {
      setErrorMsg('A reason is required to change the discounted quantity.')
      return
    }
    setEditDiscountQtySaving(true)
    setErrorMsg('')

    const existingDiscountedLine = line.is_discounted
      ? line
      : viewedLines.find((s) => s.product_id === line.product_id && s.id !== line.id && s.is_discounted)
    const existingRegularLine = !line.is_discounted
      ? line
      : viewedLines.find((s) => s.product_id === line.product_id && s.id !== line.id && !s.is_discounted && !s.is_b1t1)

    const totalQty = Number(existingDiscountedLine?.quantity ?? 0) + Number(existingRegularLine?.quantity ?? 0)
    if (newDiscountedQty > totalQty) {
      setErrorMsg(`Can't discount more than the ${totalQty} ${line.product?.unit ?? ''} sold on this line.`)
      setEditDiscountQtySaving(false)
      return
    }

    const newRegularQty = totalQty - newDiscountedQty

    // Per-unit discount/VAT-exempt rate: reuse the existing discounted
    // line's own rate if one already exists. Starting fresh from a plain
    // regular line (no discount yet at all), compute it from scratch using
    // the same BIR formula (VAT backed out of the regular line's own
    // price, then 20% off that) that every other discount in this app uses.
    let discountPerUnit, vatExemptPerUnit, discountedUnitPrice
    if (existingDiscountedLine) {
      discountPerUnit = Number(existingDiscountedLine.discount_amount) / Number(existingDiscountedLine.quantity)
      vatExemptPerUnit = Number(existingDiscountedLine.vat_exempt_amount) / Number(existingDiscountedLine.quantity)
      discountedUnitPrice = Number(existingDiscountedLine.unit_price)
    } else {
      const sellingPrice = Number(existingRegularLine.unit_price)
      const vatExclusive = sellingPrice / (1 + vatRatePct / 100)
      discountedUnitPrice = Math.round(vatExclusive * (1 - discountPct / 100) * 100) / 100
      vatExemptPerUnit = sellingPrice - vatExclusive
      discountPerUnit = vatExclusive - discountedUnitPrice
    }

    const combinedFifoCost = Number(existingDiscountedLine?.fifo_cost ?? 0) + Number(existingRegularLine?.fifo_cost ?? 0)
    const regularUnitPrice = existingRegularLine
      ? Number(existingRegularLine.unit_price)
      : Number(line.product?.selling_price ?? 0)
    const avgCostPerUnit = totalQty > 0 ? combinedFifoCost / totalQty : 0
    const now = new Date().toISOString()
    const reason = editDiscountQtyReason.trim()

    try {
      // --- the discounted side ---
      if (newDiscountedQty === 0) {
        if (existingDiscountedLine) {
          const { error } = await supabase.from('sale_lines').delete().eq('id', existingDiscountedLine.id)
          if (error) throw error
        }
      } else {
        const newDiscountedFifoCost = newDiscountedQty * avgCostPerUnit
        const discountedPayload = {
          quantity: newDiscountedQty,
          unit_price: discountedUnitPrice,
          discount_amount: newDiscountedQty * discountPerUnit,
          vat_exempt_amount: newDiscountedQty * vatExemptPerUnit,
          fifo_cost: newDiscountedFifoCost,
          gross_profit: newDiscountedQty * discountedUnitPrice - newDiscountedFifoCost,
          discounted_qty_edited_at: now,
          discounted_qty_edit_reason: reason,
        }
        if (existingDiscountedLine) {
          const { error } = await supabase.from('sale_lines').update(discountedPayload).eq('id', existingDiscountedLine.id)
          if (error) throw error
        } else {
          const { error } = await supabase
            .from('sale_lines')
            .insert({ sale_id: line.sale_id, product_id: line.product_id, is_discounted: true, is_b1t1: false, ...discountedPayload })
          if (error) throw error
        }
      }

      // --- the regular side ---
      if (newRegularQty === 0) {
        if (existingRegularLine) {
          const { error } = await supabase.from('sale_lines').delete().eq('id', existingRegularLine.id)
          if (error) throw error
        }
      } else {
        const newRegularFifoCost = combinedFifoCost - newDiscountedQty * avgCostPerUnit
        const regularPayload = {
          quantity: newRegularQty,
          fifo_cost: newRegularFifoCost,
          gross_profit: newRegularQty * regularUnitPrice - newRegularFifoCost,
          discounted_qty_edited_at: now,
          discounted_qty_edit_reason: reason,
        }
        if (existingRegularLine) {
          const { error } = await supabase.from('sale_lines').update(regularPayload).eq('id', existingRegularLine.id)
          if (error) throw error
        } else {
          const { error } = await supabase.from('sale_lines').insert({
            sale_id: line.sale_id,
            product_id: line.product_id,
            unit_price: regularUnitPrice,
            is_discounted: false,
            is_b1t1: false,
            discount_amount: 0,
            vat_exempt_amount: null,
            ...regularPayload,
          })
          if (error) throw error
        }
      }

      await openView(viewedSale)
      setEditingDiscountQtyLineId(null)
    } catch (err) {
      setErrorMsg(`Could not update discounted quantity: ${err.message}`)
    }
    setEditDiscountQtySaving(false)
  }

  function startSplitPrice(line) {
    setEditingLineId(null)
    setEditingDiscountQtyLineId(null)
    setSplitPriceLineId(line.id)
    setSplitQtyDraft('')
    setSplitPriceDraft(String(line.unit_price))
    setSplitReasonDraft('')
  }

  function cancelSplitPrice() {
    setSplitPriceLineId(null)
  }

  // Splits off some quantity of a posted line at a different, arbitrary
  // price, as its own new line — the original line's quantity shrinks by
  // the same amount, so the combined total (and inventory/FIFO
  // consumption, already fixed at the time of the original sale) never
  // changes. Cost is reallocated between the two by weighted average, same
  // approach as Edit discounted qty.
  async function saveSplitPrice(line) {
    const splitQty = Number(splitQtyDraft)
    const newPrice = Number(splitPriceDraft)
    if (!splitQty || splitQty <= 0 || splitQty > Number(line.quantity)) {
      setErrorMsg(`Enter a quantity between 1 and ${line.quantity} to split off.`)
      return
    }
    if (!newPrice || newPrice <= 0) return
    if (!splitReasonDraft.trim()) {
      setErrorMsg('A reason is required to split off a different price.')
      return
    }
    setSplitSaving(true)
    setErrorMsg('')

    const remainingQty = Number(line.quantity) - splitQty
    const avgCostPerUnit = Number(line.fifo_cost ?? 0) / Number(line.quantity)
    const splitFifoCost = splitQty * avgCostPerUnit
    const remainingFifoCost = Number(line.fifo_cost ?? 0) - splitFifoCost
    const now = new Date().toISOString()
    const reason = splitReasonDraft.trim()

    try {
      if (remainingQty === 0) {
        // The whole line moves to the new price — still recorded as a
        // fresh entry rather than edited in place, per what was asked.
        const { error: delErr } = await supabase.from('sale_lines').delete().eq('id', line.id)
        if (delErr) throw delErr
      } else {
        const { error } = await supabase
          .from('sale_lines')
          .update({
            quantity: remainingQty,
            fifo_cost: remainingFifoCost,
            gross_profit: remainingQty * Number(line.unit_price) - remainingFifoCost,
            price_edited_at: now,
            price_edit_reason: reason,
          })
          .eq('id', line.id)
        if (error) throw error
      }

      const { error: insErr } = await supabase.from('sale_lines').insert({
        sale_id: line.sale_id,
        product_id: line.product_id,
        quantity: splitQty,
        unit_price: newPrice,
        is_discounted: false,
        is_b1t1: false,
        discount_amount: 0,
        vat_exempt_amount: null,
        fifo_cost: splitFifoCost,
        gross_profit: splitQty * newPrice - splitFifoCost,
        original_unit_price: Number(line.unit_price),
        price_edited_at: now,
        price_edit_reason: reason,
      })
      if (insErr) throw insErr

      await openView(viewedSale)
      setSplitPriceLineId(null)
    } catch (err) {
      setErrorMsg(`Could not split off a different price: ${err.message}`)
    }
    setSplitSaving(false)
  }

  function onProductPick(productId) {
    const p = products.find((x) => x.id === productId)
    setLineForm({ product_id: productId, quantity: '', unit_price: p?.selling_price ?? '' })
    // Same convention as unit_price above: reset to the new product's price
    // whenever a product is (re)picked, regardless of any prior edit.
    if (b1t1Mode) setB1t1PriceDraft(p?.selling_price != null ? String(p.selling_price) : '')
    setLineWarning('')
  }

  // Follows pairs_with_product_id links in EITHER direction, to any depth,
  // to find every product that shares one physical stock pool with this one.
  // Pairing direction isn't reliable in practice (some pairs point Meal→Only,
  // some Only→Meal, some chain three deep) — what matters isn't who points
  // to whom, it's which products are connected at all, since Daily Meals
  // could have been logged against any single member of that group.
  function resolveStockGroupIds(product) {
    const isKitchen = product.business_unit === 'KITCHEN' || product.category === 'KITCHEN'
    if (!isKitchen) return [product.id]

    const productsById = Object.fromEntries(products.map((p) => [p.id, p]))
    const visited = new Set()
    const queue = [product.id]
    while (queue.length > 0) {
      const currentId = queue.shift()
      if (visited.has(currentId)) continue
      visited.add(currentId)
      const current = productsById[currentId]
      if (!current) continue
      if (current.pairs_with_product_id) queue.push(current.pairs_with_product_id)
      for (const p of products) {
        if (p.pairs_with_product_id === currentId) queue.push(p.id)
      }
    }
    return [...visited]
  }

  // A Kitchen item's sale never blocks. Checks everything remaining across
  // its whole paired group — any date, since leftovers from an earlier day
  // are real, sellable stock, not just today's batch — and tops up the
  // shortfall automatically if that's not enough. No hard errors, no "was
  // this the exact date," no "was this specifically paired." One rule, used
  // everywhere a Kitchen item gets sold — manual entry and bulk import alike.
  async function ensureKitchenStock(product, qty, saleDate) {
    const isKitchen = product.business_unit === 'KITCHEN' || product.category === 'KITCHEN'
    if (!isKitchen || product.unlimited_stock) return

    const groupIds = resolveStockGroupIds(product)
    const { data: cacheRows } = await supabase
      .from('batch_cache')
      .select('remaining_quantity')
      .in('product_id', groupIds)
      .gt('remaining_quantity', 0)
    const remaining = (cacheRows ?? []).reduce((s, c) => s + Number(c.remaining_quantity), 0)

    if (remaining >= qty) return
    const shortfall = qty - remaining
    const topUpCost = Number(product.current_cost ?? 0)

    const { data: newBatch, error: batchErr } = await supabase
      .from('batches')
      .insert({
        product_id: product.id,
        source_type: 'KitchenProduction',
        received_quantity: shortfall,
        unit_cost: topUpCost,
        received_date: saleDate,
      })
      .select()
      .single()

    if (!batchErr) {
      await supabase.from('inventory_ledger').insert({
        product_id: product.id,
        batch_id: newBatch.id,
        transaction_type: 'KitchenProduction',
        quantity_change: shortfall,
        unit_cost_at_transaction: topUpCost,
        source_module: 'Kitchen',
        source_reference_id: newBatch.id,
        occurred_at: saleDate,
      })
    }
  }

  // Walks batch_cache in FIFO order across every product in the given group,
  // accounting for quantity already claimed by lines added earlier in this
  // same not-yet-saved sale.
  async function computeFifoConsumption(productIds, qtyNeeded, reservationSource = pendingLines) {
    const ids = Array.isArray(productIds) ? productIds : [productIds]
    const { data: batches, error } = await supabase
      .from('batch_cache')
      .select('*')
      .in('product_id', ids)
      .gt('remaining_quantity', 0)
      .order('fifo_sequence')

    if (error) throw error

    const reserved = {}
    for (const line of reservationSource) {
      for (const c of line.consumption) {
        reserved[c.batch_id] = (reserved[c.batch_id] ?? 0) + c.qty
      }
    }

    let remaining = qtyNeeded
    const consumption = []
    for (const b of batches ?? []) {
      const alreadyReserved = reserved[b.batch_id] ?? 0
      const available = Number(b.remaining_quantity) - alreadyReserved
      if (available <= 0) continue
      const take = Math.min(available, remaining)
      if (take > 0) {
        consumption.push({ batch_id: b.batch_id, qty: take, unit_cost: Number(b.unit_cost), product_id: b.product_id })
        remaining -= take
      }
      if (remaining <= 0) break
    }

    const totalAvailable = (batches ?? []).reduce((sum, b) => {
      const alreadyReserved = reserved[b.batch_id] ?? 0
      return sum + Math.max(0, Number(b.remaining_quantity) - alreadyReserved)
    }, 0)

    return { consumption, satisfied: remaining <= 0, totalAvailable }
  }

  // Splits one product's sold quantity into a discounted portion and a
  // regular-price portion — used when a Senior/PWD discount only applies to
  // some of what was sold. Each portion gets its own FIFO consumption, run
  // in sequence against the same reservation source, so together they
  // consume exactly the same physical stock a single undivided line would.
  async function buildDiscountSplitLines(product, totalQty, discountedQty, reservationSource) {
    const lines = []
    const regularQty = totalQty - discountedQty
    // Standard BIR Senior/PWD computation: VAT is backed out of the
    // (VAT-inclusive) selling price first, then the discount applies to
    // that VAT-exclusive amount — not a flat percentage off the sticker
    // price. VAT_RATE_PCT comes from Settings — a national rate, not a
    // business preference, but editable there (with a clear warning) in
    // case the actual government rate ever changes.
    //
    // The reduction is recorded as two separate figures, not one combined
    // number — see migration 0037. vatExemptPerUnit is the VAT backed out
    // of the sticker price; discountPerUnit is the 20% taken off what's
    // left after that. Both are needed separately for BIR/Senior-PWD
    // reporting; their sum is the total reduction from the sticker price.
    const vatExclusivePrice = Number(product.selling_price) / (1 + vatRatePct / 100)
    const discountedUnitPrice = Math.round(vatExclusivePrice * (1 - discountPct / 100) * 100) / 100
    const vatExemptPerUnit = Number(product.selling_price) - vatExclusivePrice
    const discountPerUnit = vatExclusivePrice - discountedUnitPrice
    // A sale dated before inventory tracking started touches no stock at all —
    // no batches, no ledger rows; cost is approximated from today's cost.
    if (!isBackfillSale) await ensureKitchenStock(product, totalQty, headerForm.sale_date)
    const stockGroupIds = resolveStockGroupIds(product)

    if (discountedQty > 0) {
      const consumption = isBackfillSale
        ? []
        : (await computeFifoConsumption(stockGroupIds, discountedQty, reservationSource)).consumption
      const fifoCost = isBackfillSale
        ? discountedQty * Number(product.current_cost ?? 0)
        : consumption.reduce((sum, c) => sum + c.qty * c.unit_cost, 0)
      const lineTotal = discountedQty * discountedUnitPrice
      lines.push({
        tempId: crypto.randomUUID(),
        product_id: product.id,
        product_name: product.name,
        category: product.category,
        unit: product.unit,
        quantity: discountedQty,
        unit_price: discountedUnitPrice,
        line_total: lineTotal,
        fifo_cost: fifoCost,
        gross_profit: lineTotal - fifoCost,
        consumption,
        is_discounted: true,
        discount_amount: discountedQty * discountPerUnit,
        vat_exempt_amount: discountedQty * vatExemptPerUnit,
      })
    }

    if (regularQty > 0) {
      const consumption = isBackfillSale
        ? []
        : (await computeFifoConsumption(stockGroupIds, regularQty, [...reservationSource, ...lines])).consumption
      const fifoCost = isBackfillSale
        ? regularQty * Number(product.current_cost ?? 0)
        : consumption.reduce((sum, c) => sum + c.qty * c.unit_cost, 0)
      const lineTotal = regularQty * Number(product.selling_price)
      lines.push({
        tempId: crypto.randomUUID(),
        product_id: product.id,
        product_name: product.name,
        category: product.category,
        unit: product.unit,
        quantity: regularQty,
        unit_price: Number(product.selling_price),
        line_total: lineTotal,
        fifo_cost: fifoCost,
        gross_profit: lineTotal - fifoCost,
        consumption,
        is_discounted: false,
        discount_amount: 0,
      })
    }

    return lines
  }

  function handleDownloadSalesLineTemplate() {
    const headers = ['Barcode', 'Quantity', 'Unit Price', 'Total Price']
    // Give either Unit Price or Total Price per row, not both — Total Price
    // gets divided by Quantity to work out the per-unit price automatically.
    const example1 = ['4800123456789', '3', '45', '']
    const example2 = ['4800987654321', '5', '', '225']
    const csv = [headers, example1, example2]
      .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    downloadFile('sale-lines-template.csv', csv, 'text/csv;charset=utf-8;')
  }

  function handleImportClick() {
    importFileInputRef.current?.click()
  }

  // Shared by both the CSV import and the POS report import — takes a plain
  // 2D array (row[0] = header, matched against SALE_LINE_HEADER_ALIASES) and
  // runs the exact same matching, price-mismatch, and stock-check pipeline
  // either way. Only how `rows` gets built differs between the two formats.
  async function processSalesImportRows(rows, saleDateOverride) {
    // Accepts an explicit date because startDateGroupImport calls setHeaderForm
    // and this in the same tick — React state wouldn't reflect the new date
    // yet, so isBackfillSale (component-level, from headerForm) would still
    // reflect the previous date group. Every backfill check below uses this
    // local value instead, never the outer isBackfillSale, so each date group
    // in a multi-date import is judged correctly on its own date.
    const effectiveSaleDate = saleDateOverride ?? headerForm.sale_date
    const backfillForThisImport = Boolean(
      effectiveSaleDate && inventoryTrackingStartDate && effectiveSaleDate < inventoryTrackingStartDate
    )

    if (rows.length < 2) {
      setErrorMsg('That file has no data rows.')
      setImportParsing(false)
      return
    }
    const headerRow = rows[0].map((h) => String(h).trim())
    const canonicalKeys = headerRow.map((h) => SALE_LINE_HEADER_ALIASES[normalizeHeader(h)] ?? null)

    // Strips stray whitespace (including non-breaking spaces Excel/Sheets
    // sometimes paste in) and ignores case, so a barcode that LOOKS
    // identical doesn't get skipped over an invisible formatting difference.
    const cleanCode = (v) =>
      (v ?? '')
        .normalize('NFKC')
        // eslint-disable-next-line no-misleading-character-class -- intentional list of individual invisible chars, not a ZWJ sequence
        .replace(/[\s\u200B\u200C\u200D\u2060\uFEFF\u00AD]/g, '')
        .toUpperCase()

    // ---------- Pass 1: parse every row and match it to a product ----------
    const parsedRows = []
    const skipped = []
    const mismatches = []

    for (const [idx, r] of rows.slice(1).entries()) {
      const rowNum = idx + 2
      if (r.length !== headerRow.length) {
        skipped.push({
          rowNum,
          reason: `Row has ${r.length} column${r.length === 1 ? '' : 's'}, expected ${headerRow.length} — likely a stray quote or comma in this row or an earlier one threw off parsing from here on`,
        })
        continue
      }

      const obj = {}
      canonicalKeys.forEach((key, i) => {
        if (key) obj[key] = String(r[i] ?? '').trim()
      })

      const product = obj.barcode
        ? resolveProductByCode(products, extraBarcodeMap, obj.barcode, cleanCode)
        : obj.sku
          ? products.find((p) => cleanCode(p.sku) === cleanCode(obj.sku))
          : null

      if (!product) {
        const rawBarcode = obj.barcode || obj.sku || null
        const rawQty = Number(obj.quantity)
        skipped.push({
          rowNum,
          reason: rawBarcode ? `No product matches "${rawBarcode}"` : 'Missing barcode/SKU',
          // The file's own description column — the only way to identify
          // what this row was actually for when the barcode/SKU lookup
          // itself failed, so there's no matched product to name it from.
          productName: obj.description || null,
          barcode: rawBarcode,
          qty: obj.quantity || null,
          price: obj.unit_price || obj.total_price || null,
          priceLabel: obj.unit_price ? 'unit price' : obj.total_price ? 'total price' : null,
          // Enough to actually create a product from and re-add this exact
          // line — see handleQuickAddProduct. Not offered without a real
          // barcode and a valid qty, since both are required to do that.
          canQuickAdd: Boolean(rawBarcode) && Boolean(rawQty) && rawQty > 0,
        })
        continue
      }
      // Archived products are no longer skipped here — a real sale for one
      // is exactly the "movement" that migration 0035's trigger reactivates
      // a product on, so this just lets the row through like any other and
      // the reactivation happens naturally once the sale posts.
      const qty = Number(obj.quantity)
      if (!qty || qty <= 0) {
        skipped.push({
          rowNum,
          reason: 'Missing or invalid quantity',
          productName: product.name,
          barcode: product.barcode,
          qty: obj.quantity || null,
          price: obj.unit_price || obj.total_price || null,
          priceLabel: obj.unit_price ? 'unit price' : obj.total_price ? 'total price' : null,
        })
        continue
      }

      // Either Unit Price or Total Price can be given — Total Price gets
      // divided back down to a per-unit price. Neither given at all just
      // defaults to the recorded price (no mismatch possible by definition).
      let unitPrice
      const priceWasGiven = Boolean(obj.unit_price || obj.total_price)
      if (obj.unit_price) {
        unitPrice = Number(obj.unit_price)
      } else if (obj.total_price) {
        unitPrice = Number(obj.total_price) / qty
      } else {
        unitPrice = Number(product.selling_price ?? 0)
      }

      if (priceWasGiven && Math.abs(unitPrice - Number(product.selling_price ?? 0)) > 0.01) {
        mismatches.push({
          tempId: crypto.randomUUID(),
          rowNum,
          product,
          qty,
          givenUnitPrice: unitPrice,
          recordedPrice: Number(product.selling_price ?? 0),
        })
        continue
      }

      parsedRows.push({ rowNum, product, qty, unitPrice })
    }

    // ---------- Pass 2: Kitchen items always have enough stock ----------
    // One rule, applied here per distinct group so a Meal+Silog sharing
    // one Only only gets topped up once for their combined need, not
    // once per row. See ensureKitchenStock for what the rule actually is.
    // Skipped entirely for a backfilled date — see proceedAddLine for why.
    if (!backfillForThisImport) {
      const kitchenGroups = new Map()
      for (const pr of parsedRows) {
        const isKitchen = pr.product.business_unit === 'KITCHEN' || pr.product.category === 'KITCHEN'
        if (!isKitchen || pr.product.unlimited_stock) continue
        const key = [...resolveStockGroupIds(pr.product)].sort().join(',')
        if (!kitchenGroups.has(key)) {
          kitchenGroups.set(key, { neededQty: 0, product: pr.product })
        }
        kitchenGroups.get(key).neededQty += pr.qty
      }
      for (const g of kitchenGroups.values()) {
        await ensureKitchenStock(g.product, g.neededQty, effectiveSaleDate)
      }
    }

    // ---------- Pass 3: normal per-row FIFO stock check ----------
    const valid = []
    // Accumulates alongside `pendingLines` so each row in this same file
    // correctly sees stock already claimed by earlier rows in the file —
    // React state wouldn't update fast enough inside this loop to rely on.
    const accumulator = [...pendingLines]

    for (const pr of parsedRows) {
      try {
        const lineTotal = pr.qty * pr.unitPrice
        let consumption = []
        let isOversold = false
        let oversoldNote = null
        let fifoCost

        if (backfillForThisImport) {
          fifoCost = pr.qty * Number(pr.product.current_cost ?? 0)
        } else {
          const stockGroupIds = resolveStockGroupIds(pr.product)
          const result = await computeFifoConsumption(stockGroupIds, pr.qty, accumulator)
          consumption = result.consumption
          const consumedQty = consumption.reduce((sum, c) => sum + c.qty, 0)
          const openQty = pr.qty - consumedQty
          fifoCost =
            consumption.reduce((sum, c) => sum + c.qty * c.unit_cost, 0) + openQty * Number(pr.product.current_cost ?? 0)
          isOversold = !result.satisfied && !pr.product.unlimited_stock
          oversoldNote = isOversold ? `only ${result.totalAvailable} ${pr.product.unit} were in stock — sold anyway, now negative` : null
        }

        const newLine = {
          tempId: crypto.randomUUID(),
          product_id: pr.product.id,
          product_name: pr.product.name,
          category: pr.product.category,
          unit: pr.product.unit,
          quantity: pr.qty,
          unit_price: pr.unitPrice,
          line_total: lineTotal,
          fifo_cost: fifoCost,
          gross_profit: lineTotal - fifoCost,
          consumption,
          openQty: pr.qty - consumption.reduce((sum, c) => sum + c.qty, 0),
          isOversold,
          oversoldNote,
        }
        accumulator.push(newLine)
        valid.push(newLine)
      } catch {
        skipped.push({
          rowNum: pr.rowNum,
          reason: 'Could not check stock for this row',
          productName: pr.product.name,
          barcode: pr.product.barcode,
          qty: pr.qty,
          price: pr.unitPrice,
          priceLabel: 'unit price',
        })
      }
    }

    setImportPreviewValid(valid)
    setImportPreviewSkipped(skipped)
    setImportMismatches(mismatches)
    setImportParsing(false)
    setImportPanelOpen(true)
  }

  function handleImportFileChange(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    const reader = new FileReader()
    reader.onload = async () => {
      setImportParsing(true)
      setErrorMsg('')
      setPosReportValidationWarning(null)
      try {
        const rows = parseCsv(String(reader.result))
        await processSalesImportRows(rows)
      } catch {
        setImportParsing(false)
        setErrorMsg('Could not read that file — make sure it is a CSV, not an .xlsx.')
      }
    }
    reader.readAsText(file)
  }

  function handlePosReportImportClick() {
    posReportFileInputRef.current?.click()
  }

  // Wraps FileReader in a promise so multiple files can be read with a
  // plain await loop instead of nesting callbacks.
  function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(file)
    })
  }

  // Runs the parsed rows for one date-group through the same import
  // pipeline, whether it's the only date selected or one queued up after
  // an earlier one in the same batch just got completed.
  async function startDateGroupImport(group) {
    setHeaderForm((f) => ({
      ...f,
      sale_date: group.date,
      pos_terminal: group.terminals.length > 0 ? group.terminals.join(', ') : f.pos_terminal,
    }))
    if (group.warnings.length > 0) setPosReportValidationWarning(group.warnings)
    const rows = [
      ['Barcode', 'Description', 'Quantity', 'Total Price'],
      ...group.rows.map((r) => [r.barcode, r.description ?? '', String(r.qty), String(r.amount)]),
    ]
    await processSalesImportRows(rows, group.date)
  }

  async function handlePosReportFileChange(e) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length === 0) return

    setImportParsing(true)
    setErrorMsg('')
    setPosReportValidationWarning(null)

    // date -> { rows: [...], terminals: Set, warnings: [...] } — files with
    // no detectable date fall back to whatever date is already in the form,
    // same as before this grouped multiple dates at all.
    const groups = new Map()

    for (const file of files) {
      try {
        const buffer = await readFileAsArrayBuffer(file)
        const result = parsePosReportWorkbook(buffer)
        if (result.error) {
          setImportParsing(false)
          setErrorMsg(`${file.name}: ${result.error}`)
          return
        }

        const { saleDate, posTerminal } = extractDateAndTerminalFromFilename(file.name)
        const key = saleDate ?? headerForm.sale_date
        if (!groups.has(key)) groups.set(key, { date: key, terminals: new Set(), warnings: [], rows: [] })
        const group = groups.get(key)
        if (posTerminal) group.terminals.add(posTerminal)
        if (result.validationWarning) group.warnings.push(`${file.name}: ${result.validationWarning}`)
        group.rows.push(...result.dataRows)
      } catch {
        setImportParsing(false)
        setErrorMsg(`${file.name}: could not read this file — make sure it's the .xls "Items Sold" POS report.`)
        return
      }
    }

    // Oldest date first — matches how a backlog would actually get entered.
    const sortedGroups = [...groups.values()]
      .map((g) => ({ ...g, terminals: [...g.terminals].sort() }))
      .sort((a, b) => a.date.localeCompare(b.date))

    // Reimporting a specific day: refuse a file for any other day or terminal
    // rather than quietly posting it somewhere else.
    if (reimportContext) {
      const wrongDate = sortedGroups.find((g) => g.date !== reimportContext.date)
      if (wrongDate) {
        setImportParsing(false)
        setErrorMsg(
          `That file is dated ${wrongDate.date}, but you're reimporting ${reimportContext.date}. Pick the file for ${reimportContext.date}.`
        )
        return
      }
      const wanted = String(reimportContext.terminal ?? '').match(/\d+/g) ?? []
      if (wanted.length === 1) {
        const wrongTerminal = sortedGroups.find(
          (g) => g.terminals.length > 0 && !g.terminals.some((t) => String(t).replace(/\D/g, '') === wanted[0])
        )
        if (wrongTerminal) {
          setImportParsing(false)
          setErrorMsg(
            `That file is for POS ${wrongTerminal.terminals.join(', ')}, but you're reimporting POS ${wanted[0]}. Pick that terminal's file.`
          )
          return
        }
      }
    }

    setDateImportQueueTotal(sortedGroups.length)
    setDateImportQueue(sortedGroups.slice(1))
    await startDateGroupImport(sortedGroups[0])
  }

  function setMismatchDraft(tempId, draft) {
    setImportMismatches(importMismatches.map((m) => (m.tempId === tempId ? { ...m, discountQtyDraft: draft } : m)))
  }

  // Shared by resolveMismatchUpdatePrice and resolveMismatchUseOnce — both
  // end up doing the same stock check and building the same kind of line,
  // just with different opinions on whether products.selling_price changes.
  // Builds the line for a mismatched import row at a given unit price, with
  // its stock allocation — or, for a sale dated before inventory tracking
  // started, with no stock touched at all (same rule as every other way of
  // adding a line; see inventoryTrackingStartDate).
  async function buildResolvedMismatchLine(mismatch, product, unitPrice) {
    const lineTotal = mismatch.qty * unitPrice
    let consumption = []
    let openQty = 0
    let isOversold = false
    let oversoldNote = null
    let fifoCost

    if (isBackfillSale) {
      fifoCost = mismatch.qty * Number(product.current_cost ?? 0)
    } else {
      const reservationSource = [...pendingLines, ...importPreviewValid]
      await ensureKitchenStock(product, mismatch.qty, headerForm.sale_date)
      const stockGroupIds = resolveStockGroupIds(product)
      const result = await computeFifoConsumption(stockGroupIds, mismatch.qty, reservationSource)
      consumption = result.consumption
      isOversold = !result.satisfied && !product.unlimited_stock
      const consumedQty = consumption.reduce((sum, c) => sum + c.qty, 0)
      openQty = mismatch.qty - consumedQty
      fifoCost = consumption.reduce((sum, c) => sum + c.qty * c.unit_cost, 0) + openQty * Number(product.current_cost ?? 0)
      oversoldNote = isOversold ? `only ${result.totalAvailable} ${product.unit} were in stock — sold anyway, now negative` : null
    }

    return {
      tempId: crypto.randomUUID(),
      product_id: product.id,
      product_name: product.name,
      category: product.category,
      unit: product.unit,
      quantity: mismatch.qty,
      unit_price: unitPrice,
      line_total: lineTotal,
      fifo_cost: fifoCost,
      gross_profit: lineTotal - fifoCost,
      consumption,
      openQty,
      isOversold,
      oversoldNote,
      is_discounted: false,
      discount_amount: 0,
    }
  }

  async function addResolvedMismatchLine(mismatch, product, unitPrice) {
    try {
      const line = await buildResolvedMismatchLine(mismatch, product, unitPrice)
      setImportPreviewValid([...importPreviewValid, line])
    } catch {
      setImportPreviewSkipped([
        ...importPreviewSkipped,
        {
          rowNum: mismatch.rowNum,
          reason: 'Could not check stock for this row',
          productName: product.name,
          barcode: product.barcode,
          qty: mismatch.qty,
          price: unitPrice,
          priceLabel: 'unit price',
        },
      ])
    }
    setImportMismatches(importMismatches.filter((m) => m.tempId !== mismatch.tempId))
  }

  function patchMismatch(tempId, patch) {
    setImportMismatches(importMismatches.map((m) => (m.tempId === tempId ? { ...m, ...patch } : m)))
  }

  // Typing a quantity pre-fills the price that makes the split add up to the
  // file's own total for this row (the rest staying at the recorded price),
  // until the price is typed over by hand.
  function onMismatchSplitQty(m, value) {
    const k = Number(value)
    const patch = { splitQtyDraft: value }
    if (!m.splitPriceTouched && k > 0 && k < m.qty) {
      const fileTotal = m.givenUnitPrice * m.qty
      const x = (fileTotal - (m.qty - k) * m.recordedPrice) / k
      patch.splitPriceDraft = x > 0 ? x.toFixed(2) : ''
    }
    patchMismatch(m.tempId, patch)
  }

  function onMismatchSplitPrice(m, value) {
    patchMismatch(m.tempId, { splitPriceDraft: value, splitPriceTouched: true })
  }

  // Some units at the recorded price, the rest at a different one — instead
  // of averaging them into one line that matches neither.
  async function resolveMismatchSplit(mismatch) {
    const k = Number(mismatch.splitQtyDraft)
    const price = Number(mismatch.splitPriceDraft)
    if (!k || k <= 0 || k >= mismatch.qty || !price || price <= 0) {
      setErrorMsg(`Enter a quantity from 1 to ${mismatch.qty - 1} and a price for those units.`)
      return
    }
    setErrorMsg('')
    try {
      const base = await buildResolvedMismatchLine(mismatch, mismatch.product, mismatch.recordedPrice)
      const parts = splitLineAtPrice(base, k, price)
      setImportPreviewValid([...importPreviewValid, ...parts])
    } catch {
      setImportPreviewSkipped([
        ...importPreviewSkipped,
        {
          rowNum: mismatch.rowNum,
          reason: 'Could not check stock for this row',
          productName: mismatch.product.name,
          barcode: mismatch.product.barcode,
          qty: mismatch.qty,
          price: mismatch.givenUnitPrice,
          priceLabel: 'unit price',
        },
      ])
    }
    setImportMismatches(importMismatches.filter((m) => m.tempId !== mismatch.tempId))
  }

  async function resolveMismatchUpdatePrice(mismatch) {
    const { error } = await supabase.from('products').update({ selling_price: mismatch.givenUnitPrice }).eq('id', mismatch.product.id)
    if (error) {
      setErrorMsg(error.message)
      return
    }
    const updatedProduct = { ...mismatch.product, selling_price: mismatch.givenUnitPrice }
    setProducts(products.map((p) => (p.id === updatedProduct.id ? updatedProduct : p)))
    await addResolvedMismatchLine(mismatch, updatedProduct, mismatch.givenUnitPrice)
  }

  async function resolveMismatchDiscount(mismatch) {
    const discountedQty = Number(mismatch.discountQtyDraft)
    if (!discountedQty || discountedQty <= 0 || discountedQty > mismatch.qty) return
    try {
      const reservationSource = [...pendingLines, ...importPreviewValid]
      const newLines = await buildDiscountSplitLines(mismatch.product, mismatch.qty, discountedQty, reservationSource)
      setImportPreviewValid([...importPreviewValid, ...newLines])
    } catch {
      setImportPreviewSkipped([
        ...importPreviewSkipped,
        {
          rowNum: mismatch.rowNum,
          reason: 'Could not check stock for this row',
          productName: mismatch.product.name,
          barcode: mismatch.product.barcode,
          qty: mismatch.qty,
          price: mismatch.givenUnitPrice,
          priceLabel: 'unit price',
        },
      ])
    }
    setImportMismatches(importMismatches.filter((m) => m.tempId !== mismatch.tempId))
  }

  // For backlog imports specifically — the given price was genuinely
  // correct on that date, but the product's price has since changed and
  // shouldn't be reverted. Uses the given price for this one line only,
  // leaving products.selling_price untouched (unlike resolveMismatchUpdatePrice)
  // and without treating it as a discount (unlike resolveMismatchDiscount).
  async function resolveMismatchUseOnce(mismatch) {
    await addResolvedMismatchLine(mismatch, mismatch.product, mismatch.givenUnitPrice)
  }

  function resolveMismatchSkip(mismatch) {
    setImportPreviewSkipped([...importPreviewSkipped, { rowNum: mismatch.rowNum, reason: 'Price mismatch left unresolved — skipped' }])
    setImportMismatches(importMismatches.filter((m) => m.tempId !== mismatch.tempId))
  }

  function handleConfirmImportLines() {
    setImporting(true)
    setPendingLines([...pendingLines, ...importPreviewValid])
    setImporting(false)
    setImportPanelOpen(false)
    setImportPreviewValid([])
    setImportPreviewSkipped([])
    setPosReportValidationWarning(null)
  }

  function startQuickAdd(s) {
    const qty = Number(s.qty) || 1
    const rawPrice = Number(s.price) || 0
    const unitPriceGuess = s.priceLabel === 'total price' ? rawPrice / qty : rawPrice
    setQuickAddForm({
      name: s.productName || '',
      unit: 'pcs',
      category: '',
      selling_price: unitPriceGuess ? unitPriceGuess.toFixed(2) : '',
      current_cost: '',
    })
    setQuickAddRowNum(s.rowNum)
  }

  function cancelQuickAdd() {
    setQuickAddRowNum(null)
  }

  // Creates the product this skipped row was actually for, straight from
  // what the file already told us (barcode, description, qty, price), then
  // re-adds this exact row as a normal line — no need to re-upload.
  async function handleQuickAddProduct(s) {
    if (!quickAddForm.name.trim() || !s.barcode) return
    setQuickAddSaving(true)
    setErrorMsg('')

    const { data: newProduct, error } = await supabase
      .from('products')
      .insert({
        barcode: s.barcode,
        name: quickAddForm.name.trim(),
        unit: quickAddForm.unit.trim() || null,
        category: quickAddForm.category.trim() || null,
        selling_price: quickAddForm.selling_price ? Number(quickAddForm.selling_price) : 0,
        current_cost: quickAddForm.current_cost ? Number(quickAddForm.current_cost) : 0,
        // A backfilled sale predates real inventory tracking, so there's no
        // way to know this product's actual current stock — rather than
        // leaving it "active" at a phantom 0 stock for three weeks until
        // auto-archive catches it anyway (migration 0034), archive it right
        // away; its only known "movement" is this historical sale.
        status: isBackfillSale ? 'archived' : 'active',
      })
      .select()
      .single()

    if (error) {
      setErrorMsg(`Could not add product: ${error.message}`)
      setQuickAddSaving(false)
      return
    }

    setProducts([...products, newProduct])

    // Any other skipped row for this exact barcode gets resolved too, not
    // just the one that was clicked — otherwise adding the product wouldn't
    // actually clear out every instance of it sold in the same file.
    const matchingRows = importPreviewSkipped.filter((row) => row.barcode === s.barcode && row.canQuickAdd)
    const newValidLines = []

    for (const row of matchingRows) {
      const qty = Number(row.qty)
      const rawPrice = Number(row.price)
      const unitPrice = row.price
        ? row.priceLabel === 'total price'
          ? rawPrice / qty
          : rawPrice
        : Number(quickAddForm.selling_price) || 0
      const lineTotal = qty * unitPrice
      let consumption = []
      let isOversold = false
      let openQty = 0
      let fifoCost = qty * Number(quickAddForm.current_cost || 0)

      if (!isBackfillSale) {
        await ensureKitchenStock(newProduct, qty, headerForm.sale_date)
        const stockGroupIds = resolveStockGroupIds(newProduct)
        const result = await computeFifoConsumption(stockGroupIds, qty, [...pendingLines, ...importPreviewValid, ...newValidLines])
        consumption = result.consumption
        const consumedQty = consumption.reduce((sum, c) => sum + c.qty, 0)
        openQty = qty - consumedQty
        fifoCost = consumption.reduce((sum, c) => sum + c.qty * c.unit_cost, 0) + openQty * Number(newProduct.current_cost ?? 0)
        isOversold = !result.satisfied && !newProduct.unlimited_stock
      }

      newValidLines.push({
        tempId: crypto.randomUUID(),
        product_id: newProduct.id,
        product_name: newProduct.name,
        category: newProduct.category,
        unit: newProduct.unit,
        quantity: qty,
        unit_price: unitPrice,
        line_total: lineTotal,
        fifo_cost: fifoCost,
        gross_profit: lineTotal - fifoCost,
        consumption,
        openQty,
        isOversold,
        oversoldNote: isOversold ? 'newly added product — sold beyond available stock, now negative' : null,
      })
    }

    setImportPreviewValid([...importPreviewValid, ...newValidLines])
    setImportPreviewSkipped(importPreviewSkipped.filter((row) => !(row.barcode === s.barcode && row.canQuickAdd)))
    setQuickAddRowNum(null)
    setQuickAddSaving(false)
  }

  async function proceedAddLine(product, qty, unitPrice) {
    let consumption = []
    let isOversold = false
    let fifoCost
    let openQty = 0

    if (isBackfillSale) {
      // No FIFO consumption, no batches touched, no ledger rows at
      // completeSale (it builds ledgerRows from `consumption`, which is
      // empty here) — see the note on inventoryTrackingStartDate above.
      // Cost is necessarily an approximation (today's cost, not whatever it
      // really was back then), same honesty tradeoff this app already makes
      // for other cost gaps it can't recover.
      fifoCost = qty * Number(product.current_cost ?? 0)
    } else {
      await ensureKitchenStock(product, qty, headerForm.sale_date)
      const stockGroupIds = resolveStockGroupIds(product)
      const result = await computeFifoConsumption(stockGroupIds, qty)
      consumption = result.consumption
      const consumedQty = consumption.reduce((sum, c) => sum + c.qty, 0)
      openQty = qty - consumedQty
      fifoCost = consumption.reduce((sum, c) => sum + c.qty * c.unit_cost, 0) + openQty * Number(product.current_cost ?? 0)

      // Sales never block on insufficient stock. Items flagged "unlimited
      // stock" already treat the shortfall as an untracked open quantity —
      // for everything else, the shortfall becomes real, visible negative
      // stock (a batch-less ledger entry written at completeSale), so it
      // surfaces in the Negative Stock tab instead of silently vanishing or
      // stopping the sale.
      isOversold = !result.satisfied && !product.unlimited_stock
      if (isOversold) {
        setLineWarning(
          `${product.name}: only ${result.totalAvailable} ${product.unit} available — sold anyway. ${openQty} ${product.unit} will show as negative stock until corrected.`
        )
      }
    }

    const lineTotal = qty * unitPrice

    setPendingLines([
      ...pendingLines,
      {
        tempId: crypto.randomUUID(),
        product_id: product.id,
        product_name: product.name,
        category: product.category,
        unit: product.unit,
        quantity: qty,
        unit_price: unitPrice,
        line_total: lineTotal,
        fifo_cost: fifoCost,
        gross_profit: lineTotal - fifoCost,
        consumption,
        openQty,
        isOversold,
        is_discounted: false,
        discount_amount: 0,
      },
    ])
    return true
  }

  // Buy 1 Take 1: quantity is the real physical units taken (always even —
  // 2 per set), b1t1Price is what's charged for one whole set. unit_price is
  // still stored as charged-total ÷ quantity, so line_total (quantity ×
  // unit_price) comes out to exactly what was collected — every existing
  // rollup that sums line_total or quantity keeps working untouched.
  async function proceedAddB1T1Line(product, qty, b1t1Price) {
    let consumption = []
    let isOversold = false
    let openQty = 0
    let fifoCost

    const sets = qty / 2
    const chargedTotal = sets * b1t1Price
    const fullValue = qty * Number(product.selling_price)
    const effectiveUnitPrice = chargedTotal / qty

    if (isBackfillSale) {
      // See the note on inventoryTrackingStartDate / proceedAddLine — same
      // reasoning applies to a backfilled B1T1 line.
      fifoCost = qty * Number(product.current_cost ?? 0)
    } else {
      await ensureKitchenStock(product, qty, headerForm.sale_date)
      const stockGroupIds = resolveStockGroupIds(product)
      const result = await computeFifoConsumption(stockGroupIds, qty)
      consumption = result.consumption
      const consumedQty = consumption.reduce((sum, c) => sum + c.qty, 0)
      openQty = qty - consumedQty
      fifoCost = consumption.reduce((sum, c) => sum + c.qty * c.unit_cost, 0) + openQty * Number(product.current_cost ?? 0)

      isOversold = !result.satisfied && !product.unlimited_stock
      if (isOversold) {
        setLineWarning(
          `${product.name}: only ${result.totalAvailable} ${product.unit} available — sold anyway. ${openQty} ${product.unit} will show as negative stock until corrected.`
        )
      }
    }

    setPendingLines([
      ...pendingLines,
      {
        tempId: crypto.randomUUID(),
        product_id: product.id,
        product_name: product.name,
        category: product.category,
        unit: product.unit,
        quantity: qty,
        unit_price: effectiveUnitPrice,
        line_total: chargedTotal,
        fifo_cost: fifoCost,
        gross_profit: chargedTotal - fifoCost,
        consumption,
        openQty,
        isOversold,
        is_discounted: false,
        is_b1t1: true,
        b1t1_price: b1t1Price,
        discount_amount: fullValue - chargedTotal,
      },
    ])
    return true
  }

  async function handleAddB1T1Line(e) {
    e.preventDefault()
    setLineWarning('')
    if (!lineForm.product_id || !lineForm.quantity || !b1t1PriceDraft) return

    const qty = Number(lineForm.quantity)
    const product = products.find((p) => p.id === lineForm.product_id)
    const b1t1Price = Number(b1t1PriceDraft)

    if (qty % 2 !== 0 || qty <= 0) {
      setLineWarning('Buy 1 Take 1 needs an even quantity — 2 units per set.')
      return
    }

    try {
      const added = await proceedAddB1T1Line(product, qty, b1t1Price)
      if (added) {
        setLineForm(EMPTY_LINE_FORM)
        setB1t1Mode(false)
        setB1t1PriceDraft('')
      }
    } catch {
      setLineWarning('Could not check available stock — try again.')
    }
  }

  async function handleAddLine(e) {
    if (b1t1Mode) return handleAddB1T1Line(e)
    e.preventDefault()
    setLineWarning('')
    if (!lineForm.product_id || !lineForm.quantity || !lineForm.unit_price) return

    const qty = Number(lineForm.quantity)
    const product = products.find((p) => p.id === lineForm.product_id)
    const unitPrice = Number(lineForm.unit_price)

    // A price that doesn't match what's on file usually means either the
    // price genuinely changed, or this is a Senior/PWD discount — either way
    // it needs a decision, not a silent guess. Skipped entirely if already
    // resolved for this exact attempt (priceMismatch cleared just before).
    if (!priceMismatch && Math.abs(unitPrice - Number(product.selling_price)) > 0.01) {
      setPriceMismatch({ recordedPrice: Number(product.selling_price), givenPrice: unitPrice })
      return
    }

    try {
      const added = await proceedAddLine(product, qty, unitPrice)
      if (added) {
        setLineForm(EMPTY_LINE_FORM)
        setPriceMismatch(null)
        setDiscountMode(false)
        setDiscountQtyDraft('')
      }
    } catch {
      setLineWarning('Could not check available stock — try again.')
    }
  }

  async function handleUpdatePriceAndAdd() {
    const product = products.find((p) => p.id === lineForm.product_id)
    const newPrice = priceMismatch.givenPrice
    const { error } = await supabase.from('products').update({ selling_price: newPrice }).eq('id', product.id)
    if (error) {
      setLineWarning(`Could not update price: ${error.message}`)
      return
    }
    setProducts(products.map((p) => (p.id === product.id ? { ...p, selling_price: newPrice } : p)))
    setPriceMismatch(null)
    try {
      const added = await proceedAddLine({ ...product, selling_price: newPrice }, Number(lineForm.quantity), newPrice)
      if (added) {
        setLineForm(EMPTY_LINE_FORM)
        setDiscountMode(false)
        setDiscountQtyDraft('')
      }
    } catch {
      setLineWarning('Could not check available stock — try again.')
    }
  }

  // Same backlog scenario as the bulk import's "use once" option — the given
  // price was accurate on that date, but the product's price has since
  // changed and shouldn't be reverted. Adds the line at that price without
  // touching products.selling_price.
  async function handleUseOnceAndAdd() {
    const product = products.find((p) => p.id === lineForm.product_id)
    const givenPrice = priceMismatch.givenPrice
    setPriceMismatch(null)
    try {
      const added = await proceedAddLine(product, Number(lineForm.quantity), givenPrice)
      if (added) {
        setLineForm(EMPTY_LINE_FORM)
        setDiscountMode(false)
        setDiscountQtyDraft('')
      }
    } catch {
      setLineWarning('Could not check available stock — try again.')
    }
  }

  async function handleConfirmDiscountSplit() {
    const product = products.find((p) => p.id === lineForm.product_id)
    const qty = Number(lineForm.quantity)
    const discountedQty = Number(discountQtyDraft)
    if (!discountedQty || discountedQty <= 0 || discountedQty > qty) {
      setLineWarning(`Discounted quantity must be between 1 and ${qty}.`)
      return
    }
    try {
      const newLines = await buildDiscountSplitLines(product, qty, discountedQty, pendingLines)
      setPendingLines([...pendingLines, ...newLines])
      setLineForm(EMPTY_LINE_FORM)
      setPriceMismatch(null)
      setDiscountMode(false)
      setDiscountQtyDraft('')
      setLineWarning('')
    } catch {
      setLineWarning('Could not check available stock — try again.')
    }
  }


  function startSplitPending(line) {
    setSplitPendingId(line.tempId)
    setSplitPendingQty('')
    setSplitPendingPrice(String(line.unit_price))
  }

  function cancelSplitPending() {
    setSplitPendingId(null)
  }

  function confirmSplitPending(line) {
    const k = Number(splitPendingQty)
    const price = Number(splitPendingPrice)
    if (!k || k <= 0 || k >= Number(line.quantity)) {
      setErrorMsg(`Enter a quantity from 1 to ${Number(line.quantity) - 1} to split off. To change the whole line's price, use the pencil instead.`)
      return
    }
    if (!price || price <= 0) {
      setErrorMsg('Enter the new price for the split-off units.')
      return
    }
    setErrorMsg('')
    const parts = splitLineAtPrice(line, k, price)
    setPendingLines(pendingLines.flatMap((l) => (l.tempId === line.tempId ? parts : [l])))
    setSplitPendingId(null)
  }

  function removeLine(tempId) {
    setPendingLines(pendingLines.filter((l) => l.tempId !== tempId))
  }

  function startEditLine(line) {
    // Remove it first so its reserved batch quantity is freed — re-adding via
    // the form below recomputes FIFO fresh, correctly seeing that stock again.
    setPendingLines(pendingLines.filter((l) => l.tempId !== line.tempId))
    setLineForm({ product_id: line.product_id, quantity: String(line.quantity), unit_price: String(line.unit_price) })
    setB1t1Mode(Boolean(line.is_b1t1))
    setB1t1PriceDraft(line.is_b1t1 ? String(line.b1t1_price ?? '') : '')
    setLineWarning('')
  }

  function openQuickReceive() {
    setQuickReceiveForm({ quantity: lineForm.quantity || '', unit_cost: '', expiration_date: '' })
    setQuickReceiveError('')
    setQuickReceiveOpen(true)
  }

  async function handleQuickReceive(e) {
    e.preventDefault()
    if (!quickReceiveForm.quantity || !quickReceiveForm.unit_cost) return
    setQuickReceiveSaving(true)
    setQuickReceiveError('')

    // Same draft-then-post flow as a normal purchase, just condensed into one
    // step — this keeps a real batch and a real purchase record behind the
    // stock (fully traceable, viewable later in Purchases), rather than a bare
    // stock bump with no cost or paper trail.
    const { data: purchase, error: purchaseErr } = await supabase
      .from('purchases')
      .insert({ purchase_date: today(), supplier: 'Quick receive (from Sales)' })
      .select()
      .single()

    if (purchaseErr) {
      setQuickReceiveError(purchaseErr.message)
      setQuickReceiveSaving(false)
      return
    }

    const { error: lineErr } = await supabase.from('purchase_lines').insert({
      purchase_id: purchase.id,
      product_id: lineForm.product_id,
      quantity: Number(quickReceiveForm.quantity),
      unit_cost: Number(quickReceiveForm.unit_cost),
      expiration_date: quickReceiveForm.expiration_date || null,
    })

    if (lineErr) {
      setQuickReceiveError(lineErr.message)
      setQuickReceiveSaving(false)
      return
    }

    const { error: postErr } = await supabase.from('purchases').update({ status: 'posted' }).eq('id', purchase.id)

    setQuickReceiveSaving(false)
    if (postErr) {
      setQuickReceiveError(postErr.message)
      return
    }

    setQuickReceiveOpen(false)
    setLineWarning('')
  }

  const runningTotal = useMemo(
    () => pendingLines.reduce((sum, l) => sum + l.line_total, 0),
    [pendingLines]
  )
  const runningProfit = useMemo(
    () => pendingLines.reduce((sum, l) => sum + l.gross_profit, 0),
    [pendingLines]
  )
  const runningDiscount = useMemo(
    () => pendingLines.reduce((sum, l) => sum + (l.discount_amount ?? 0) + (l.vat_exempt_amount ?? 0), 0),
    [pendingLines]
  )
  const runningSeniorPwdDiscount = useMemo(
    () =>
      pendingLines
        .filter((l) => l.is_discounted)
        .reduce((sum, l) => sum + (l.discount_amount ?? 0) + (l.vat_exempt_amount ?? 0), 0),
    [pendingLines]
  )
  const runningVatExempt = useMemo(
    () => pendingLines.filter((l) => l.is_discounted).reduce((sum, l) => sum + (l.vat_exempt_amount ?? 0), 0),
    [pendingLines]
  )
  const runningB1t1Discount = useMemo(
    () => pendingLines.filter((l) => l.is_b1t1).reduce((sum, l) => sum + (l.discount_amount ?? 0), 0),
    [pendingLines]
  )

  async function completeSale() {
    if (pendingLines.length === 0) {
      setErrorMsg('Add at least one line before completing the sale.')
      return
    }
    setSaving(true)
    setErrorMsg('')

    // Combines the picked date with right-now's time-of-day, so a backdated
    // entry (e.g. catching up on yesterday's sales) gets a sensible timestamp
    // instead of landing at exactly midnight.
    const now = new Date()
    const [year, month, day] = headerForm.sale_date.split('-').map(Number)
    let saleDateTime = new Date(year, month - 1, day, now.getHours(), now.getMinutes(), now.getSeconds())
    // Reports and exports group sales by the calendar date of the stored UTC
    // timestamp. Entering a sale for date D early in the morning local time
    // (before 8 AM in the Philippines) would store it as D-1 in UTC and
    // silently put it on the wrong day — so in that case, use midday instead.
    if (saleDateTime.toISOString().slice(0, 10) !== headerForm.sale_date) {
      saleDateTime = new Date(year, month - 1, day, 12, 0, 0)
    }

    const { data: sale, error: saleErr } = await supabase
      .from('sales')
      .insert({
        sale_date: saleDateTime.toISOString(),
        pos_terminal: headerForm.pos_terminal.trim() || null,
        cashier: headerForm.cashier.trim() || null,
        total_amount: runningTotal,
      })
      .select()
      .single()

    if (saleErr) {
      setErrorMsg(saleErr.message)
      setSaving(false)
      return
    }

    for (const line of pendingLines) {
      const { data: saleLine, error: lineErr } = await supabase
        .from('sale_lines')
        .insert({
          sale_id: sale.id,
          product_id: line.product_id,
          quantity: line.quantity,
          unit_price: line.unit_price,
          fifo_cost: line.fifo_cost,
          gross_profit: line.gross_profit,
          is_discounted: line.is_discounted ?? false,
          is_b1t1: line.is_b1t1 ?? false,
          b1t1_price: line.b1t1_price ?? null,
          discount_amount: line.discount_amount ?? 0,
          vat_exempt_amount: line.vat_exempt_amount ?? null,
        })
        .select()
        .single()

      if (lineErr) {
        setErrorMsg(`Sale created but a line failed to save: ${lineErr.message}. Check ${sale.sale_number} manually.`)
        setSaving(false)
        loadSales()
        return
      }

      const ledgerRows = line.consumption.map((c) => ({
        product_id: c.product_id ?? line.product_id,
        batch_id: c.batch_id,
        transaction_type: 'Sale',
        quantity_change: -c.qty,
        unit_cost_at_transaction: c.unit_cost,
        source_module: 'Sales',
        source_reference_id: saleLine.id,
        occurred_at: saleDateTime.toISOString(),
      }))

      // The oversold portion of a line (sold beyond what any batch actually
      // had) gets its own batch-less ledger entry — this is what makes the
      // shortfall real, visible negative stock instead of silently vanishing.
      if (line.isOversold && line.openQty > 0) {
        const product = products.find((p) => p.id === line.product_id)
        ledgerRows.push({
          product_id: line.product_id,
          batch_id: null,
          transaction_type: 'Sale',
          quantity_change: -line.openQty,
          unit_cost_at_transaction: Number(product?.current_cost ?? 0),
          source_module: 'Sales',
          source_reference_id: saleLine.id,
          remarks: 'Oversold — sold beyond available stock',
          occurred_at: saleDateTime.toISOString(),
        })
      }

      const { error: ledgerErr } = await supabase.from('inventory_ledger').insert(ledgerRows)
      if (ledgerErr) {
        setErrorMsg(`Sale created but inventory wasn't fully updated: ${ledgerErr.message}. Check ${sale.sale_number} manually.`)
        setSaving(false)
        loadSales()
        return
      }
    }

    setSaving(false)
    loadSales()

    if (dateImportQueue.length > 0) {
      const [next, ...rest] = dateImportQueue
      setDateImportQueue(rest)
      setPendingLines([])
      setLineForm(EMPTY_LINE_FORM)
      setPosReportValidationWarning(null)
      await startDateGroupImport(next)
    } else {
      setPanelOpen(false)
      setDateImportQueueTotal(0)
    }
  }

  // Reverses the stock a sale took and marks it voided. Ledger entries are found
  // two ways: through the lines currently on the sale, and by timestamp for
  // entries whose line has since been deleted — Edit discounted qty and Split
  // at different price can remove a line outright, and without the second
  // pass that line's stock would never be given back. (Every sale's ledger
  // entries are stamped with the sale's own timestamp.)
  async function performVoid(sale, lines) {
    const chunk = (arr, n) => {
      const out = []
      for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
      return out
    }
    const lineIds = lines.map((l) => l.id)
    const lineIdSet = new Set(lineIds)

    let originalLedgerRows = []
    for (const ids of chunk(lineIds, 50)) {
      const { data, error } = await supabase
        .from('inventory_ledger')
        .select('*')
        .in('source_reference_id', ids)
        .eq('transaction_type', 'Sale')
      if (error) throw error
      originalLedgerRows = originalLedgerRows.concat(data ?? [])
    }

    // Skip lines that were already reversed — a void that wrote its reversal
    // rows but failed before marking the sale voided, then got retried, would
    // otherwise give the same stock back twice.
    if (originalLedgerRows.length > 0) {
      const reversedRefs = new Set()
      const refs = [...new Set(originalLedgerRows.map((r) => r.source_reference_id))]
      for (const ids of chunk(refs, 50)) {
        const { data, error } = await supabase
          .from('inventory_ledger')
          .select('source_reference_id')
          .in('source_reference_id', ids)
          .eq('transaction_type', 'Void')
        if (error) throw error
        for (const r of data ?? []) reversedRefs.add(r.source_reference_id)
      }
      originalLedgerRows = originalLedgerRows.filter((r) => !reversedRefs.has(r.source_reference_id))
    }

    // Entries stamped with this sale's timestamp that no current line owns.
    // Skipped if they belong to a line that still exists (a different sale
    // that happens to share the exact same second) or were already reversed.
    const { data: stamped, error: stampErr } = await supabase
      .from('inventory_ledger')
      .select('*')
      .eq('transaction_type', 'Sale')
      .eq('source_module', 'Sales')
      .eq('occurred_at', sale.sale_date)
    if (stampErr) throw stampErr
    const candidates = (stamped ?? []).filter((r) => !lineIdSet.has(r.source_reference_id))
    let stranded = []
    if (candidates.length > 0) {
      const refs = [...new Set(candidates.map((r) => r.source_reference_id))]
      const existingLineRefs = new Set()
      const alreadyReversedRefs = new Set()
      for (const ids of chunk(refs, 50)) {
        const { data: found, error: e1 } = await supabase.from('sale_lines').select('id').in('id', ids)
        if (e1) throw e1
        for (const r of found ?? []) existingLineRefs.add(r.id)
        const { data: reversed, error: e2 } = await supabase
          .from('inventory_ledger')
          .select('source_reference_id')
          .in('source_reference_id', ids)
          .eq('transaction_type', 'Void')
        if (e2) throw e2
        for (const r of reversed ?? []) alreadyReversedRefs.add(r.source_reference_id)
      }
      stranded = candidates.filter(
        (r) => !existingLineRefs.has(r.source_reference_id) && !alreadyReversedRefs.has(r.source_reference_id)
      )
    }

    const reversalRows = [...originalLedgerRows, ...stranded].map((row) => ({
      product_id: row.product_id,
      batch_id: row.batch_id,
      transaction_type: 'Void',
      quantity_change: -row.quantity_change, // flips the original negative back to positive
      unit_cost_at_transaction: row.unit_cost_at_transaction,
      source_module: 'Sales',
      source_reference_id: row.source_reference_id,
      remarks: `Reversal of voided sale ${sale.sale_number}`,
    }))

    if (reversalRows.length > 0) {
      const { error: insErr } = await supabase.from('inventory_ledger').insert(reversalRows)
      if (insErr) throw insErr
    }

    const { data: updated, error: updErr } = await supabase
      .from('sales')
      .update({ status: 'voided' })
      .eq('id', sale.id)
      .select()
      .single()
    if (updErr) throw updErr
    return updated
  }

  async function voidSale() {
    if (!confirm(`Void ${viewedSale.sale_number}? This restores the stock it sold — the record stays, it doesn't get deleted.`)) {
      return
    }
    setSaving(true)
    setErrorMsg('')
    try {
      const updated = await performVoid(viewedSale, viewedLines)
      setViewedSale(updated)
      loadSales()
    } catch (err) {
      setErrorMsg(err.message ?? String(err))
    }
    setSaving(false)
  }

  // Voids every ticked sale, one at a time, each with the same routine as the
  // single Void button. One failing doesn't stop the rest, and any that fail
  // stay posted — safe to tick and try again, since a void never reverses the
  // same stock twice.
  async function voidSelectedSales() {
    const targets = selectedVisibleSales
    if (targets.length === 0) return
    const total = targets.reduce((sum, s) => sum + Number(s.total_amount ?? 0), 0)
    const listed =
      targets.slice(0, 8).map((s) => s.sale_number).join(', ') +
      (targets.length > 8 ? `, and ${targets.length - 8} more` : '')
    if (
      !confirm(
        `Void ${targets.length} sale${targets.length === 1 ? '' : 's'}?\n\n${listed}\n\nTotal ₱${total.toFixed(2)}. This restores the stock they sold — the records stay, nothing is deleted. It can't be undone from here.`
      )
    ) {
      return
    }
    if (targets.length > 10) {
      const typed = prompt(`You're about to void ${targets.length} sales. Type VOID to confirm.`)
      if (String(typed ?? '').trim().toUpperCase() !== 'VOID') return
    }

    async function fetchLineIds(saleId) {
      const pageSize = 1000
      let all = []
      let from = 0
      while (true) {
        const { data, error } = await supabase
          .from('sale_lines')
          .select('id')
          .eq('sale_id', saleId)
          .order('id', { ascending: true })
          .range(from, from + pageSize - 1)
        if (error) throw error
        all = all.concat(data ?? [])
        if (!data || data.length < pageSize) break
        from += pageSize
      }
      return all
    }

    setBulkVoidBusy(true)
    setBulkVoidMsg('')
    const failed = []
    let done = 0
    for (let i = 0; i < targets.length; i++) {
      const sale = targets[i]
      setBulkVoidMsg(`Voiding ${i + 1} of ${targets.length} (${sale.sale_number})…`)
      try {
        const lines = await fetchLineIds(sale.id)
        await performVoid(sale, lines)
        done++
      } catch (err) {
        failed.push(`${sale.sale_number} (${err.message ?? err})`)
      }
    }
    await loadSales()
    setSelectedSaleIds([])
    setBulkVoidBusy(false)
    setBulkVoidMsg(
      `Voided ${done} of ${targets.length} sale${targets.length === 1 ? '' : 's'}.` +
        (failed.length > 0 ? ` Couldn't void: ${failed.join('; ')}. Those are still posted — you can tick them and try again.` : '')
    )
  }

  // Redo one day's sale from its POS report. A posted sale is voided first
  // (stock restored, record kept) so the new import picks its batches from
  // the restored stock — importing first would attribute the wrong batches.
  // Then a new sale opens locked to the same day and terminal.
  async function startReimport() {
    if (!viewedSale) return
    const sale = viewedSale
    const d = new Date(sale.sale_date)
    const pad = (n) => String(n).padStart(2, '0')
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    const terminal = sale.pos_terminal ? String(sale.pos_terminal).trim() : null
    const label = `${sale.sale_number} (${day}${terminal ? `, POS ${terminal}` : ''})`

    if (sale.status === 'posted') {
      if (
        !confirm(
          `Reimport ${label}?\n\nThis voids ${sale.sale_number} first — the stock it sold is restored and the record stays — then opens a new sale for ${day} so you can import the POS report again.\n\nUntil you finish the new import, that day has no active sale for this terminal.`
        )
      ) {
        return
      }
      setSaving(true)
      setErrorMsg('')
      try {
        await performVoid(sale, viewedLines)
      } catch (err) {
        setErrorMsg(`Could not void ${sale.sale_number}: ${err.message ?? err}`)
        setSaving(false)
        return
      }
      setSaving(false)
      loadSales()
    }

    openNewPrefilled(
      { pos_terminal: terminal ?? '', cashier: sale.cashier ?? '', sale_date: day },
      { date: day, terminal, saleNumber: sale.sale_number }
    )
  }

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold">Sales</h1>
          <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
            Each line draws from the oldest available batch first (FIFO) and deducts from Inventory immediately.
          </p>
        </div>
        <button
          onClick={openNew}
          className="flex items-center gap-1.5 rounded-md bg-[var(--color-ink)] px-3.5 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          <Plus size={16} />
          New sale
        </button>
      </div>

      {errorMsg && !panelOpen && (
        <div className="mb-4 rounded-md bg-[var(--color-rust-soft)] px-3.5 py-2.5 text-sm text-[var(--color-rust)]">
          {errorMsg}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-3.5 py-3">
        <div className="text-sm font-medium">Download sales</div>
        <label className="text-xs font-medium text-[var(--color-ink-soft)]">
          From
          <input
            type="date"
            value={exportFrom}
            onChange={(e) => setExportFrom(e.target.value)}
            className="input mt-0.5 block"
          />
        </label>
        <label className="text-xs font-medium text-[var(--color-ink-soft)]">
          To
          <input
            type="date"
            value={exportTo}
            onChange={(e) => setExportTo(e.target.value)}
            className="input mt-0.5 block"
          />
        </label>
        <label className="flex items-center gap-1.5 pb-2 text-xs text-[var(--color-ink-soft)]">
          <input
            type="checkbox"
            checked={exportIncludeVoided}
            onChange={(e) => setExportIncludeVoided(e.target.checked)}
          />
          Include voided
        </label>
        <button
          onClick={downloadSalesExport}
          disabled={exportBusy}
          className="flex items-center gap-1.5 rounded-md border border-[var(--color-line)] px-3 py-2 text-sm font-medium hover:bg-[var(--color-paper)] disabled:opacity-40"
        >
          <FileDown size={15} />
          {exportBusy ? 'Preparing…' : 'Download CSV'}
        </button>
        {exportMsg && <div className="basis-full text-xs text-[var(--color-ink-soft)]">{exportMsg}</div>}
      </div>

      <SearchBar value={search} onChange={setSearch} placeholder="Search by sale #, terminal, or cashier" />

      {(selectedVisibleSales.length > 0 || bulkVoidMsg) && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-3.5 py-2.5 text-sm">
          {selectedVisibleSales.length > 0 && (
            <>
              <span className="font-medium">
                {selectedVisibleSales.length} selected · ₱
                {selectedVisibleSales.reduce((sum, s) => sum + Number(s.total_amount ?? 0), 0).toFixed(2)}
              </span>
              <button
                onClick={voidSelectedSales}
                disabled={bulkVoidBusy}
                className="flex items-center gap-1.5 rounded-md border border-[var(--color-rust)] px-3 py-1.5 text-sm font-medium text-[var(--color-rust)] disabled:opacity-60"
              >
                <Ban size={14} />
                {bulkVoidBusy ? 'Voiding…' : 'Void selected'}
              </button>
              <button
                onClick={() => setSelectedSaleIds([])}
                disabled={bulkVoidBusy}
                className="text-xs text-[var(--color-ink-soft)] underline disabled:opacity-50"
              >
                Clear selection
              </button>
            </>
          )}
          {bulkVoidMsg && <span className="basis-full text-xs text-[var(--color-ink-soft)]">{bulkVoidMsg}</span>}
        </div>
      )}

      <div className="overflow-hidden rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)]">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[var(--color-line)] text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
            <tr>
              <th className="w-10 px-4 py-3">
                <input
                  type="checkbox"
                  checked={allVotableSelected}
                  onChange={toggleAllVotable}
                  disabled={bulkVoidBusy || votableSales.length === 0}
                  title="Select every posted sale shown below"
                  aria-label="Select all posted sales shown"
                />
              </th>
              <SortableTh label="Sale #" sortKey="sale_number" activeKey={saleSortKey} activeDir={saleSortDir} onSort={toggleSaleSort} />
              <SortableTh label="Date" sortKey="sale_date" activeKey={saleSortKey} activeDir={saleSortDir} onSort={toggleSaleSort} />
              <SortableTh label="Terminal" sortKey="pos_terminal" activeKey={saleSortKey} activeDir={saleSortDir} onSort={toggleSaleSort} />
              <SortableTh label="Cashier" sortKey="cashier" activeKey={saleSortKey} activeDir={saleSortDir} onSort={toggleSaleSort} />
              <SortableTh label="Total" sortKey="total_amount" activeKey={saleSortKey} activeDir={saleSortDir} onSort={toggleSaleSort} />
              <SortableTh label="Status" sortKey="status" activeKey={saleSortKey} activeDir={saleSortDir} onSort={toggleSaleSort} />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-[var(--color-ink-soft)]">
                  Loading sales…
                </td>
              </tr>
            )}
            {!loading && searchedSales.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-[var(--color-ink-soft)]">
                  No sales yet — record one to see it deduct from Inventory.
                </td>
              </tr>
            )}
            {searchedSales.map((s) => (
              <tr
                key={s.id}
                onClick={() => openView(s)}
                className="cursor-pointer border-b border-[var(--color-line)] last:border-0 hover:bg-[var(--color-paper)]"
              >
                <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                  {s.status === 'posted' && (
                    <input
                      type="checkbox"
                      checked={selectedSaleIdSet.has(s.id)}
                      onChange={() => toggleSaleSelected(s.id)}
                      disabled={bulkVoidBusy}
                      aria-label={`Select ${s.sale_number}`}
                    />
                  )}
                </td>
                <td className="font-mono px-4 py-3 text-xs text-[var(--color-ink-soft)]">{s.sale_number}</td>
                <td className="px-4 py-3">{new Date(s.sale_date).toLocaleString()}</td>
                <td className="px-4 py-3 text-[var(--color-ink-soft)]">{s.pos_terminal || '—'}</td>
                <td className="px-4 py-3 text-[var(--color-ink-soft)]">{s.cashier || '—'}</td>
                <td className="px-4 py-3">{Number(s.total_amount).toFixed(2)}</td>
                <td className="px-4 py-3">
                  <StatusChip tone={statusTone(s.status)}>{s.status}</StatusChip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <SlidePanel
        open={panelOpen}
        title={mode === 'new' ? 'New sale' : viewedSale?.sale_number}
        onClose={() => {
          setPanelOpen(false)
          setDateImportQueue([])
          setDateImportQueueTotal(0)
        }}
        size="xl"
      >
        {errorMsg && (
          <div className="mb-4 rounded-md bg-[var(--color-rust-soft)] px-3.5 py-2.5 text-sm text-[var(--color-rust)]">
            {errorMsg}
          </div>
        )}

        {mode === 'new' ? (
          <div>
            {reimportContext && (
              <div className="mb-4 rounded-md bg-[var(--color-amber-soft)] px-3.5 py-2.5 text-sm text-[var(--color-amber)]">
                Reimporting {reimportContext.saleNumber} — {reimportContext.date}
                {reimportContext.terminal ? `, POS ${reimportContext.terminal}` : ''}. {reimportContext.saleNumber} is voided and its
                stock restored. Import the POS report for that day below — only a file for that date
                {reimportContext.terminal ? ' and terminal' : ''} will be accepted. Closing this without completing leaves that day
                with no active sale.
              </div>
            )}
            {dateImportQueueTotal > 1 && (
              <div className="mb-4 rounded-md bg-[var(--color-amber-soft)] px-3.5 py-2.5 text-sm text-[var(--color-amber)]">
                Sale {dateImportQueueTotal - dateImportQueue.length} of {dateImportQueueTotal} from this import — completing this one will automatically open the next date.
              </div>
            )}
            {isBackfillSale && (
              <div className="mb-4 rounded-md bg-[var(--color-herb-soft)] px-3.5 py-2.5 text-sm text-[var(--color-herb)]">
                Backfilled sale — before {inventoryTrackingStartDate}, so this records revenue for Reports and Analytics only. No stock, batches, or the Negative Stock tab are affected, and cost is approximated from today's cost since real historical cost isn't available.
              </div>
            )}
            <div className="mb-4 grid grid-cols-2 gap-3">
              <Field label="Sale date" required>
                <input
                  type="date"
                  required
                  max={today()}
                  value={headerForm.sale_date}
                  onChange={(e) => setHeaderForm({ ...headerForm, sale_date: e.target.value })}
                  disabled={Boolean(reimportContext)}
                  className="input"
                />
              </Field>
              <Field label="POS terminal">
                <input
                  value={headerForm.pos_terminal}
                  onChange={(e) => setHeaderForm({ ...headerForm, pos_terminal: e.target.value })}
                  className="input"
                />
              </Field>
              <Field label="Cashier">
                <input
                  value={headerForm.cashier}
                  onChange={(e) => setHeaderForm({ ...headerForm, cashier: e.target.value })}
                  className="input"
                />
              </Field>
            </div>

            <div className="mb-3 text-xs font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">
              Line items
            </div>

            <div className="mb-4 max-h-[50vh] overflow-auto rounded-md border border-[var(--color-line)]">
              <table className="w-full whitespace-nowrap text-left text-sm">
                <thead className="sticky top-0 border-b border-[var(--color-line)] bg-[var(--color-paper-raised)] text-xs text-[var(--color-ink-soft)]">
                  <tr>
                    <th className="px-3 py-2">Product</th>
                    <th className="px-3 py-2">Category</th>
                    <th className="px-3 py-2">Qty</th>
                    <th className="px-3 py-2">Price</th>
                    <th className="px-3 py-2">Total</th>
                    <th className="px-3 py-2">Profit</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {pendingLines.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-3 py-5 text-center text-[var(--color-ink-soft)]">
                        No lines yet.
                      </td>
                    </tr>
                  )}
                  {pendingLines.map((l) => (
                    <Fragment key={l.tempId}>
                    <tr className="border-b border-[var(--color-line)] last:border-0">
                      <td className="px-3 py-2">
                        {l.product_name}
                        {l.isOversold ? (
                          <span
                            title="Sold beyond what was actually in stock — this product will show negative until corrected in the Negative Stock tab"
                            className="ml-1.5 rounded-full bg-[var(--color-rust-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-rust)]"
                          >
                            {l.openQty} oversold
                          </span>
                        ) : (
                          l.openQty > 0 && (
                            <span
                              title="Consumed whatever real stock exists, rest costed at current cost — this item never blocks a sale"
                              className="ml-1.5 rounded-full bg-[var(--color-amber-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-amber)]"
                            >
                              {l.openQty} open
                            </span>
                          )
                        )}
                        {l.is_discounted && (
                          <span
                            title={`Senior/PWD — ₱${(l.discount_amount + (l.vat_exempt_amount ?? 0)).toFixed(2)} off (₱${(l.vat_exempt_amount ?? 0).toFixed(2)} VAT exempt + ₱${l.discount_amount.toFixed(2)} discount)`}
                            className="ml-1.5 rounded-full bg-[var(--color-herb-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-herb)]"
                          >
                            discounted
                          </span>
                        )}
                        {l.splitOff && (
                          <span
                            title="Split off from another line at a different price — the units and their cost came out of that line, so quantity and stock are unchanged"
                            className="ml-1.5 rounded-full bg-[var(--color-amber-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-amber)]"
                          >
                            split price
                          </span>
                        )}
                        {l.is_b1t1 && (
                          <span
                            title={`Buy 1 Take 1 — ₱${Number(l.b1t1_price).toFixed(2)} per set, ₱${l.discount_amount.toFixed(2)} given away`}
                            className="ml-1.5 rounded-full bg-[var(--color-herb-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-herb)]"
                          >
                            B1T1
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-[var(--color-ink-soft)]">{l.category || '—'}</td>
                      <td className="px-3 py-2">{l.quantity} {l.unit}</td>
                      <td className="px-3 py-2">{l.unit_price.toFixed(2)}</td>
                      <td className="px-3 py-2">{l.line_total.toFixed(2)}</td>
                      <td className="px-3 py-2 text-[var(--color-herb)]">{l.gross_profit.toFixed(2)}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1">
                          {!l.is_b1t1 && Number(l.quantity) > 1 && (
                            <button
                              onClick={() => startSplitPending(l)}
                              className="mr-1 text-xs font-medium text-[var(--color-ink-soft)] underline"
                            >
                              Split price
                            </button>
                          )}
                          <button
                            onClick={() => startEditLine(l)}
                            aria-label="Edit line"
                            className="rounded-md p-1 text-[var(--color-ink-soft)] hover:bg-[var(--color-line)]"
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            onClick={() => removeLine(l.tempId)}
                            aria-label="Remove line"
                            className="rounded-md p-1 text-[var(--color-ink-soft)] hover:bg-[var(--color-line)]"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                    {splitPendingId === l.tempId && (
                      <tr className="border-b border-[var(--color-line)] bg-[var(--color-paper)]">
                        <td colSpan={7} className="px-3 py-3">
                          <div className="flex flex-wrap items-end gap-2 text-sm">
                            <label className="text-xs font-medium text-[var(--color-ink-soft)]">
                              Qty to split off (of {l.quantity})
                              <input
                                type="number"
                                step="1"
                                min="1"
                                max={Number(l.quantity) - 1}
                                value={splitPendingQty}
                                onChange={(e) => setSplitPendingQty(e.target.value)}
                                className="input mt-0.5 block w-32"
                              />
                            </label>
                            <label className="text-xs font-medium text-[var(--color-ink-soft)]">
                              New price
                              <input
                                type="number"
                                step="0.01"
                                value={splitPendingPrice}
                                onChange={(e) => setSplitPendingPrice(e.target.value)}
                                className="input mt-0.5 block w-32"
                              />
                            </label>
                            <button
                              onClick={() => confirmSplitPending(l)}
                              disabled={!splitPendingQty || !splitPendingPrice}
                              className="rounded-md bg-[var(--color-ink)] px-3 py-1.5 text-xs font-medium text-[var(--color-paper)] disabled:opacity-40"
                            >
                              Split
                            </button>
                            <button
                              onClick={cancelSplitPending}
                              className="rounded-md border border-[var(--color-line)] px-3 py-1.5 text-xs"
                            >
                              Cancel
                            </button>
                          </div>
                          {Number(splitPendingQty) > 0 && Number(splitPendingQty) < Number(l.quantity) && Number(splitPendingPrice) > 0 && (
                            <p className="mt-1.5 text-xs text-[var(--color-ink-soft)]">
                              {Number(l.quantity) - Number(splitPendingQty)} × ₱{Number(l.unit_price).toFixed(2)} +{' '}
                              {Number(splitPendingQty)} × ₱{Number(splitPendingPrice).toFixed(2)} = ₱
                              {(
                                (Number(l.quantity) - Number(splitPendingQty)) * Number(l.unit_price) +
                                Number(splitPendingQty) * Number(splitPendingPrice)
                              ).toFixed(2)}{' '}
                              for the line (was ₱{Number(l.line_total).toFixed(2)})
                            </p>
                          )}
                          <p className="mt-1.5 text-xs text-[var(--color-ink-soft)]">
                            The split-off units become their own line at the new price; the rest stay as they are. The
                            stock behind this line is divided between the two in FIFO order, so total quantity and
                            inventory don't change.
                          </p>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  ))}
                </tbody>
                <tfoot className="sticky bottom-0 bg-[var(--color-paper-raised)]">
                  <tr className="border-t border-[var(--color-line)] font-medium">
                    <td colSpan={4} className="px-3 py-2 text-right text-[var(--color-ink-soft)]">Total</td>
                    <td className="px-3 py-2">{runningTotal.toFixed(2)}</td>
                    <td className="px-3 py-2 text-[var(--color-herb)]">{runningProfit.toFixed(2)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>

            {runningDiscount > 0 && (
              <div className="mb-4 rounded-md bg-[var(--color-herb-soft)] px-3 py-2 text-xs text-[var(--color-herb)]">
                Discounts this sale: ₱{runningDiscount.toFixed(2)} — factor this into remittance, since it's a real reduction from gross.
                {runningSeniorPwdDiscount > 0 && (
                  <>
                    {' '}
                    (Senior/PWD ₱{runningSeniorPwdDiscount.toFixed(2)} — ₱{runningVatExempt.toFixed(2)} VAT exempt + ₱
                    {(runningSeniorPwdDiscount - runningVatExempt).toFixed(2)} discount)
                  </>
                )}
                {runningB1t1Discount > 0 && <> · Buy 1 Take 1 ₱{runningB1t1Discount.toFixed(2)}</>}
              </div>
            )}

            <div className="mb-3 flex gap-2">
              <button
                type="button"
                onClick={handleDownloadSalesLineTemplate}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-[var(--color-line)] py-2 text-sm font-medium hover:bg-[var(--color-paper)]"
              >
                <FileDown size={15} />
                Template
              </button>
              <button
                type="button"
                onClick={handleImportClick}
                disabled={importParsing}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-[var(--color-line)] py-2 text-sm font-medium hover:bg-[var(--color-paper)] disabled:opacity-60"
              >
                <Upload size={15} />
                {importParsing ? 'Checking stock…' : 'Import a day\'s sales CSV'}
              </button>
              <input ref={importFileInputRef} type="file" accept=".csv" onChange={handleImportFileChange} className="hidden" />
              <button
                type="button"
                onClick={handlePosReportImportClick}
                disabled={importParsing}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-[var(--color-line)] py-2 text-sm font-medium hover:bg-[var(--color-paper)] disabled:opacity-60"
              >
                <Upload size={15} />
                {importParsing ? 'Checking stock…' : 'Import POS report(s) (.xls)'}
              </button>
              <input
                ref={posReportFileInputRef}
                type="file"
                accept=".xls,.xlsx"
                multiple
                onChange={handlePosReportFileChange}
                className="hidden"
              />
            </div>
            <p className="mb-3 text-xs text-[var(--color-ink-soft)]">
              Select both terminals' files together (Ctrl/Cmd-click, or shift-click) to combine them into one sale — they need to be the same date.
            </p>

            <form onSubmit={handleAddLine} className="mb-5 space-y-3 rounded-md border border-dashed border-[var(--color-line)] p-3">
              <Field label="Product" required>
                <ProductPicker
                  products={activeProducts}
                  value={lineForm.product_id}
                  onChange={onProductPick}
                />
              </Field>
              <label className="flex items-center gap-2 text-xs font-medium text-[var(--color-ink-soft)]">
                <input
                  type="checkbox"
                  checked={b1t1Mode}
                  onChange={(e) => {
                    const checked = e.target.checked
                    setB1t1Mode(checked)
                    setPriceMismatch(null)
                    setDiscountMode(false)
                    setDiscountQtyDraft('')
                    setLineWarning('')
                    if (checked) {
                      const p = products.find((x) => x.id === lineForm.product_id)
                      setB1t1PriceDraft(p?.selling_price != null ? String(p.selling_price) : '')
                    } else {
                      setB1t1PriceDraft('')
                    }
                  }}
                />
                Buy 1 Take 1 (near-expiry)
              </label>
              <div className="grid grid-cols-2 gap-3">
                <Field label={b1t1Mode ? 'Quantity (units, even)' : 'Quantity'} required>
                  <input
                    type="number"
                    step={b1t1Mode ? '2' : '0.001'}
                    min="0"
                    required
                    value={lineForm.quantity}
                    onChange={(e) => setLineForm({ ...lineForm, quantity: e.target.value })}
                    className="input"
                  />
                </Field>
                {b1t1Mode ? (
                  <Field label="Price per set" required>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      required
                      value={b1t1PriceDraft}
                      onChange={(e) => setB1t1PriceDraft(e.target.value)}
                      className="input"
                    />
                  </Field>
                ) : (
                  <Field label="Unit price" required>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      required
                      value={lineForm.unit_price}
                      onChange={(e) => setLineForm({ ...lineForm, unit_price: e.target.value })}
                      className="input"
                    />
                  </Field>
                )}
              </div>
              {b1t1Mode && lineForm.quantity && b1t1PriceDraft && Number(lineForm.quantity) % 2 === 0 && (
                <p className="text-xs text-[var(--color-ink-soft)]">
                  = {Number(lineForm.quantity) / 2} set(s) × ₱{Number(b1t1PriceDraft).toFixed(2)} = ₱
                  {((Number(lineForm.quantity) / 2) * Number(b1t1PriceDraft)).toFixed(2)} collected
                </p>
              )}
              {lineWarning && (
                <div className="rounded-md bg-[var(--color-amber-soft)] px-3 py-2 text-xs text-[var(--color-amber)]">
                  <div className="flex items-start gap-1.5">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                    {lineWarning}
                  </div>
                  {!quickReceiveOpen && (
                    <button
                      type="button"
                      onClick={openQuickReceive}
                      className="mt-1.5 font-medium underline underline-offset-2"
                    >
                      Receive stock now
                    </button>
                  )}
                </div>
              )}

              {priceMismatch && (
                <div className="space-y-2 rounded-md bg-[var(--color-amber-soft)] p-3 text-xs">
                  <div className="flex items-start gap-1.5 text-[var(--color-amber)]">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                    This is ₱{priceMismatch.givenPrice.toFixed(2)}, but the recorded price is ₱{priceMismatch.recordedPrice.toFixed(2)}.
                  </div>
                  {!discountMode ? (
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={handleUpdatePriceAndAdd}
                        className="rounded-md border border-[var(--color-ink)] px-2.5 py-1.5 font-medium"
                      >
                        Update price to ₱{priceMismatch.givenPrice.toFixed(2)}
                      </button>
                      <button
                        type="button"
                        onClick={handleUseOnceAndAdd}
                        title="Use this price for this sale only — the product's current recorded price stays unchanged. For backlog entries where the price was accurate on that date but has since changed."
                        className="rounded-md border border-[var(--color-ink)] px-2.5 py-1.5 font-medium"
                      >
                        Use ₱{priceMismatch.givenPrice.toFixed(2)} for this sale only
                      </button>
                      <button
                        type="button"
                        onClick={() => setDiscountMode(true)}
                        className="rounded-md border border-[var(--color-ink)] px-2.5 py-1.5 font-medium"
                      >
                        Mark as discounted
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-end gap-2">
                      <label className="block">
                        <span className="mb-1 block text-[var(--color-ink-soft)]">
                          Discounted qty (out of {lineForm.quantity})
                        </span>
                        <input
                          type="number" min="1" max={lineForm.quantity} step="1"
                          value={discountQtyDraft}
                          onChange={(e) => setDiscountQtyDraft(e.target.value)}
                          className="input w-28"
                        />
                      </label>
                      <button
                        type="button"
                        onClick={handleConfirmDiscountSplit}
                        className="rounded-md bg-[var(--color-ink)] px-2.5 py-1.5 font-medium text-white"
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        onClick={() => setDiscountMode(false)}
                        className="text-[var(--color-ink-soft)] underline underline-offset-2"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              )}

              {quickReceiveOpen && (
                <div className="space-y-3 rounded-md bg-[var(--color-paper)] p-3">
                  <div className="text-xs font-medium text-[var(--color-ink-soft)]">
                    Receive stock — creates a real purchase + batch, same as posting one in Purchases.
                  </div>
                  {quickReceiveError && (
                    <div className="rounded-md bg-[var(--color-rust-soft)] px-2.5 py-1.5 text-xs text-[var(--color-rust)]">
                      {quickReceiveError}
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Quantity received" required>
                      <input
                        type="number" step="0.001" min="0" required
                        value={quickReceiveForm.quantity}
                        onChange={(e) => setQuickReceiveForm({ ...quickReceiveForm, quantity: e.target.value })}
                        className="input"
                      />
                    </Field>
                    <Field label="Unit cost" required>
                      <input
                        type="number" step="0.01" min="0" required
                        value={quickReceiveForm.unit_cost}
                        onChange={(e) => setQuickReceiveForm({ ...quickReceiveForm, unit_cost: e.target.value })}
                        className="input"
                      />
                    </Field>
                  </div>
                  <Field label="Expiration date (optional)">
                    <input
                      type="date"
                      value={quickReceiveForm.expiration_date}
                      onChange={(e) => setQuickReceiveForm({ ...quickReceiveForm, expiration_date: e.target.value })}
                      className="input"
                    />
                  </Field>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={handleQuickReceive}
                      disabled={quickReceiveSaving}
                      className="flex-1 rounded-md bg-[var(--color-ink)] py-2 text-sm font-medium text-white disabled:opacity-60"
                    >
                      {quickReceiveSaving ? 'Receiving…' : 'Receive & continue'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setQuickReceiveOpen(false)}
                      className="rounded-md border border-[var(--color-line)] px-3 text-sm font-medium"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              <button
                type="submit"
                className="flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--color-ink)] py-2 text-sm font-medium"
              >
                <Plus size={15} />
                Add line
              </button>
            </form>

            <button
              onClick={completeSale}
              disabled={saving}
              className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--color-herb)] py-2.5 text-sm font-medium text-white disabled:opacity-60"
            >
              <Check size={15} />
              {saving ? 'Completing…' : 'Complete sale'}
            </button>
          </div>
        ) : (
          <div>
            <div className="mb-4 flex items-center justify-between rounded-md bg-[var(--color-paper)] px-3 py-2.5 text-sm">
              <div className="text-[var(--color-ink-soft)]">
                {viewedSale && new Date(viewedSale.sale_date).toLocaleString()} · {viewedSale?.pos_terminal || 'No terminal'}
              </div>
              <StatusChip tone={statusTone(viewedSale?.status)}>{viewedSale?.status}</StatusChip>
            </div>

            <div className="mb-3 text-xs font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">
              Line items
            </div>

            <div className="mb-5 max-h-[60vh] overflow-auto rounded-md border border-[var(--color-line)]">
              <table className="w-full whitespace-nowrap text-left text-sm">
                <thead className="sticky top-0 border-b border-[var(--color-line)] bg-[var(--color-paper-raised)] text-xs text-[var(--color-ink-soft)]">
                  <tr>
                    <SortableTh label="Product" sortKey="product" activeKey={lineSortKey} activeDir={lineSortDir} onSort={toggleLineSort} />
                    <SortableTh label="Category" sortKey="category" activeKey={lineSortKey} activeDir={lineSortDir} onSort={toggleLineSort} />
                    <SortableTh label="Qty" sortKey="quantity" activeKey={lineSortKey} activeDir={lineSortDir} onSort={toggleLineSort} />
                    <SortableTh label="Price" sortKey="unit_price" activeKey={lineSortKey} activeDir={lineSortDir} onSort={toggleLineSort} />
                    <SortableTh label="FIFO cost" sortKey="fifo_cost" activeKey={lineSortKey} activeDir={lineSortDir} onSort={toggleLineSort} />
                    <SortableTh label="Profit" sortKey="gross_profit" activeKey={lineSortKey} activeDir={lineSortDir} onSort={toggleLineSort} />
                    {viewedSale?.status === 'posted' && <th className="px-3 py-2" />}
                  </tr>
                </thead>
                <tbody>
                  {sortRows(viewedLines, lineSortKey, lineSortDir, (row, key) =>
                    key === 'product' ? row.product?.name : key === 'category' ? row.product?.category : row[key]
                  ).map((l) => (
                    <Fragment key={l.id}>
                      <tr className="border-b border-[var(--color-line)] last:border-0">
                        <td className="px-3 py-2">
                          {l.product?.name}
                          {l.is_discounted && (
                            <span
                              title={`Senior/PWD — ₱${(Number(l.discount_amount) + Number(l.vat_exempt_amount ?? 0)).toFixed(2)} off (₱${Number(l.vat_exempt_amount ?? 0).toFixed(2)} VAT exempt + ₱${Number(l.discount_amount).toFixed(2)} discount)`}
                              className="ml-1.5 rounded-full bg-[var(--color-herb-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-herb)]"
                            >
                              discounted
                            </span>
                          )}
                          {l.is_b1t1 && (
                            <span
                              title={`Buy 1 Take 1 — ₱${Number(l.b1t1_price).toFixed(2)} per set, ₱${Number(l.discount_amount).toFixed(2)} given away`}
                              className="ml-1.5 rounded-full bg-[var(--color-herb-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-herb)]"
                            >
                              B1T1
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-[var(--color-ink-soft)]">{l.product?.category || '—'}</td>
                        <td className="px-3 py-2">{l.quantity} {l.product?.unit}</td>
                        <td className="px-3 py-2">
                          {Number(l.unit_price).toFixed(2)}
                          {l.price_edited_at && (
                            <span
                              title={`Corrected from ₱${Number(l.original_unit_price).toFixed(2)} — ${l.price_edit_reason}`}
                              className="ml-1.5 rounded-full bg-[var(--color-amber-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-amber)]"
                            >
                              edited
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">{Number(l.fifo_cost).toFixed(2)}</td>
                        <td className="px-3 py-2 text-[var(--color-herb)]">{Number(l.gross_profit).toFixed(2)}</td>
                        {viewedSale?.status === 'posted' && (
                          <td className="px-3 py-2">
                            {editingLineId !== l.id && editingDiscountQtyLineId !== l.id && splitPriceLineId !== l.id && (
                              <div className="flex flex-col items-start gap-1">
                                <button
                                  onClick={() => startEditPrice(l)}
                                  className="text-xs font-medium text-[var(--color-ink-soft)] underline"
                                >
                                  Edit price
                                </button>
                                {!l.is_b1t1 && (
                                  <button
                                    onClick={() => startEditDiscountQty(l)}
                                    className="text-xs font-medium text-[var(--color-ink-soft)] underline"
                                  >
                                    Edit discounted qty
                                  </button>
                                )}
                                {!l.is_b1t1 && Number(l.quantity) > 1 && (
                                  <button
                                    onClick={() => startSplitPrice(l)}
                                    className="text-xs font-medium text-[var(--color-ink-soft)] underline"
                                  >
                                    Split at different price
                                  </button>
                                )}
                              </div>
                            )}
                          </td>
                        )}
                      </tr>
                      {editingLineId === l.id && (
                        <tr className="border-b border-[var(--color-line)] bg-[var(--color-paper)]">
                          <td colSpan={7} className="px-3 py-3">
                            <div className="flex flex-wrap items-end gap-2 text-sm">
                              <label className="text-xs font-medium text-[var(--color-ink-soft)]">
                                {l.is_b1t1 ? 'New price per set' : 'New price'}
                                <input
                                  type="number"
                                  step="0.01"
                                  value={editPriceDraft}
                                  onChange={(e) => setEditPriceDraft(e.target.value)}
                                  className="input mt-0.5 block w-32"
                                />
                              </label>
                              <label className="flex-1 text-xs font-medium text-[var(--color-ink-soft)]">
                                Reason (required)
                                <input
                                  value={editReasonDraft}
                                  onChange={(e) => setEditReasonDraft(e.target.value)}
                                  placeholder="e.g. cashier punched the wrong price"
                                  className="input mt-0.5 block w-full"
                                />
                              </label>
                              <button
                                onClick={() => saveEditPrice(l)}
                                disabled={editSaving || !editPriceDraft || !editReasonDraft.trim()}
                                className="rounded-md bg-[var(--color-ink)] px-3 py-1.5 text-xs font-medium text-[var(--color-paper)] disabled:opacity-40"
                              >
                                {editSaving ? 'Saving…' : 'Save'}
                              </button>
                              <button
                                onClick={cancelEditPrice}
                                className="rounded-md border border-[var(--color-line)] px-3 py-1.5 text-xs"
                              >
                                Cancel
                              </button>
                            </div>
                            <p className="mt-1.5 text-xs text-[var(--color-ink-soft)]">
                              Quantity, FIFO cost, and Inventory are never affected — only the price and everything
                              that follows from it (profit{l.is_discounted ? ', the discount/VAT-exempt split,' : ''} etc.).
                            </p>
                          </td>
                        </tr>
                      )}
                      {editingDiscountQtyLineId === l.id && (
                        <tr className="border-b border-[var(--color-line)] bg-[var(--color-paper)]">
                          <td colSpan={7} className="px-3 py-3">
                            <div className="flex flex-wrap items-end gap-2 text-sm">
                              <label className="text-xs font-medium text-[var(--color-ink-soft)]">
                                New discounted qty (of {(() => {
                                  const sibling = viewedLines.find(
                                    (s) =>
                                      s.product_id === l.product_id &&
                                      s.id !== l.id &&
                                      (l.is_discounted ? !s.is_discounted && !s.is_b1t1 : s.is_discounted)
                                  )
                                  return Number(l.quantity) + Number(sibling?.quantity ?? 0)
                                })()} total)
                                <input
                                  type="number"
                                  step="1"
                                  min="0"
                                  value={editDiscountQtyDraft}
                                  onChange={(e) => setEditDiscountQtyDraft(e.target.value)}
                                  className="input mt-0.5 block w-32"
                                />
                              </label>
                              <label className="flex-1 text-xs font-medium text-[var(--color-ink-soft)]">
                                Reason (required)
                                <input
                                  value={editDiscountQtyReason}
                                  onChange={(e) => setEditDiscountQtyReason(e.target.value)}
                                  placeholder="e.g. should have been 2 discounted, not 1"
                                  className="input mt-0.5 block w-full"
                                />
                              </label>
                              <button
                                onClick={() => saveEditDiscountQty(l)}
                                disabled={editDiscountQtySaving || editDiscountQtyDraft === '' || !editDiscountQtyReason.trim()}
                                className="rounded-md bg-[var(--color-ink)] px-3 py-1.5 text-xs font-medium text-[var(--color-paper)] disabled:opacity-40"
                              >
                                {editDiscountQtySaving ? 'Saving…' : 'Save'}
                              </button>
                              <button
                                onClick={cancelEditDiscountQty}
                                className="rounded-md border border-[var(--color-line)] px-3 py-1.5 text-xs"
                              >
                                Cancel
                              </button>
                            </div>
                            <p className="mt-1.5 text-xs text-[var(--color-ink-soft)]">
                              Only moves quantity between the discounted and regular price for this product —
                              the total quantity sold, inventory, and FIFO consumption are never touched. Cost is
                              split between the two by weighted average, not re-traced to specific batches.
                            </p>
                          </td>
                        </tr>
                      )}
                      {splitPriceLineId === l.id && (
                        <tr className="border-b border-[var(--color-line)] bg-[var(--color-paper)]">
                          <td colSpan={7} className="px-3 py-3">
                            <div className="flex flex-wrap items-end gap-2 text-sm">
                              <label className="text-xs font-medium text-[var(--color-ink-soft)]">
                                Qty to split off (of {l.quantity})
                                <input
                                  type="number"
                                  step="1"
                                  min="1"
                                  max={Number(l.quantity) - 1}
                                  value={splitQtyDraft}
                                  onChange={(e) => setSplitQtyDraft(e.target.value)}
                                  className="input mt-0.5 block w-32"
                                />
                              </label>
                              <label className="text-xs font-medium text-[var(--color-ink-soft)]">
                                New price
                                <input
                                  type="number"
                                  step="0.01"
                                  value={splitPriceDraft}
                                  onChange={(e) => setSplitPriceDraft(e.target.value)}
                                  className="input mt-0.5 block w-32"
                                />
                              </label>
                              <label className="flex-1 text-xs font-medium text-[var(--color-ink-soft)]">
                                Reason (required)
                                <input
                                  value={splitReasonDraft}
                                  onChange={(e) => setSplitReasonDraft(e.target.value)}
                                  placeholder="e.g. manager approved a special price for 2 of these"
                                  className="input mt-0.5 block w-full"
                                />
                              </label>
                              <button
                                onClick={() => saveSplitPrice(l)}
                                disabled={splitSaving || !splitQtyDraft || !splitPriceDraft || !splitReasonDraft.trim()}
                                className="rounded-md bg-[var(--color-ink)] px-3 py-1.5 text-xs font-medium text-[var(--color-paper)] disabled:opacity-40"
                              >
                                {splitSaving ? 'Saving…' : 'Save'}
                              </button>
                              <button
                                onClick={cancelSplitPrice}
                                className="rounded-md border border-[var(--color-line)] px-3 py-1.5 text-xs"
                              >
                                Cancel
                              </button>
                            </div>
                            <p className="mt-1.5 text-xs text-[var(--color-ink-soft)]">
                              Creates a new, separate line for the split-off quantity at the new price — the
                              original line's quantity shrinks to match, so the combined total, inventory, and
                              FIFO consumption never change. This is a plain price, not a Senior/PWD discount —
                              use "Edit discounted qty" for that instead.
                            </p>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>

            <button
              onClick={downloadViewedSale}
              className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--color-line)] py-2.5 text-sm font-medium hover:bg-[var(--color-paper)]"
            >
              <FileDown size={15} />
              Download this sale (CSV)
            </button>

            <button
              onClick={startReimport}
              disabled={saving}
              className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--color-line)] py-2.5 text-sm font-medium hover:bg-[var(--color-paper)] disabled:opacity-60"
            >
              <Upload size={15} />
              {viewedSale?.status === 'posted' ? 'Reimport this day (voids this sale first)' : 'Reimport this day'}
            </button>

            {viewedSale?.status === 'posted' && (
              <button
                onClick={voidSale}
                disabled={saving}
                className="flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--color-rust)] py-2.5 text-sm font-medium text-[var(--color-rust)] disabled:opacity-60"
              >
                <Ban size={15} />
                Void sale
              </button>
            )}
            {viewedSale?.status === 'voided' && (
              <p className="text-center text-sm text-[var(--color-ink-soft)]">
                This sale was voided — the stock it sold has been restored.
              </p>
            )}
          </div>
        )}
      </SlidePanel>

      <SlidePanel
        open={importPanelOpen}
        title="Import sale lines"
        onClose={() => setImportPanelOpen(false)}
      >
        {isBackfillSale && (
          <div className="mb-4 rounded-md bg-[var(--color-herb-soft)] px-3.5 py-2.5 text-sm text-[var(--color-herb)]">
            Backfilled sale — before {inventoryTrackingStartDate}, so these lines record revenue for Reports and Analytics only. No stock, batches, or the Negative Stock tab are affected.
          </div>
        )}
        {posReportValidationWarning && (
          <div className="mb-4 space-y-2 rounded-md bg-[var(--color-rust-soft)] px-3.5 py-2.5 text-sm text-[var(--color-rust)]">
            {posReportValidationWarning.map((w, i) => (
              <div key={i} className="flex items-start gap-1.5">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                {w}
              </div>
            ))}
          </div>
        )}

        <div className="mb-4 grid grid-cols-3 gap-3">
          <div className="rounded-md border border-[var(--color-line)] bg-[var(--color-paper)] p-3 text-center">
            <div className="font-display text-xl font-semibold text-[var(--color-herb)]">{importPreviewValid.length}</div>
            <div className="text-xs text-[var(--color-ink-soft)]">ready to add</div>
          </div>
          <div className="rounded-md border border-[var(--color-line)] bg-[var(--color-paper)] p-3 text-center">
            <div className="font-display text-xl font-semibold text-[var(--color-amber)]">{importMismatches.length}</div>
            <div className="text-xs text-[var(--color-ink-soft)]">price mismatch</div>
          </div>
          <div className="rounded-md border border-[var(--color-line)] bg-[var(--color-paper)] p-3 text-center">
            <div className="font-display text-xl font-semibold text-[var(--color-rust)]">{importPreviewSkipped.length}</div>
            <div className="text-xs text-[var(--color-ink-soft)]">skipped</div>
          </div>
        </div>

        {importPreviewSkipped.length > 0 && (
          <div className="mb-4">
            <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">Skipped rows</div>
            <div className="max-h-72 space-y-1 overflow-y-auto">
              {importPreviewSkipped.map((s, i) => {
                const details = [
                  s.productName,
                  s.barcode,
                  s.qty ? `qty ${s.qty}` : null,
                  s.price ? `${s.priceLabel ?? 'price'} ₱${Number(s.price).toFixed(2)}` : null,
                ]
                  .filter(Boolean)
                  .join(' — ')
                return (
                  <div key={i} className="rounded-md bg-[var(--color-rust-soft)] px-2.5 py-1.5 text-xs text-[var(--color-rust)]">
                    Row {s.rowNum}: {s.reason}
                    {details && <span className="block text-[var(--color-ink-soft)]">{details}</span>}
                    {s.canQuickAdd && quickAddRowNum !== s.rowNum && (
                      <button
                        onClick={() => startQuickAdd(s)}
                        className="mt-1 font-medium text-[var(--color-herb)] underline"
                      >
                        Add as product
                      </button>
                    )}
                    {quickAddRowNum === s.rowNum && (
                      <div className="mt-2 space-y-2 rounded-md border border-[var(--color-line)] bg-[var(--color-paper)] p-2">
                        <div className="text-[var(--color-ink-soft)]">Barcode {s.barcode} — new product</div>
                        <input
                          value={quickAddForm.name}
                          onChange={(e) => setQuickAddForm({ ...quickAddForm, name: e.target.value })}
                          placeholder="Product name"
                          className="input w-full"
                        />
                        <div className="grid grid-cols-2 gap-2">
                          <SelectOrText
                            value={quickAddForm.unit}
                            onChange={(v) => setQuickAddForm({ ...quickAddForm, unit: v })}
                            options={unitOptions}
                            placeholder="Unit (pcs, kg…)"
                          />
                          <SelectOrText
                            value={quickAddForm.category}
                            onChange={(v) => setQuickAddForm({ ...quickAddForm, category: v })}
                            options={categoryOptions}
                            placeholder="Category"
                          />
                          <input
                            type="number"
                            step="0.01"
                            value={quickAddForm.selling_price}
                            onChange={(e) => setQuickAddForm({ ...quickAddForm, selling_price: e.target.value })}
                            placeholder="Selling price"
                            className="input"
                          />
                          <input
                            type="number"
                            step="0.01"
                            value={quickAddForm.current_cost}
                            onChange={(e) => setQuickAddForm({ ...quickAddForm, current_cost: e.target.value })}
                            placeholder="Current cost (optional)"
                            className="input"
                          />
                        </div>
                        {isBackfillSale && (
                          <div className="text-[var(--color-ink-soft)]">
                            Before your inventory tracking start date — this product will be created already archived, since there's no way to know its real current stock.
                          </div>
                        )}
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleQuickAddProduct(s)}
                            disabled={quickAddSaving || !quickAddForm.name.trim()}
                            className="rounded-md bg-[var(--color-ink)] px-2.5 py-1 font-medium text-[var(--color-paper)] disabled:opacity-40"
                          >
                            {quickAddSaving ? 'Adding…' : 'Save & add line'}
                          </button>
                          <button onClick={cancelQuickAdd} className="rounded-md border border-[var(--color-line)] px-2.5 py-1">
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {importPreviewValid.length > 0 && (
          <div className="mb-4">
            <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">Preview (first 5)</div>
            <div className="space-y-1">
              {importPreviewValid.slice(0, 5).map((l) => (
                <div key={l.tempId} className="rounded-md border border-[var(--color-line)] px-2.5 py-1.5 text-xs">
                  <span className="font-medium">{l.product_name}</span> — {l.quantity} {l.unit} @ {l.unit_price.toFixed(2)}
                </div>
              ))}
              {importPreviewValid.length > 5 && (
                <div className="text-xs text-[var(--color-ink-soft)]">…and {importPreviewValid.length - 5} more</div>
              )}
            </div>
          </div>
        )}

        {importMismatches.length > 0 && (
          <div className="mb-4">
            <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-[var(--color-amber)]">
              Price mismatches — resolve before importing ({importMismatches.length})
            </div>
            <div className="max-h-64 space-y-2 overflow-y-auto">
              {importMismatches.map((m) => (
                <div key={m.tempId} className="space-y-2 rounded-md bg-[var(--color-amber-soft)] p-2.5 text-xs">
                  <div className="text-[var(--color-amber)]">
                    Row {m.rowNum}: <span className="font-medium">{m.product.name}</span> is ₱{m.givenUnitPrice.toFixed(2)},
                    recorded price is ₱{m.recordedPrice.toFixed(2)} ({m.qty} {m.product.unit})
                  </div>
                  <div className="flex flex-wrap items-end gap-2">
                    <button
                      onClick={() => resolveMismatchUpdatePrice(m)}
                      className="rounded-md border border-[var(--color-ink)] px-2 py-1 font-medium"
                    >
                      Update price to ₱{m.givenUnitPrice.toFixed(2)}
                    </button>
                    <button
                      onClick={() => resolveMismatchUseOnce(m)}
                      title="Use this price for this sale only — the product's current recorded price stays unchanged. For backlog imports where the price was accurate on that date but has since changed."
                      className="rounded-md border border-[var(--color-ink)] px-2 py-1 font-medium"
                    >
                      Use ₱{m.givenUnitPrice.toFixed(2)} for this sale only
                    </button>
                    <label className="block">
                      <span className="mb-1 block text-[var(--color-ink-soft)]">Discounted qty</span>
                      <input
                        type="number" min="1" max={m.qty} step="1"
                        value={m.discountQtyDraft ?? ''}
                        onChange={(e) => setMismatchDraft(m.tempId, e.target.value)}
                        className="input w-20"
                      />
                    </label>
                    <button
                      onClick={() => resolveMismatchDiscount(m)}
                      className="rounded-md bg-[var(--color-ink)] px-2 py-1 font-medium text-white"
                    >
                      Mark discounted
                    </button>
                    <button
                      onClick={() => resolveMismatchSkip(m)}
                      className="text-[var(--color-ink-soft)] underline underline-offset-2"
                    >
                      Skip row
                    </button>
                  </div>
                  <div className="flex flex-wrap items-end gap-2 border-t border-[var(--color-line)] pt-2">
                    <label className="block">
                      <span className="mb-1 block text-[var(--color-ink-soft)]">Qty at a different price</span>
                      <input
                        type="number" min="1" max={m.qty - 1} step="1"
                        value={m.splitQtyDraft ?? ''}
                        onChange={(e) => onMismatchSplitQty(m, e.target.value)}
                        className="input w-20"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[var(--color-ink-soft)]">That price</span>
                      <input
                        type="number" step="0.01"
                        value={m.splitPriceDraft ?? ''}
                        onChange={(e) => onMismatchSplitPrice(m, e.target.value)}
                        className="input w-24"
                      />
                    </label>
                    <button
                      onClick={() => resolveMismatchSplit(m)}
                      title="Some units at the recorded price, the rest at a different price — as two separate lines, instead of one averaged price."
                      className="rounded-md border border-[var(--color-ink)] px-2 py-1 font-medium"
                    >
                      Split price
                    </button>
                    {Number(m.splitQtyDraft) > 0 && Number(m.splitQtyDraft) < m.qty && Number(m.splitPriceDraft) > 0 && (() => {
                      const k = Number(m.splitQtyDraft)
                      const total = (m.qty - k) * m.recordedPrice + k * Number(m.splitPriceDraft)
                      const fileTotal = m.givenUnitPrice * m.qty
                      const diff = total - fileTotal
                      return (
                        <span className="basis-full text-[var(--color-ink-soft)]">
                          {m.qty - k} × ₱{m.recordedPrice.toFixed(2)} + {k} × ₱{Number(m.splitPriceDraft).toFixed(2)} = ₱{total.toFixed(2)}
                          {' '}— file says ₱{fileTotal.toFixed(2)}
                          {Math.abs(diff) < 0.005 ? ' (matches)' : ` (${diff > 0 ? '+' : '−'}₱${Math.abs(diff).toFixed(2)} off)`}
                        </span>
                      )
                    })()}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <p className="mb-4 text-xs text-[var(--color-ink-soft)]">
          This only adds lines to the sale you're building — nothing is saved to Inventory until you click
          "Complete sale" on the main panel.
        </p>

        <button
          onClick={handleConfirmImportLines}
          disabled={importing || importPreviewValid.length === 0 || importMismatches.length > 0}
          className="w-full rounded-md bg-[var(--color-ink)] py-2.5 text-sm font-medium text-white disabled:opacity-60"
        >
          {importMismatches.length > 0
            ? `Resolve ${importMismatches.length} price mismatch${importMismatches.length === 1 ? '' : 'es'} first`
            : `Add ${importPreviewValid.length} line${importPreviewValid.length === 1 ? '' : 's'} to this sale`}
        </button>
      </SlidePanel>
    </div>
  )
}

function Field({ label, required, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[var(--color-ink-soft)]">
        {label} {required && <span className="text-[var(--color-rust)]">*</span>}
      </span>
      {children}
    </label>
  )
}
