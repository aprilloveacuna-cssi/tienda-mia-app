import { Fragment, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Plus, Trash2, Download } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import StatusChip from '../components/StatusChip'
import SortableTh from '../components/SortableTh'
import DisposeConfirm from '../components/DisposeConfirm'
import SearchBar from '../components/SearchBar'
import SlidePanel from '../components/SlidePanel'
import TypeCategoryFilter from '../components/TypeCategoryFilter'
import { useSort, sortRows } from '../lib/sort'
import { normalizeSearchText } from '../lib/search'
import { productTypeGroup } from '../lib/productType'
import { downloadFile } from '../lib/csv'

function stockTone(stock, reorderPoint) {
  if (stock <= 0) return 'critical'
  if (reorderPoint && stock <= reorderPoint) return 'attention'
  return 'ok'
}

function stockLabel(stock, reorderPoint) {
  if (stock <= 0) return 'out of stock'
  if (reorderPoint && stock <= reorderPoint) return 'below reorder point'
  return 'ok'
}

function expiryTone(expirationDate) {
  if (!expirationDate) return 'neutral'
  const days = (new Date(expirationDate) - new Date()) / (1000 * 60 * 60 * 24)
  if (days < 0) return 'critical'
  if (days <= 7) return 'attention'
  return 'ok'
}

function expiryLabel(expirationDate) {
  if (!expirationDate) return 'no expiry'
  const days = Math.ceil((new Date(expirationDate) - new Date()) / (1000 * 60 * 60 * 24))
  if (days < 0) return 'expired'
  if (days === 0) return 'expires today'
  return `${days}d left`
}

export default function Inventory() {
  const [rows, setRows] = useState([])
  const [batchesByProduct, setBatchesByProduct] = useState({})
  const [expanded, setExpanded] = useState(new Set())
  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState('')
  const [disposeBatch, setDisposeBatch] = useState(null)
  const [editingExpiryBatchId, setEditingExpiryBatchId] = useState(null)
  const [expiryDraft, setExpiryDraft] = useState('')
  const [splitPanelOpen, setSplitPanelOpen] = useState(false)
  const [splitContext, setSplitContext] = useState(null) // { batch (full row incl. source_type/received_date), productId, product }
  const [splitRows, setSplitRows] = useState([])
  const [splitSaving, setSplitSaving] = useState(false)
  const [splitError, setSplitError] = useState('')

  const { sortKey, sortDir, toggleSort } = useSort('name')
  function sortAccessor(row, key) {
    if (key === 'sku') return row.product?.sku
    if (key === 'name') return row.product?.name
    if (key === 'category') return row.product?.category
    if (key === 'stock') return Number(row.current_stock ?? 0)
    if (key === 'value') return Number(row.inventory_value ?? 0)
    if (key === 'status') return stockLabel(row.current_stock, row.product?.reorder_point)
    return row[key]
  }
  const sortedRows = sortRows(rows, sortKey, sortDir, sortAccessor)

  const [search, setSearch] = useState('')
  const [extraBarcodesByProduct, setExtraBarcodesByProduct] = useState({}) // product_id -> [barcode, ...]
  const [selectedTypes, setSelectedTypes] = useState([])
  const [selectedCategories, setSelectedCategories] = useState([])

  const searchedRows = search.trim()
    ? sortedRows.filter((r) => {
        const q = normalizeSearchText(search)
        const extraMatch = (extraBarcodesByProduct[r.product_id] ?? []).some((b) => normalizeSearchText(b).includes(q))
        return (
          normalizeSearchText(r.product?.name).includes(q) ||
          normalizeSearchText(r.product?.sku).includes(q) ||
          normalizeSearchText(r.product?.barcode).includes(q) ||
          extraMatch
        )
      })
    : sortedRows
  const filteredRows = searchedRows.filter(
    (r) =>
      (selectedTypes.length === 0 || selectedTypes.includes(productTypeGroup(r.product ?? {}))) &&
      (selectedCategories.length === 0 || selectedCategories.includes(r.product?.category || '(none)'))
  )

  function exportInventoryCsv() {
    const headers = ['SKU', 'Barcode', 'Product', 'Category', 'Stock', 'Unit', 'Value', 'Status']
    const rows = filteredRows.map((r) => [
      r.product?.sku ?? '',
      r.product?.barcode ?? '',
      r.product?.name ?? '',
      r.product?.category ?? '',
      Number(r.current_stock ?? 0),
      r.product?.unit ?? '',
      Number(r.inventory_value ?? 0).toFixed(2),
      stockLabel(r.current_stock, r.product?.reorder_point),
    ])
    const csv = [headers, ...rows]
      .map((row) => row.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\n')
    downloadFile(`inventory_${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv;charset=utf-8;')
  }

  async function load() {
    setLoading(true)
    setErrorMsg('')
    const { data, error } = await supabase
      .from('inventory_cache')
      .select('*, product:products(name, sku, barcode, unit, reorder_point, category, business_unit, product_type)')

    if (error) {
      setErrorMsg('Could not reach Supabase. Check your .env values and that migrations have run.')
      setLoading(false)
      return
    }

    const sorted = (data ?? [])
      .filter((r) => r.product) // guard against orphaned rows
      .sort((a, b) => a.product.name.localeCompare(b.product.name))
    setRows(sorted)
    setLoading(false)
  }

  async function loadExtraBarcodes() {
    const { data, error } = await supabase.from('product_barcodes').select('product_id, barcode')
    if (error) {
      setErrorMsg(`Could not load additional barcodes — search won't match them until this is fixed: ${error.message}`)
      return
    }
    const map = {}
    for (const row of data ?? []) {
      if (!map[row.product_id]) map[row.product_id] = []
      map[row.product_id].push(row.barcode)
    }
    setExtraBarcodesByProduct(map)
  }

  useEffect(() => {
    load()
    loadExtraBarcodes()
  }, [])

  async function fetchBatches(productId) {
    const { data } = await supabase
      .from('batch_cache')
      .select('*, batch:batches(batch_number)')
      .eq('product_id', productId)
      .order('fifo_sequence')
    setBatchesByProduct((prev) => ({ ...prev, [productId]: data ?? [] }))
  }

  async function toggleExpand(productId) {
    const next = new Set(expanded)
    if (next.has(productId)) {
      next.delete(productId)
    } else {
      next.add(productId)
      if (!batchesByProduct[productId]) {
        await fetchBatches(productId)
      }
    }
    setExpanded(next)
  }

  function openDispose(batch, row) {
    setDisposeBatch({
      batch_id: batch.batch_id,
      product_id: row.product_id,
      product_name: row.product?.name,
      batch_number: batch.batch?.batch_number,
      unit: row.product?.unit,
      remaining_quantity: Number(batch.remaining_quantity),
      unit_cost: Number(batch.unit_cost),
      expiration_date: batch.expiration_date,
    })
  }

  function startEditExpiry(batch) {
    setEditingExpiryBatchId(batch.batch_id)
    setExpiryDraft(batch.expiration_date ?? '')
  }

  function cancelEditExpiry() {
    setEditingExpiryBatchId(null)
    setExpiryDraft('')
  }

  async function saveExpiryEdit(batch, productId) {
    const newDate = expiryDraft || null
    const { error } = await supabase.from('batches').update({ expiration_date: newDate }).eq('id', batch.batch_id)
    if (error) {
      setErrorMsg(error.message)
      return
    }
    // batch_cache is a snapshot that only refreshes when a ledger row is
    // written — a direct edit to batches doesn't trigger that, so it has to
    // be updated here too or the screen just keeps showing the old date.
    await supabase.from('batch_cache').update({ expiration_date: newDate }).eq('batch_id', batch.batch_id)
    await fetchBatches(productId)
    setEditingExpiryBatchId(null)
    setExpiryDraft('')
  }

  async function openSplitPanel(batch, row) {
    setSplitError('')
    // batch_cache doesn't carry source_type/received_date — need the real
    // batches row so the new split-off batches match it exactly.
    const { data: fullBatch, error } = await supabase
      .from('batches')
      .select('id, batch_number, source_type, received_date, unit_cost, expiration_date')
      .eq('id', batch.batch_id)
      .single()
    if (error) {
      setErrorMsg(error.message)
      return
    }
    setSplitContext({
      batch: { ...fullBatch, remaining_quantity: Number(batch.remaining_quantity) },
      productId: row.product_id,
      product: row.product,
    })
    setSplitRows([{ tempId: crypto.randomUUID(), quantity: '', expiration_date: '' }])
    setSplitPanelOpen(true)
  }

  function addSplitRow() {
    setSplitRows([...splitRows, { tempId: crypto.randomUUID(), quantity: '', expiration_date: '' }])
  }

  function removeSplitRow(tempId) {
    setSplitRows(splitRows.filter((r) => r.tempId !== tempId))
  }

  function updateSplitRow(tempId, field, value) {
    setSplitRows(splitRows.map((r) => (r.tempId === tempId ? { ...r, [field]: value } : r)))
  }

  const splitAllocated = splitRows.reduce((sum, r) => sum + (Number(r.quantity) || 0), 0)
  const splitRemainder = splitContext ? splitContext.batch.remaining_quantity - splitAllocated : 0

  async function saveSplit() {
    if (!splitContext) return
    const validRows = splitRows.filter((r) => Number(r.quantity) > 0 && r.expiration_date)
    if (validRows.length === 0) {
      setSplitError('Add at least one date with a quantity.')
      return
    }
    if (splitAllocated > splitContext.batch.remaining_quantity) {
      setSplitError(`Allocated ${splitAllocated} exceeds the ${splitContext.batch.remaining_quantity} actually remaining in this batch.`)
      return
    }
    setSplitSaving(true)
    setSplitError('')

    const { batch, productId } = splitContext

    for (const row of validRows) {
      const qty = Number(row.quantity)
      // The new batch matches the original in every way except quantity and
      // expiration date — same received date, same source, same unit cost.
      const { data: newBatch, error: batchErr } = await supabase
        .from('batches')
        .insert({
          product_id: productId,
          source_type: batch.source_type,
          received_date: batch.received_date,
          unit_cost: batch.unit_cost,
          expiration_date: row.expiration_date,
        })
        .select()
        .single()

      if (batchErr) {
        setSplitError(`Could not create split batch: ${batchErr.message}`)
        setSplitSaving(false)
        return
      }

      // Goes through adjustments (not a direct ledger insert) so it posts to
      // the ledger via the existing trigger, keeps caches in sync properly,
      // and shows up in the Adjustments log for a real audit trail.
      const { error: adjErr } = await supabase.from('adjustments').insert({
        product_id: productId,
        batch_id: newBatch.id,
        adjustment_type: 'Count Correction',
        reason: `Split from ${batch.batch_number}`,
        old_value: 0,
        new_value: qty,
      })
      if (adjErr) {
        setSplitError(`Batch created but couldn't credit its quantity: ${adjErr.message}`)
        setSplitSaving(false)
        await fetchBatches(productId)
        return
      }
    }

    const { error: reduceErr } = await supabase.from('adjustments').insert({
      product_id: productId,
      batch_id: batch.id,
      adjustment_type: 'Count Correction',
      reason: `Split into ${validRows.length} expiration date${validRows.length === 1 ? '' : 's'}`,
      old_value: batch.remaining_quantity,
      new_value: batch.remaining_quantity - splitAllocated,
    })
    if (reduceErr) {
      setSplitError(`Split batches created, but the original batch's quantity couldn't be reduced: ${reduceErr.message}`)
      setSplitSaving(false)
      await fetchBatches(productId)
      return
    }

    setSplitSaving(false)
    setSplitPanelOpen(false)
    setSplitContext(null)
    setSplitRows([])
    await fetchBatches(productId)
    await load()
  }

  async function handleDisposed(productId) {
    await fetchBatches(productId)
    await load()
  }

  const totalValue = useMemo(
    () => filteredRows.reduce((sum, r) => sum + Number(r.inventory_value ?? 0), 0),
    [filteredRows]
  )

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold">Inventory</h1>
          <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
            Read-only — computed from every posted purchase, sale, and adjustment. Nothing here is hand-edited.
          </p>
        </div>
        <button
          onClick={exportInventoryCsv}
          disabled={filteredRows.length === 0}
          className="flex items-center gap-1.5 rounded-md border border-[var(--color-line)] px-3.5 py-2 text-sm font-medium hover:bg-[var(--color-paper)] disabled:opacity-50"
        >
          <Download size={16} />
          Export CSV
        </button>
      </div>

      {errorMsg && (
        <div className="mb-4 rounded-md bg-[var(--color-rust-soft)] px-3.5 py-2.5 text-sm text-[var(--color-rust)]">
          {errorMsg}
        </div>
      )}

      {!loading && rows.length > 0 && (
        <div className="mb-4 rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)] p-4">
          <div className="text-xs font-medium text-[var(--color-ink-soft)]">Total inventory value</div>
          <div className="font-display mt-1 text-2xl font-semibold">{totalValue.toFixed(2)}</div>
        </div>
      )}

      <TypeCategoryFilter
        products={rows.map((r) => r.product ?? {})}
        selectedTypes={selectedTypes}
        setSelectedTypes={setSelectedTypes}
        selectedCategories={selectedCategories}
        setSelectedCategories={setSelectedCategories}
      />

      <SearchBar value={search} onChange={setSearch} placeholder="Search by name, SKU, or barcode" />

      <div className="overflow-hidden rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)]">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[var(--color-line)] text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
            <tr>
              <th className="w-8 px-4 py-3" />
              <SortableTh label="SKU" sortKey="sku" activeKey={sortKey} activeDir={sortDir} onSort={toggleSort} />
              <SortableTh label="Product" sortKey="name" activeKey={sortKey} activeDir={sortDir} onSort={toggleSort} />
              <SortableTh label="Category" sortKey="category" activeKey={sortKey} activeDir={sortDir} onSort={toggleSort} />
              <SortableTh label="Stock" sortKey="stock" activeKey={sortKey} activeDir={sortDir} onSort={toggleSort} />
              <SortableTh label="Value" sortKey="value" activeKey={sortKey} activeDir={sortDir} onSort={toggleSort} />
              <SortableTh label="Status" sortKey="status" activeKey={sortKey} activeDir={sortDir} onSort={toggleSort} />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-[var(--color-ink-soft)]">
                  Loading inventory…
                </td>
              </tr>
            )}

            {!loading && filteredRows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-[var(--color-ink-soft)]">
                  No stock movements yet — post a purchase to see inventory appear here.
                </td>
              </tr>
            )}

            {filteredRows.map((r) => (
              <Fragment key={r.product_id}>
                <tr
                  onClick={() => toggleExpand(r.product_id)}
                  className="cursor-pointer border-b border-[var(--color-line)] last:border-0 hover:bg-[var(--color-paper)]"
                >
                  <td className="px-4 py-3 text-[var(--color-ink-soft)]">
                    {expanded.has(r.product_id) ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  </td>
                  <td className="font-mono px-4 py-3 text-xs text-[var(--color-ink-soft)]">
                    {r.product.sku}
                  </td>
                  <td className="px-4 py-3 font-medium">{r.product.name}</td>
                  <td className="px-4 py-3 text-[var(--color-ink-soft)]">{r.product.category || '—'}</td>
                  <td className="px-4 py-3">
                    {Number(r.current_stock)} {r.product.unit}
                  </td>
                  <td className="px-4 py-3">{Number(r.inventory_value).toFixed(2)}</td>
                  <td className="px-4 py-3">
                    <StatusChip tone={stockTone(r.current_stock, r.product.reorder_point)}>
                      {stockLabel(r.current_stock, r.product.reorder_point)}
                    </StatusChip>
                  </td>
                </tr>
                {expanded.has(r.product_id) && (
                  <tr className="border-b border-[var(--color-line)] bg-[var(--color-paper)] last:border-0">
                    <td />
                    <td colSpan={6} className="px-4 py-3">
                      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">
                        Batches (oldest first — FIFO order)
                      </div>
                      {(batchesByProduct[r.product_id] ?? []).length === 0 ? (
                        <p className="text-sm text-[var(--color-ink-soft)]">No active batches.</p>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {batchesByProduct[r.product_id]
                            .filter((b) => Number(b.remaining_quantity) > 0)
                            .map((b) => (
                              <div
                                key={b.batch_id}
                                className="rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-3 py-2 text-xs"
                              >
                                <div className="font-medium">{Number(b.remaining_quantity)} left</div>
                                <div className="text-[var(--color-ink-soft)]">cost {Number(b.unit_cost).toFixed(2)}</div>

                                {editingExpiryBatchId === b.batch_id ? (
                                  <div className="mt-1.5 space-y-1.5">
                                    <input
                                      type="date"
                                      value={expiryDraft}
                                      onChange={(e) => setExpiryDraft(e.target.value)}
                                      className="input w-full py-1 text-xs"
                                    />
                                    <div className="flex gap-1">
                                      <button
                                        onClick={() => saveExpiryEdit(b, r.product_id)}
                                        className="flex-1 rounded-md bg-[var(--color-ink)] py-1 text-center text-[10px] font-medium text-white"
                                      >
                                        Save
                                      </button>
                                      <button
                                        onClick={cancelEditExpiry}
                                        className="flex-1 rounded-md border border-[var(--color-line)] py-1 text-center text-[10px] font-medium"
                                      >
                                        Cancel
                                      </button>
                                    </div>
                                  </div>
                                ) : (
                                  <>
                                    <div className="mt-1 flex items-center gap-1.5">
                                      <StatusChip tone={expiryTone(b.expiration_date)}>
                                        {expiryLabel(b.expiration_date)}
                                      </StatusChip>
                                      {b.expiration_date && (
                                        <span className="text-[var(--color-ink-soft)]">{b.expiration_date}</span>
                                      )}
                                    </div>
                                    <div className="mt-1.5 flex gap-1">
                                      <button
                                        onClick={() => startEditExpiry(b)}
                                        className="flex-1 rounded-md border border-[var(--color-line)] py-1 text-center text-[10px] font-medium text-[var(--color-ink-soft)] hover:bg-[var(--color-paper)]"
                                      >
                                        Edit date
                                      </button>
                                      <button
                                        onClick={() => openSplitPanel(b, r)}
                                        className="flex-1 rounded-md border border-[var(--color-line)] py-1 text-center text-[10px] font-medium text-[var(--color-ink-soft)] hover:bg-[var(--color-paper)]"
                                      >
                                        Split
                                      </button>
                                      {b.expiration_date && (
                                        <button
                                          onClick={() => openDispose(b, r)}
                                          className="flex-1 rounded-md border border-[var(--color-rust)] py-1 text-center text-[10px] font-medium text-[var(--color-rust)] hover:bg-[var(--color-rust-soft)]"
                                        >
                                          Dispose
                                        </button>
                                      )}
                                    </div>
                                  </>
                                )}
                              </div>
                            ))}
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <DisposeConfirm
        open={!!disposeBatch}
        batch={disposeBatch}
        onClose={() => setDisposeBatch(null)}
        onDisposed={() => disposeBatch && handleDisposed(disposeBatch.product_id)}
      />

      <SlidePanel
        open={splitPanelOpen}
        title="Split batch by expiration date"
        onClose={() => setSplitPanelOpen(false)}
      >
        {splitContext && (
          <div className="space-y-4">
            <div className="rounded-md border border-[var(--color-line)] bg-[var(--color-paper)] px-3 py-2 text-sm">
              <div className="font-medium">{splitContext.product?.name}</div>
              <div className="text-xs text-[var(--color-ink-soft)]">
                {splitContext.batch.batch_number} — {splitContext.batch.remaining_quantity} {splitContext.product?.unit} currently remaining
              </div>
            </div>

            {splitError && (
              <div className="rounded-md bg-[var(--color-rust-soft)] px-3 py-2 text-xs text-[var(--color-rust)]">
                {splitError}
              </div>
            )}

            <div className="space-y-2">
              {splitRows.map((row) => (
                <div key={row.tempId} className="flex items-end gap-2">
                  <label className="flex-1 block">
                    <span className="mb-1 block text-xs font-medium text-[var(--color-ink-soft)]">Quantity</span>
                    <input
                      type="number" step="0.001" min="0"
                      value={row.quantity}
                      onChange={(e) => updateSplitRow(row.tempId, 'quantity', e.target.value)}
                      className="input"
                    />
                  </label>
                  <label className="flex-1 block">
                    <span className="mb-1 block text-xs font-medium text-[var(--color-ink-soft)]">Expiration date</span>
                    <input
                      type="date"
                      value={row.expiration_date}
                      onChange={(e) => updateSplitRow(row.tempId, 'expiration_date', e.target.value)}
                      className="input"
                    />
                  </label>
                  <button
                    onClick={() => removeSplitRow(row.tempId)}
                    aria-label="Remove date"
                    className="rounded-md p-2 text-[var(--color-ink-soft)] hover:bg-[var(--color-line)]"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>

            <button
              onClick={addSplitRow}
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--color-ink)] py-2 text-sm font-medium"
            >
              <Plus size={15} />
              Add another date
            </button>

            <div className={`rounded-md px-3 py-2 text-xs ${splitRemainder < 0 ? 'bg-[var(--color-rust-soft)] text-[var(--color-rust)]' : 'bg-[var(--color-paper)] text-[var(--color-ink-soft)]'}`}>
              {splitRemainder < 0
                ? `Over-allocated by ${Math.abs(splitRemainder)} ${splitContext.product?.unit} — reduce a quantity above.`
                : splitRemainder === 0
                  ? `Fully allocated — nothing stays on the original date.`
                  : `${splitRemainder} ${splitContext.product?.unit} will stay on the original date (${splitContext.batch.expiration_date ?? 'no date set'}) — unless allocated above.`}
            </div>

            <button
              onClick={saveSplit}
              disabled={splitSaving || splitRemainder < 0}
              className="w-full rounded-md bg-[var(--color-ink)] py-2.5 text-sm font-medium text-white disabled:opacity-60"
            >
              {splitSaving ? 'Splitting…' : 'Save split'}
            </button>
          </div>
        )}
      </SlidePanel>
    </div>
  )
}
