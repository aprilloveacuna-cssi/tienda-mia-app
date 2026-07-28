import { useEffect, useMemo, useRef, useState } from 'react'
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

const EMPTY_LINE_FORM = { product_id: '', quantity: '', unit_price: '' }

function today() {
  return new Date().toISOString().slice(0, 10)
}

const SALE_LINE_HEADER_ALIASES = {
  barcode: 'barcode', sku: 'sku',
  quantity: 'quantity', qty: 'quantity',
  unitprice: 'unit_price', price: 'unit_price',
  totalprice: 'total_price', total: 'total_price', saletotal: 'total_price',
}

function statusTone(status) {
  return status === 'voided' ? 'critical' : 'ok'
}

export default function Sales() {
  const [sales, setSales] = useState([])

  const { sortKey: saleSortKey, sortDir: saleSortDir, toggleSort: toggleSaleSort } = useSort('sale_date', 'desc')
  function saleSortAccessor(row, key) {
    if (key === 'total_amount') return Number(row.total_amount ?? 0)
    if (key === 'sale_date') return new Date(row.sale_date).getTime()
    return row[key]
  }
  const sortedSales = sortRows(sales, saleSortKey, saleSortDir, saleSortAccessor)

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
  const [products, setProducts] = useState([])
  const activeProducts = products.filter((p) => p.status === 'active')
  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState('')

  const [panelOpen, setPanelOpen] = useState(false)
  const [mode, setMode] = useState('new') // 'new' | 'view'
  const [pendingLines, setPendingLines] = useState([]) // not yet saved to DB
  const [viewedSale, setViewedSale] = useState(null)
  const [viewedLines, setViewedLines] = useState([])
  const [headerForm, setHeaderForm] = useState({ pos_terminal: '', cashier: '', sale_date: today() })

  const importFileInputRef = useRef(null)
  const [importPanelOpen, setImportPanelOpen] = useState(false)
  const [importPreviewValid, setImportPreviewValid] = useState([])
  const [importPreviewSkipped, setImportPreviewSkipped] = useState([])
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

  // Manual add-line price mismatch resolution
  const [priceMismatch, setPriceMismatch] = useState(null) // { recordedPrice, givenPrice }
  const [discountMode, setDiscountMode] = useState(false)
  const [discountQtyDraft, setDiscountQtyDraft] = useState('')

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

  useEffect(() => {
    loadSales()
    loadProducts()
    loadDiscountSetting()
  }, [])

  function openNew() {
    setMode('new')
    setHeaderForm({ pos_terminal: '', cashier: '', sale_date: today() })
    setPendingLines([])
    setLineForm(EMPTY_LINE_FORM)
    setLineWarning('')
    setErrorMsg('')
    setPanelOpen(true)
    loadProducts()
  }

  async function openView(sale) {
    setMode('view')
    setViewedSale(sale)
    setErrorMsg('')
    const { data } = await supabase
      .from('sale_lines')
      .select('*, product:products(name, sku, unit, category)')
      .eq('sale_id', sale.id)
    setViewedLines(data ?? [])
    setPanelOpen(true)
  }

  function onProductPick(productId) {
    const p = products.find((x) => x.id === productId)
    setLineForm({ product_id: productId, quantity: '', unit_price: p?.selling_price ?? '' })
    setLineWarning('')
  }

  // Walks batch_cache in FIFO order for this product, accounting for quantity
  // already claimed by lines added earlier in this same not-yet-saved sale.
  async function computeFifoConsumption(productId, qtyNeeded, reservationSource = pendingLines) {
    const { data: batches, error } = await supabase
      .from('batch_cache')
      .select('*')
      .eq('product_id', productId)
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
        consumption.push({ batch_id: b.batch_id, qty: take, unit_cost: Number(b.unit_cost) })
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
    const discountedUnitPrice = Math.round(Number(product.selling_price) * (1 - discountPct / 100) * 100) / 100

    if (discountedQty > 0) {
      const { consumption } = await computeFifoConsumption(product.id, discountedQty, reservationSource)
      const fifoCost = consumption.reduce((sum, c) => sum + c.qty * c.unit_cost, 0)
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
        discount_amount: discountedQty * (Number(product.selling_price) - discountedUnitPrice),
      })
    }

    if (regularQty > 0) {
      const { consumption } = await computeFifoConsumption(product.id, regularQty, [...reservationSource, ...lines])
      const fifoCost = consumption.reduce((sum, c) => sum + c.qty * c.unit_cost, 0)
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

  function handleImportFileChange(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    const reader = new FileReader()
    reader.onload = async () => {
      setImportParsing(true)
      setErrorMsg('')
      try {
        const rows = parseCsv(String(reader.result))
        if (rows.length < 2) {
          setErrorMsg('That file has no data rows.')
          setImportParsing(false)
          return
        }
        const headerRow = rows[0].map((h) => h.trim())
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
            if (key) obj[key] = (r[i] ?? '').trim()
          })

          const product = obj.barcode
            ? products.find((p) => cleanCode(p.barcode) === cleanCode(obj.barcode))
            : obj.sku
              ? products.find((p) => cleanCode(p.sku) === cleanCode(obj.sku))
              : null

          if (!product) {
            skipped.push({ rowNum, reason: obj.barcode || obj.sku ? `No product matches "${obj.barcode || obj.sku}"` : 'Missing barcode/SKU' })
            continue
          }
          if (product.status !== 'active') {
            skipped.push({ rowNum, reason: `${product.name} (${product.barcode}) exists but is archived — restore it in Products first` })
            continue
          }
          const qty = Number(obj.quantity)
          if (!qty || qty <= 0) {
            skipped.push({ rowNum, reason: 'Missing or invalid quantity' })
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

        // ---------- Pass 2: Kitchen items reconcile against that day's Daily Meals ----------
        // Every Kitchen item's sales this import must trace back to a Daily
        // Meals batch dated exactly this sale's date. A Meal and its paired
        // Only both draw from the same prepared batch, so they're checked
        // together. No batch at all for that dish/date is an error — nothing
        // to reconcile against. If a batch exists but sold more than was
        // prepared, the shortfall is topped up automatically so the sale can
        // go through, rather than blocking a sale that genuinely happened.
        function groupIdsFor(product) {
          if (product.pairs_with_product_id) return [product.id, product.pairs_with_product_id].sort()
          const pointingToMe = products.find((p) => p.pairs_with_product_id === product.id)
          if (pointingToMe) return [product.id, pointingToMe.id].sort()
          return [product.id]
        }

        const kitchenGroups = new Map()
        for (const pr of parsedRows) {
          const isKitchen = pr.product.business_unit === 'KITCHEN' || pr.product.category === 'KITCHEN'
          if (!isKitchen) continue
          const key = groupIdsFor(pr.product).join(',')
          if (!kitchenGroups.has(key)) {
            kitchenGroups.set(key, { groupIds: groupIdsFor(pr.product), neededQty: 0, rowNums: [], names: new Set() })
          }
          const g = kitchenGroups.get(key)
          g.neededQty += pr.qty
          g.rowNums.push(pr.rowNum)
          g.names.add(pr.product.name)
        }

        const blockedRowNums = new Set()

        for (const g of kitchenGroups.values()) {
          const { data: dmBatches } = await supabase
            .from('batches')
            .select('id, product_id, unit_cost')
            .in('product_id', g.groupIds)
            .eq('source_type', 'KitchenProduction')
            .eq('received_date', headerForm.sale_date)

          if (!dmBatches || dmBatches.length === 0) {
            for (const rn of g.rowNums) blockedRowNums.add(rn)
            skipped.push({
              rowNum: g.rowNums[0],
              reason: `${[...g.names].join(' / ')}: no Daily Meals entry for ${headerForm.sale_date} — add it in Kitchen → Daily Meals first`,
            })
            continue
          }

          const { data: cacheRows } = await supabase
            .from('batch_cache')
            .select('remaining_quantity')
            .in('batch_id', dmBatches.map((b) => b.id))
          const remaining = (cacheRows ?? []).reduce((s, c) => s + Number(c.remaining_quantity), 0)

          if (remaining < g.neededQty) {
            const shortfall = g.neededQty - remaining
            const topUpProductId = dmBatches[0].product_id
            const topUpCost = Number(dmBatches[0].unit_cost ?? 0)

            const { data: newBatch, error: batchErr } = await supabase
              .from('batches')
              .insert({
                product_id: topUpProductId,
                source_type: 'KitchenProduction',
                received_quantity: shortfall,
                unit_cost: topUpCost,
                received_date: headerForm.sale_date,
              })
              .select()
              .single()

            if (!batchErr) {
              await supabase.from('inventory_ledger').insert({
                product_id: topUpProductId,
                batch_id: newBatch.id,
                transaction_type: 'KitchenProduction',
                quantity_change: shortfall,
                unit_cost_at_transaction: topUpCost,
                source_module: 'Kitchen',
                source_reference_id: newBatch.id,
              })
            }
          }
        }

        // ---------- Pass 3: normal per-row FIFO stock check ----------
        const valid = []
        // Accumulates alongside `pendingLines` so each row in this same file
        // correctly sees stock already claimed by earlier rows in the file —
        // React state wouldn't update fast enough inside this loop to rely on.
        const accumulator = [...pendingLines]

        for (const pr of parsedRows) {
          if (blockedRowNums.has(pr.rowNum)) continue

          try {
            const { consumption, satisfied, totalAvailable } = await computeFifoConsumption(pr.product.id, pr.qty, accumulator)
            if (!satisfied && !pr.product.unlimited_stock) {
              skipped.push({ rowNum: pr.rowNum, reason: `${pr.product.name}: only ${totalAvailable} ${pr.product.unit} available` })
              continue
            }
            const lineTotal = pr.qty * pr.unitPrice
            const consumedQty = consumption.reduce((sum, c) => sum + c.qty, 0)
            const openQty = pr.qty - consumedQty
            const fifoCost =
              consumption.reduce((sum, c) => sum + c.qty * c.unit_cost, 0) + openQty * Number(pr.product.current_cost ?? 0)
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
              openQty,
            }
            accumulator.push(newLine)
            valid.push(newLine)
          } catch {
            skipped.push({ rowNum: pr.rowNum, reason: 'Could not check stock for this row' })
          }
        }

        setImportPreviewValid(valid)
        setImportPreviewSkipped(skipped)
        setImportMismatches(mismatches)
        setImportParsing(false)
        setImportPanelOpen(true)
      } catch {
        setImportParsing(false)
        setErrorMsg('Could not read that file — make sure it is a CSV, not an .xlsx.')
      }
    }
    reader.readAsText(file)
  }

  function setMismatchDraft(tempId, draft) {
    setImportMismatches(importMismatches.map((m) => (m.tempId === tempId ? { ...m, discountQtyDraft: draft } : m)))
  }

  async function resolveMismatchUpdatePrice(mismatch) {
    const { error } = await supabase.from('products').update({ selling_price: mismatch.givenUnitPrice }).eq('id', mismatch.product.id)
    if (error) {
      setErrorMsg(error.message)
      return
    }
    const updatedProduct = { ...mismatch.product, selling_price: mismatch.givenUnitPrice }
    setProducts(products.map((p) => (p.id === updatedProduct.id ? updatedProduct : p)))

    try {
      const reservationSource = [...pendingLines, ...importPreviewValid]
      const { consumption, satisfied, totalAvailable } = await computeFifoConsumption(updatedProduct.id, mismatch.qty, reservationSource)
      if (!satisfied && !updatedProduct.unlimited_stock) {
        setImportPreviewSkipped([...importPreviewSkipped, { rowNum: mismatch.rowNum, reason: `${updatedProduct.name}: only ${totalAvailable} ${updatedProduct.unit} available` }])
      } else {
        const lineTotal = mismatch.qty * mismatch.givenUnitPrice
        const consumedQty = consumption.reduce((sum, c) => sum + c.qty, 0)
        const openQty = mismatch.qty - consumedQty
        const fifoCost = consumption.reduce((sum, c) => sum + c.qty * c.unit_cost, 0) + openQty * Number(updatedProduct.current_cost ?? 0)
        setImportPreviewValid([
          ...importPreviewValid,
          {
            tempId: crypto.randomUUID(),
            product_id: updatedProduct.id,
            product_name: updatedProduct.name,
            category: updatedProduct.category,
            unit: updatedProduct.unit,
            quantity: mismatch.qty,
            unit_price: mismatch.givenUnitPrice,
            line_total: lineTotal,
            fifo_cost: fifoCost,
            gross_profit: lineTotal - fifoCost,
            consumption,
            openQty,
            is_discounted: false,
            discount_amount: 0,
          },
        ])
      }
    } catch {
      setImportPreviewSkipped([...importPreviewSkipped, { rowNum: mismatch.rowNum, reason: 'Could not check stock for this row' }])
    }
    setImportMismatches(importMismatches.filter((m) => m.tempId !== mismatch.tempId))
  }

  async function resolveMismatchDiscount(mismatch) {
    const discountedQty = Number(mismatch.discountQtyDraft)
    if (!discountedQty || discountedQty <= 0 || discountedQty > mismatch.qty) return
    try {
      const reservationSource = [...pendingLines, ...importPreviewValid]
      const newLines = await buildDiscountSplitLines(mismatch.product, mismatch.qty, discountedQty, reservationSource)
      setImportPreviewValid([...importPreviewValid, ...newLines])
    } catch {
      setImportPreviewSkipped([...importPreviewSkipped, { rowNum: mismatch.rowNum, reason: 'Could not check stock for this row' }])
    }
    setImportMismatches(importMismatches.filter((m) => m.tempId !== mismatch.tempId))
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
  }

  async function proceedAddLine(product, qty, unitPrice) {
    const { consumption, satisfied, totalAvailable } = await computeFifoConsumption(product.id, qty)

    // Items flagged "never block for low stock" (e.g. Rice, where real
    // batch-level stock isn't tracked precisely) still consume whatever
    // real batches exist first, then treat the remainder as an open
    // quantity costed at current cost — never blocking the sale itself.
    if (!satisfied && !product.unlimited_stock) {
      setLineWarning(
        totalAvailable === 0
          ? `${product.name} has no stock available.`
          : `Only ${totalAvailable} ${product.unit} of ${product.name} available (across pending lines already added).`
      )
      return false
    }

    const lineTotal = qty * unitPrice
    const consumedQty = consumption.reduce((sum, c) => sum + c.qty, 0)
    const openQty = qty - consumedQty
    const fifoCost =
      consumption.reduce((sum, c) => sum + c.qty * c.unit_cost, 0) + openQty * Number(product.current_cost ?? 0)

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
        is_discounted: false,
        discount_amount: 0,
      },
    ])
    return true
  }

  async function handleAddLine(e) {
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


  function removeLine(tempId) {
    setPendingLines(pendingLines.filter((l) => l.tempId !== tempId))
  }

  function startEditLine(line) {
    // Remove it first so its reserved batch quantity is freed — re-adding via
    // the form below recomputes FIFO fresh, correctly seeing that stock again.
    setPendingLines(pendingLines.filter((l) => l.tempId !== line.tempId))
    setLineForm({ product_id: line.product_id, quantity: String(line.quantity), unit_price: String(line.unit_price) })
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
    () => pendingLines.reduce((sum, l) => sum + (l.discount_amount ?? 0), 0),
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
    const saleDateTime = new Date(year, month - 1, day, now.getHours(), now.getMinutes(), now.getSeconds())

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
          discount_amount: line.discount_amount ?? 0,
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
        product_id: line.product_id,
        batch_id: c.batch_id,
        transaction_type: 'Sale',
        quantity_change: -c.qty,
        unit_cost_at_transaction: c.unit_cost,
        source_module: 'Sales',
        source_reference_id: saleLine.id,
      }))
      const { error: ledgerErr } = await supabase.from('inventory_ledger').insert(ledgerRows)
      if (ledgerErr) {
        setErrorMsg(`Sale created but inventory wasn't fully updated: ${ledgerErr.message}. Check ${sale.sale_number} manually.`)
        setSaving(false)
        loadSales()
        return
      }
    }

    setSaving(false)
    setPanelOpen(false)
    loadSales()
  }

  async function voidSale() {
    if (!confirm(`Void ${viewedSale.sale_number}? This restores the stock it sold — the record stays, it doesn't get deleted.`)) {
      return
    }
    setSaving(true)
    setErrorMsg('')

    const lineIds = viewedLines.map((l) => l.id)
    const { data: originalLedgerRows, error: fetchErr } = await supabase
      .from('inventory_ledger')
      .select('*')
      .in('source_reference_id', lineIds)
      .eq('transaction_type', 'Sale')

    if (fetchErr) {
      setErrorMsg(fetchErr.message)
      setSaving(false)
      return
    }

    const reversalRows = (originalLedgerRows ?? []).map((row) => ({
      product_id: row.product_id,
      batch_id: row.batch_id,
      transaction_type: 'Void',
      quantity_change: -row.quantity_change, // flips the original negative back to positive
      unit_cost_at_transaction: row.unit_cost_at_transaction,
      source_module: 'Sales',
      source_reference_id: row.source_reference_id,
      remarks: `Reversal of voided sale ${viewedSale.sale_number}`,
    }))

    if (reversalRows.length > 0) {
      const { error: insErr } = await supabase.from('inventory_ledger').insert(reversalRows)
      if (insErr) {
        setErrorMsg(insErr.message)
        setSaving(false)
        return
      }
    }

    const { data: updated, error: updErr } = await supabase
      .from('sales')
      .update({ status: 'voided' })
      .eq('id', viewedSale.id)
      .select()
      .single()

    setSaving(false)
    if (updErr) {
      setErrorMsg(updErr.message)
      return
    }
    setViewedSale(updated)
    loadSales()
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

      <SearchBar value={search} onChange={setSearch} placeholder="Search by sale #, terminal, or cashier" />

      <div className="overflow-hidden rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)]">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[var(--color-line)] text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
            <tr>
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
                <td colSpan={6} className="px-4 py-8 text-center text-[var(--color-ink-soft)]">
                  Loading sales…
                </td>
              </tr>
            )}
            {!loading && searchedSales.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-[var(--color-ink-soft)]">
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
        onClose={() => setPanelOpen(false)}
      >
        {errorMsg && (
          <div className="mb-4 rounded-md bg-[var(--color-rust-soft)] px-3.5 py-2.5 text-sm text-[var(--color-rust)]">
            {errorMsg}
          </div>
        )}

        {mode === 'new' ? (
          <div>
            <div className="mb-4 grid grid-cols-2 gap-3">
              <Field label="Sale date" required>
                <input
                  type="date"
                  required
                  max={today()}
                  value={headerForm.sale_date}
                  onChange={(e) => setHeaderForm({ ...headerForm, sale_date: e.target.value })}
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

            <div className="mb-4 max-h-64 overflow-auto rounded-md border border-[var(--color-line)]">
              <table className="w-full min-w-[520px] whitespace-nowrap text-left text-sm">
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
                    <tr key={l.tempId} className="border-b border-[var(--color-line)] last:border-0">
                      <td className="px-3 py-2">
                        {l.product_name}
                        {l.openQty > 0 && (
                          <span
                            title="Consumed whatever real stock exists, rest costed at current cost — this item never blocks a sale"
                            className="ml-1.5 rounded-full bg-[var(--color-amber-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-amber)]"
                          >
                            {l.openQty} open
                          </span>
                        )}
                        {l.is_discounted && (
                          <span
                            title={`Senior/PWD discount — ₱${l.discount_amount.toFixed(2)} off`}
                            className="ml-1.5 rounded-full bg-[var(--color-herb-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-herb)]"
                          >
                            discounted
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-[var(--color-ink-soft)]">{l.category || '—'}</td>
                      <td className="px-3 py-2">{l.quantity} {l.unit}</td>
                      <td className="px-3 py-2">{l.unit_price.toFixed(2)}</td>
                      <td className="px-3 py-2">{l.line_total.toFixed(2)}</td>
                      <td className="px-3 py-2 text-[var(--color-herb)]">{l.gross_profit.toFixed(2)}</td>
                      <td className="px-3 py-2">
                        <div className="flex gap-1">
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
                Senior/PWD discounts this sale: ₱{runningDiscount.toFixed(2)} — factor this into remittance, since it's a real reduction from gross.
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
            </div>

            <form onSubmit={handleAddLine} className="mb-5 space-y-3 rounded-md border border-dashed border-[var(--color-line)] p-3">
              <Field label="Product" required>
                <ProductPicker
                  products={activeProducts}
                  value={lineForm.product_id}
                  onChange={onProductPick}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Quantity" required>
                  <input
                    type="number"
                    step="0.001"
                    min="0"
                    required
                    value={lineForm.quantity}
                    onChange={(e) => setLineForm({ ...lineForm, quantity: e.target.value })}
                    className="input"
                  />
                </Field>
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
              </div>
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
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={handleUpdatePriceAndAdd}
                        className="rounded-md border border-[var(--color-ink)] px-2.5 py-1.5 font-medium"
                      >
                        Update price to ₱{priceMismatch.givenPrice.toFixed(2)}
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

            <div className="mb-5 max-h-64 overflow-auto rounded-md border border-[var(--color-line)]">
              <table className="w-full min-w-[480px] whitespace-nowrap text-left text-sm">
                <thead className="sticky top-0 border-b border-[var(--color-line)] bg-[var(--color-paper-raised)] text-xs text-[var(--color-ink-soft)]">
                  <tr>
                    <th className="px-3 py-2">Product</th>
                    <th className="px-3 py-2">Category</th>
                    <th className="px-3 py-2">Qty</th>
                    <th className="px-3 py-2">Price</th>
                    <th className="px-3 py-2">FIFO cost</th>
                    <th className="px-3 py-2">Profit</th>
                  </tr>
                </thead>
                <tbody>
                  {viewedLines.map((l) => (
                    <tr key={l.id} className="border-b border-[var(--color-line)] last:border-0">
                      <td className="px-3 py-2">{l.product?.name}</td>
                      <td className="px-3 py-2 text-[var(--color-ink-soft)]">{l.product?.category || '—'}</td>
                      <td className="px-3 py-2">{l.quantity} {l.product?.unit}</td>
                      <td className="px-3 py-2">{Number(l.unit_price).toFixed(2)}</td>
                      <td className="px-3 py-2">{Number(l.fifo_cost).toFixed(2)}</td>
                      <td className="px-3 py-2 text-[var(--color-herb)]">{Number(l.gross_profit).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

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
            <div className="max-h-48 space-y-1 overflow-y-auto">
              {importPreviewSkipped.map((s, i) => (
                <div key={i} className="rounded-md bg-[var(--color-rust-soft)] px-2.5 py-1.5 text-xs text-[var(--color-rust)]">
                  Row {s.rowNum}: {s.reason}
                </div>
              ))}
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
