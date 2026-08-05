import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Upload, FileDown, Trash2, Check } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { fetchAllRows } from '../lib/fetchAllRows'
import SlidePanel from '../components/SlidePanel'
import StatusChip from '../components/StatusChip'
import SortableTh from '../components/SortableTh'
import ProductPicker from '../components/ProductPicker'
import SearchBar from '../components/SearchBar'
import { useSort, sortRows } from '../lib/sort'
import { normalizeSearchText } from '../lib/search'
import { parseCsv, normalizeHeader, downloadFile } from '../lib/csv'

export default function Adjustments() {
  const [tab, setTab] = useState('adjustments') // 'adjustments' | 'physicalCount'
  const [adjustments, setAdjustments] = useState([])
  const [inventoryCacheMap, setInventoryCacheMap] = useState({})

  const { sortKey: adjSortKey, sortDir: adjSortDir, toggleSort: toggleAdjSort } = useSort('adjustment_date', 'desc')
  function adjSortAccessor(row, key) {
    if (key === 'product') return row.product?.name
    if (key === 'category') return row.product?.category
    if (key === 'batch') return row.batch?.batch_number ?? ''
    if (key === 'change') return Number(row.adjustment_quantity ?? 0)
    return row[key]
  }
  const sortedAdjustments = sortRows(adjustments, adjSortKey, adjSortDir, adjSortAccessor)

  const [search, setSearch] = useState('')
  const searchedAdjustments = search.trim()
    ? sortedAdjustments.filter((a) => {
        const q = normalizeSearchText(search)
        return (
          normalizeSearchText(a.adjustment_number).includes(q) ||
          normalizeSearchText(a.product?.name).includes(q) ||
          normalizeSearchText(a.reason).includes(q)
        )
      })
    : sortedAdjustments
  const [products, setProducts] = useState([])
  const [adjustmentTypes, setAdjustmentTypes] = useState([])
  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState('')

  const [panelOpen, setPanelOpen] = useState(false)
  const [productId, setProductId] = useState('')
  const [level, setLevel] = useState('product') // 'product' | 'batch'
  const [batches, setBatches] = useState([])
  const [batchId, setBatchId] = useState('')
  const [oldValue, setOldValue] = useState(null)
  const [newValue, setNewValue] = useState('')
  const [adjustmentType, setAdjustmentType] = useState('')
  const [reason, setReason] = useState('')
  const [referenceNumber, setReferenceNumber] = useState('')
  const [remarks, setRemarks] = useState('')
  const [saving, setSaving] = useState(false)

  // ---------- Physical Count ----------
  const [countRows, setCountRows] = useState([])
  const [countForm, setCountForm] = useState({ product_id: '', counted_qty: '' })
  const [countReason, setCountReason] = useState('')
  const [showOnlyMismatches, setShowOnlyMismatches] = useState(true)
  const [countPosting, setCountPosting] = useState(false)
  const [countError, setCountError] = useState('')
  const [countImportSkipped, setCountImportSkipped] = useState([])
  const countFileInputRef = useRef(null)

  async function loadInventoryCache() {
    const { data } = await fetchAllRows('inventory_cache', 'product_id, current_stock')
    const map = {}
    for (const row of data ?? []) map[row.product_id] = Number(row.current_stock)
    setInventoryCacheMap(map)
  }

  async function loadAdjustments() {
    setLoading(true)
    setErrorMsg('')
    const { data, error } = await supabase
      .from('adjustments')
      .select('*, product:products(name, sku, unit, category), batch:batches(batch_number)')
      .order('created_at', { ascending: false })
    if (error) {
      setErrorMsg('Could not reach Supabase. Check your .env values and that migrations have run.')
    } else {
      setAdjustments(data ?? [])
    }
    setLoading(false)
  }

  async function loadProducts() {
    const { data } = await fetchAllRows('products', 'id, sku, name, unit, barcode, status, current_cost, category', 'name')
    setProducts((data ?? []).filter((p) => p.status === 'active'))
  }

  async function loadAdjustmentTypes() {
    const { data } = await supabase
      .from('lists')
      .select('value')
      .eq('list_type', 'AdjustmentType')
      .eq('active', true)
      .order('value')
    setAdjustmentTypes((data ?? []).map((r) => r.value))
  }

  useEffect(() => {
    loadAdjustments()
    loadProducts()
    loadAdjustmentTypes()
    loadInventoryCache()
  }, [])

  function resetForm() {
    setProductId('')
    setLevel('product')
    setBatches([])
    setBatchId('')
    setOldValue(null)
    setNewValue('')
    setAdjustmentType(adjustmentTypes[0] ?? '')
    setReason('')
    setReferenceNumber('')
    setRemarks('')
    setErrorMsg('')
  }

  function openNew() {
    resetForm()
    setPanelOpen(true)
  }

  async function onProductPick(id) {
    setProductId(id)
    setLevel('product')
    setBatchId('')
    setNewValue('')

    const { data: cache } = await supabase
      .from('inventory_cache')
      .select('current_stock')
      .eq('product_id', id)
      .maybeSingle()
    setOldValue(cache ? Number(cache.current_stock) : 0)

    const { data: batchRows } = await supabase
      .from('batch_cache')
      .select('*')
      .eq('product_id', id)
      .order('fifo_sequence')
    setBatches(batchRows ?? [])
  }

  function onLevelChange(newLevel) {
    setLevel(newLevel)
    setNewValue('')
    if (newLevel === 'product') {
      setBatchId('')
      const found = products.find((p) => p.id === productId)
      if (found) onProductPick(productId) // refetch product-level old value
    }
  }

  function onBatchPick(id) {
    setBatchId(id)
    const b = batches.find((x) => x.batch_id === id)
    setOldValue(b ? Number(b.remaining_quantity) : 0)
    setNewValue('')
  }

  const adjustmentQty = useMemo(() => {
    if (oldValue === null || newValue === '') return null
    return Number(newValue) - oldValue
  }, [oldValue, newValue])

  async function handleSave(e) {
    e.preventDefault()
    if (!productId || newValue === '' || !adjustmentType || !reason.trim()) return
    if (level === 'batch' && !batchId) {
      setErrorMsg('Pick which batch this adjustment applies to, or switch to "Overall product stock".')
      return
    }
    setSaving(true)
    setErrorMsg('')

    const { error } = await supabase.from('adjustments').insert({
      product_id: productId,
      batch_id: level === 'batch' ? batchId : null,
      adjustment_type: adjustmentType,
      reason: reason.trim(),
      reference_number: referenceNumber.trim() || null,
      old_value: oldValue,
      new_value: Number(newValue),
      remarks: remarks.trim() || null,
    })

    setSaving(false)
    if (error) {
      setErrorMsg(error.message)
      return
    }
    setPanelOpen(false)
    loadAdjustments()
  }

  const selectedProduct = products.find((p) => p.id === productId)

  // ---------- Physical Count ----------
  function addCountRow(e) {
    e.preventDefault()
    if (!countForm.product_id || countForm.counted_qty === '') return
    const p = products.find((x) => x.id === countForm.product_id)
    if (countRows.some((r) => r.product.id === p.id)) {
      setCountError(`${p.name} is already in this list.`)
      return
    }
    setCountRows([
      ...countRows,
      {
        tempId: crypto.randomUUID(),
        product: p,
        systemQty: inventoryCacheMap[p.id] ?? 0,
        countedQty: Number(countForm.counted_qty),
        posted: false,
      },
    ])
    setCountForm({ product_id: '', counted_qty: '' })
    setCountError('')
  }

  function removeCountRow(tempId) {
    setCountRows(countRows.filter((r) => r.tempId !== tempId))
  }

  function handleDownloadCountTemplate() {
    const headers = ['Barcode', 'Counted Qty']
    const example1 = ['4800123456789', '48']
    const example2 = ['4800987654321', '0']
    const csv = [headers, example1, example2]
      .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    downloadFile('physical-count-template.csv', csv, 'text/csv;charset=utf-8;')
  }

  function handleCountImportClick() {
    countFileInputRef.current?.click()
  }

  function handleCountImportFileChange(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    const reader = new FileReader()
    reader.onload = () => {
      try {
        const rows = parseCsv(String(reader.result))
        if (rows.length < 2) {
          setCountError('That file has no data rows.')
          return
        }
        const headerRow = rows[0].map((h) => h.trim())
        const aliases = {
          barcode: 'barcode', sku: 'sku',
          countedqty: 'counted_qty', counted: 'counted_qty', qty: 'counted_qty', quantity: 'counted_qty', actualcount: 'counted_qty',
        }
        const canonicalKeys = headerRow.map((h) => aliases[normalizeHeader(h)] ?? null)

        const existingIds = new Set(countRows.map((r) => r.product.id))
        const newRows = []
        const skipped = []

        rows.slice(1).forEach((r, idx) => {
          const rowNum = idx + 2
          if (r.length !== headerRow.length) {
            skipped.push({ rowNum, reason: `Row has ${r.length} columns, expected ${headerRow.length} — likely a stray quote or comma` })
            return
          }
          const obj = {}
          canonicalKeys.forEach((key, i) => {
            if (key) obj[key] = (r[i] ?? '').trim()
          })

          const product = obj.barcode
            ? products.find((p) => normalizeSearchText(p.barcode) === normalizeSearchText(obj.barcode))
            : obj.sku
              ? products.find((p) => normalizeSearchText(p.sku) === normalizeSearchText(obj.sku))
              : null

          if (!product) {
            skipped.push({ rowNum, reason: obj.barcode || obj.sku ? `No product matches "${obj.barcode || obj.sku}"` : 'Missing barcode/SKU' })
            return
          }
          if (existingIds.has(product.id)) {
            skipped.push({ rowNum, reason: `${product.name} is already in this list` })
            return
          }
          if (obj.counted_qty === '' || isNaN(Number(obj.counted_qty))) {
            skipped.push({ rowNum, reason: 'Missing or invalid counted quantity' })
            return
          }

          existingIds.add(product.id)
          newRows.push({
            tempId: crypto.randomUUID(),
            product,
            systemQty: inventoryCacheMap[product.id] ?? 0,
            countedQty: Number(obj.counted_qty),
            posted: false,
          })
        })

        setCountRows([...countRows, ...newRows])
        setCountImportSkipped(skipped)
        setCountError('')
      } catch {
        setCountError('Could not read that file — make sure it is a CSV, not an .xlsx.')
      }
    }
    reader.readAsText(file)
  }

  async function postCountRow(row) {
    if (!countReason.trim()) {
      setCountError('Add a reason before posting — it applies to every adjustment this creates.')
      return
    }
    const { error } = await supabase.from('adjustments').insert({
      product_id: row.product.id,
      batch_id: null,
      adjustment_type: 'Count Correction',
      reason: countReason.trim(),
      old_value: row.systemQty,
      new_value: row.countedQty,
    })
    if (error) {
      setCountError(`${row.product.name}: ${error.message}`)
      return
    }
    setCountRows(countRows.map((r) => (r.tempId === row.tempId ? { ...r, posted: true } : r)))
  }

  async function postAllCountVariances() {
    if (!countReason.trim()) {
      setCountError('Add a reason before posting — it applies to every adjustment this creates.')
      return
    }
    setCountPosting(true)
    setCountError('')
    const toPost = countRows.filter((r) => !r.posted && r.countedQty !== r.systemQty)
    const failed = []

    for (const row of toPost) {
      const { error } = await supabase.from('adjustments').insert({
        product_id: row.product.id,
        batch_id: null,
        adjustment_type: 'Count Correction',
        reason: countReason.trim(),
        old_value: row.systemQty,
        new_value: row.countedQty,
      })
      if (error) failed.push(row.product.name)
    }

    setCountRows(countRows.map((r) => (toPost.some((t) => t.tempId === r.tempId) && !failed.includes(r.product.name) ? { ...r, posted: true } : r)))
    setCountPosting(false)
    if (failed.length > 0) setCountError(`Posted the rest, but failed for: ${failed.join(', ')}`)
    loadAdjustments()
    loadInventoryCache()
  }

  const { sortKey: countSortKey, sortDir: countSortDir, toggleSort: toggleCountSort } = useSort('variance', 'desc')
  function countSortAccessor(row, key) {
    if (key === 'product') return row.product.name
    if (key === 'category') return row.product.category
    if (key === 'systemQty') return row.systemQty
    if (key === 'countedQty') return row.countedQty
    if (key === 'variance') return Math.abs(row.countedQty - row.systemQty)
    if (key === 'valueImpact') return (row.countedQty - row.systemQty) * Number(row.product.current_cost ?? 0)
    return row[key]
  }
  const visibleCountRows = showOnlyMismatches ? countRows.filter((r) => r.countedQty !== r.systemQty) : countRows
  const sortedCountRows = sortRows(visibleCountRows, countSortKey, countSortDir, countSortAccessor)
  const pendingVarianceCount = countRows.filter((r) => !r.posted && r.countedQty !== r.systemQty).length

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold">Adjustments</h1>
          <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
            Corrects a miscount without touching history — every adjustment writes its own ledger entry, nothing gets edited or deleted.
          </p>
        </div>
        {tab === 'adjustments' && (
          <button
            onClick={openNew}
            className="flex items-center gap-1.5 rounded-md bg-[var(--color-ink)] px-3.5 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            <Plus size={16} />
            New adjustment
          </button>
        )}
      </div>

      <div className="mb-4 flex gap-1 border-b border-[var(--color-line)]">
        {[
          ['adjustments', 'Adjustments'],
          ['physicalCount', 'Physical Count'],
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-3 py-2 text-sm font-medium ${
              tab === key ? 'border-b-2 border-[var(--color-ink)] text-[var(--color-ink)]' : 'text-[var(--color-ink-soft)]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {errorMsg && !panelOpen && tab === 'adjustments' && (
        <div className="mb-4 rounded-md bg-[var(--color-rust-soft)] px-3.5 py-2.5 text-sm text-[var(--color-rust)]">
          {errorMsg}
        </div>
      )}

      {tab === 'adjustments' && (
        <>
      <SearchBar value={search} onChange={setSearch} placeholder="Search by adjustment #, product, or reason" />

      <div className="overflow-hidden rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)]">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[var(--color-line)] text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
            <tr>
              <SortableTh label="Adjustment #" sortKey="adjustment_number" activeKey={adjSortKey} activeDir={adjSortDir} onSort={toggleAdjSort} />
              <SortableTh label="Date" sortKey="adjustment_date" activeKey={adjSortKey} activeDir={adjSortDir} onSort={toggleAdjSort} />
              <SortableTh label="Product" sortKey="product" activeKey={adjSortKey} activeDir={adjSortDir} onSort={toggleAdjSort} />
              <SortableTh label="Category" sortKey="category" activeKey={adjSortKey} activeDir={adjSortDir} onSort={toggleAdjSort} />
              <SortableTh label="Batch" sortKey="batch" activeKey={adjSortKey} activeDir={adjSortDir} onSort={toggleAdjSort} />
              <th className="px-4 py-3">Old → New</th>
              <SortableTh label="Change" sortKey="change" activeKey={adjSortKey} activeDir={adjSortDir} onSort={toggleAdjSort} />
              <SortableTh label="Type" sortKey="adjustment_type" activeKey={adjSortKey} activeDir={adjSortDir} onSort={toggleAdjSort} />
              <th className="px-4 py-3">Reason</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={9} className="px-4 py-8 text-center text-[var(--color-ink-soft)]">Loading adjustments…</td></tr>
            )}
            {!loading && searchedAdjustments.length === 0 && (
              <tr><td colSpan={9} className="px-4 py-10 text-center text-[var(--color-ink-soft)]">No adjustments yet — good sign, means nothing's needed correcting.</td></tr>
            )}
            {searchedAdjustments.map((a) => {
              const qty = Number(a.adjustment_quantity)
              return (
                <tr key={a.id} className="border-b border-[var(--color-line)] last:border-0">
                  <td className="font-mono px-4 py-3 text-xs text-[var(--color-ink-soft)]">{a.adjustment_number}</td>
                  <td className="px-4 py-3">{a.adjustment_date}</td>
                  <td className="px-4 py-3 font-medium">{a.product?.name}</td>
                  <td className="px-4 py-3 text-[var(--color-ink-soft)]">{a.product?.category || '—'}</td>
                  <td className="font-mono px-4 py-3 text-xs text-[var(--color-ink-soft)]">{a.batch?.batch_number ?? 'Overall'}</td>
                  <td className="px-4 py-3">{Number(a.old_value)} → {Number(a.new_value)}</td>
                  <td className="px-4 py-3">
                    <StatusChip tone={qty > 0 ? 'ok' : qty < 0 ? 'critical' : 'neutral'}>
                      {qty > 0 ? '+' : ''}{qty} {a.product?.unit}
                    </StatusChip>
                  </td>
                  <td className="px-4 py-3 text-[var(--color-ink-soft)]">{a.adjustment_type}</td>
                  <td className="px-4 py-3 text-[var(--color-ink-soft)]">{a.reason}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
        </>
      )}

      {tab === 'physicalCount' && (
        <div>
          <p className="mb-4 text-sm text-[var(--color-ink-soft)]">
            Enter or import what was actually counted, and this compares it against what the system currently shows —
            posting a row (or all of them) creates real adjustments, same as the form on the other tab, just for many
            products at once.
          </p>

          {countError && (
            <div className="mb-4 rounded-md bg-[var(--color-rust-soft)] px-3.5 py-2.5 text-sm text-[var(--color-rust)]">
              {countError}
            </div>
          )}

          <div className="mb-5 rounded-md border border-dashed border-[var(--color-line)] p-4">
            <form onSubmit={addCountRow} className="mb-3 grid grid-cols-4 gap-3">
              <div className="col-span-2">
                <span className="mb-1 block text-xs font-medium text-[var(--color-ink-soft)]">Product</span>
                <ProductPicker products={products} value={countForm.product_id} onChange={(id) => setCountForm({ ...countForm, product_id: id })} />
              </div>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-[var(--color-ink-soft)]">Counted qty</span>
                <input
                  type="number" step="0.001" min="0" required
                  value={countForm.counted_qty}
                  onChange={(e) => setCountForm({ ...countForm, counted_qty: e.target.value })}
                  className="input"
                />
              </label>
              <button type="submit" className="flex items-end justify-center gap-1.5 rounded-md bg-[var(--color-ink)] py-2 text-sm font-medium text-white">
                <Plus size={15} />
                Add
              </button>
            </form>

            <div className="flex gap-2">
              <button
                onClick={handleDownloadCountTemplate}
                className="flex items-center gap-1.5 rounded-md border border-[var(--color-line)] px-3.5 py-2 text-sm font-medium hover:bg-[var(--color-paper)]"
              >
                <FileDown size={16} />
                Template
              </button>
              <button
                onClick={handleCountImportClick}
                className="flex items-center gap-1.5 rounded-md border border-[var(--color-line)] px-3.5 py-2 text-sm font-medium hover:bg-[var(--color-paper)]"
              >
                <Upload size={16} />
                Import CSV
              </button>
              <input ref={countFileInputRef} type="file" accept=".csv" onChange={handleCountImportFileChange} className="hidden" />
            </div>
          </div>

          {countImportSkipped.length > 0 && (
            <div className="mb-4">
              <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">
                {countImportSkipped.length} row{countImportSkipped.length === 1 ? '' : 's'} skipped from last import
              </div>
              <div className="max-h-32 space-y-1 overflow-y-auto">
                {countImportSkipped.map((s, i) => (
                  <div key={i} className="rounded-md bg-[var(--color-rust-soft)] px-2.5 py-1.5 text-xs text-[var(--color-rust)]">
                    Row {s.rowNum}: {s.reason}
                  </div>
                ))}
              </div>
            </div>
          )}

          {countRows.length > 0 && (
            <>
              <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                <label className="flex-1 block">
                  <span className="mb-1 block text-xs font-medium text-[var(--color-ink-soft)]">
                    Reason (applies to every adjustment posted below)
                  </span>
                  <input
                    value={countReason}
                    onChange={(e) => setCountReason(e.target.value)}
                    placeholder="e.g. End of July 2026 physical count"
                    className="input"
                  />
                </label>
                <label className="flex items-center gap-1.5 whitespace-nowrap pb-2 text-xs">
                  <input type="checkbox" checked={showOnlyMismatches} onChange={(e) => setShowOnlyMismatches(e.target.checked)} />
                  Show only mismatches
                </label>
                <button
                  onClick={postAllCountVariances}
                  disabled={countPosting || pendingVarianceCount === 0}
                  className="whitespace-nowrap rounded-md bg-[var(--color-ink)] px-3.5 py-2 text-sm font-medium text-white disabled:opacity-60"
                >
                  {countPosting ? 'Posting…' : `Post all ${pendingVarianceCount} variance${pendingVarianceCount === 1 ? '' : 's'}`}
                </button>
              </div>

              <div className="overflow-hidden rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)]">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-[var(--color-line)] text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
                    <tr>
                      <SortableTh label="Product" sortKey="product" activeKey={countSortKey} activeDir={countSortDir} onSort={toggleCountSort} />
                      <SortableTh label="Category" sortKey="category" activeKey={countSortKey} activeDir={countSortDir} onSort={toggleCountSort} />
                      <SortableTh label="System Qty" sortKey="systemQty" activeKey={countSortKey} activeDir={countSortDir} onSort={toggleCountSort} />
                      <SortableTh label="Counted Qty" sortKey="countedQty" activeKey={countSortKey} activeDir={countSortDir} onSort={toggleCountSort} />
                      <SortableTh label="Variance" sortKey="variance" activeKey={countSortKey} activeDir={countSortDir} onSort={toggleCountSort} />
                      <SortableTh label="Value Impact" sortKey="valueImpact" activeKey={countSortKey} activeDir={countSortDir} onSort={toggleCountSort} />
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedCountRows.length === 0 && (
                      <tr><td colSpan={7} className="px-4 py-10 text-center text-[var(--color-ink-soft)]">
                        {showOnlyMismatches ? 'No mismatches — everything counted matches the system.' : 'Nothing added yet.'}
                      </td></tr>
                    )}
                    {sortedCountRows.map((row) => {
                      const variance = row.countedQty - row.systemQty
                      const valueImpact = variance * Number(row.product.current_cost ?? 0)
                      return (
                        <tr key={row.tempId} className="border-b border-[var(--color-line)] last:border-0">
                          <td className="px-4 py-3 font-medium">{row.product.name}</td>
                          <td className="px-4 py-3 text-[var(--color-ink-soft)]">{row.product.category || '—'}</td>
                          <td className="px-4 py-3">{row.systemQty} {row.product.unit}</td>
                          <td className="px-4 py-3">{row.countedQty} {row.product.unit}</td>
                          <td className="px-4 py-3">
                            {variance === 0 ? (
                              <StatusChip tone="ok">matches</StatusChip>
                            ) : (
                              <StatusChip tone={variance < 0 ? 'critical' : 'attention'}>
                                {variance > 0 ? '+' : ''}{variance} {row.product.unit}
                              </StatusChip>
                            )}
                          </td>
                          <td className="px-4 py-3">{valueImpact.toFixed(2)}</td>
                          <td className="px-4 py-3">
                            <div className="flex gap-1">
                              {row.posted ? (
                                <span className="flex items-center gap-1 text-xs text-[var(--color-herb)]"><Check size={13} /> posted</span>
                              ) : variance !== 0 ? (
                                <button
                                  onClick={() => postCountRow(row)}
                                  className="rounded-md border border-[var(--color-ink)] px-2 py-1 text-xs font-medium"
                                >
                                  Post
                                </button>
                              ) : null}
                              <button
                                onClick={() => removeCountRow(row.tempId)}
                                aria-label="Remove"
                                className="rounded-md p-1 text-[var(--color-ink-soft)] hover:bg-[var(--color-line)]"
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      <SlidePanel open={panelOpen} title="New adjustment" onClose={() => setPanelOpen(false)}>
        {errorMsg && (
          <div className="mb-4 rounded-md bg-[var(--color-rust-soft)] px-3.5 py-2.5 text-sm text-[var(--color-rust)]">
            {errorMsg}
          </div>
        )}
        <form onSubmit={handleSave} className="space-y-4">
          <Field label="Product" required>
            <ProductPicker products={products} value={productId} onChange={onProductPick} />
          </Field>

          {productId && (
            <>
              <Field label="Adjusting">
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => onLevelChange('product')}
                    className={`flex-1 rounded-md border py-2 text-sm ${level === 'product' ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-white' : 'border-[var(--color-line)]'}`}
                  >
                    Overall product stock
                  </button>
                  <button
                    type="button"
                    onClick={() => onLevelChange('batch')}
                    className={`flex-1 rounded-md border py-2 text-sm ${level === 'batch' ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-white' : 'border-[var(--color-line)]'}`}
                  >
                    Specific batch
                  </button>
                </div>
              </Field>

              {level === 'batch' && (
                <Field label="Batch" required>
                  <select required value={batchId} onChange={(e) => onBatchPick(e.target.value)} className="input">
                    <option value="">Select a batch…</option>
                    {batches.map((b) => (
                      <option key={b.batch_id} value={b.batch_id}>
                        {b.remaining_quantity} {selectedProduct?.unit} remaining (cost {Number(b.unit_cost).toFixed(2)})
                      </option>
                    ))}
                  </select>
                </Field>
              )}

              <div className="grid grid-cols-2 gap-3">
                <Field label="Current (system) value">
                  <input value={oldValue ?? ''} disabled className="input opacity-70" />
                </Field>
                <Field label="Actual counted value" required>
                  <input
                    type="number" step="0.001" required
                    value={newValue}
                    onChange={(e) => setNewValue(e.target.value)}
                    className="input"
                  />
                </Field>
              </div>

              {adjustmentQty !== null && (
                <div className="rounded-md bg-[var(--color-paper)] px-3 py-2 text-sm">
                  This will record a change of{' '}
                  <span className={adjustmentQty < 0 ? 'font-medium text-[var(--color-rust)]' : 'font-medium text-[var(--color-herb)]'}>
                    {adjustmentQty > 0 ? '+' : ''}{adjustmentQty} {selectedProduct?.unit}
                  </span>
                </div>
              )}

              <Field label="Adjustment type" required>
                <select required value={adjustmentType} onChange={(e) => setAdjustmentType(e.target.value)} className="input">
                  <option value="">Select…</option>
                  {adjustmentTypes.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </Field>

              <Field label="Reason" required>
                <input required value={reason} onChange={(e) => setReason(e.target.value)} className="input" placeholder="e.g. Physical count found short" />
              </Field>

              <Field label="Reference number">
                <input value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} className="input" />
              </Field>

              <Field label="Remarks">
                <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={2} className="input resize-none" />
              </Field>

              <button
                type="submit"
                disabled={saving || newValue === ''}
                className="w-full rounded-md bg-[var(--color-ink)] py-2.5 text-sm font-medium text-white disabled:opacity-60"
              >
                {saving ? 'Saving…' : 'Record adjustment'}
              </button>
            </>
          )}
        </form>
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
