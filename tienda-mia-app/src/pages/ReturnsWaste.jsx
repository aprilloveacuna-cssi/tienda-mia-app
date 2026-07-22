import { useEffect, useState } from 'react'
import { Plus, RotateCcw, Trash } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { fetchAllRows } from '../lib/fetchAllRows'
import SlidePanel from '../components/SlidePanel'
import StatusChip from '../components/StatusChip'
import SortableTh from '../components/SortableTh'
import { useSort, sortRows } from '../lib/sort'

export default function ReturnsWaste() {
  const [tab, setTab] = useState('returns')
  const [returns, setReturns] = useState([])
  const [wastes, setWastes] = useState([])

  const { sortKey: returnSortKey, sortDir: returnSortDir, toggleSort: toggleReturnSort } = useSort('return_date', 'desc')
  function returnSortAccessor(row, key) {
    if (key === 'product') return row.product?.name
    if (key === 'quantity') return Number(row.quantity ?? 0)
    if (key === 'restock') return row.restock ? 1 : 0
    return row[key]
  }
  const sortedReturns = sortRows(returns, returnSortKey, returnSortDir, returnSortAccessor)

  const { sortKey: wasteSortKey, sortDir: wasteSortDir, toggleSort: toggleWasteSort } = useSort('waste_date', 'desc')
  function wasteSortAccessor(row, key) {
    if (key === 'product') return row.product?.name
    if (key === 'quantity') return Number(row.quantity ?? 0)
    if (key === 'disposed_by') return row.disposed_by ?? ''
    return row[key]
  }
  const sortedWastes = sortRows(wastes, wasteSortKey, wasteSortDir, wasteSortAccessor)
  const [products, setProducts] = useState([])
  const [returnReasons, setReturnReasons] = useState([])
  const [wasteReasons, setWasteReasons] = useState([])
  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState('')

  const [panelOpen, setPanelOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  // shared product/batch picking
  const [productId, setProductId] = useState('')
  const [batches, setBatches] = useState([])
  const [batchId, setBatchId] = useState('')
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState('')

  // return-only
  const [returnType, setReturnType] = useState('Customer')
  const [restock, setRestock] = useState(true)

  // waste-only
  const [disposedBy, setDisposedBy] = useState('')
  const [remarks, setRemarks] = useState('')

  async function loadAll() {
    setLoading(true)
    setErrorMsg('')
    const [returnsRes, wastesRes, productsRes, returnReasonsRes, wasteReasonsRes] = await Promise.all([
      fetchAllRows('returns', '*, product:products(name, sku, unit)', 'created_at', { ascending: false }),
      fetchAllRows('waste', '*, product:products(name, sku, unit), batch:batches(batch_number)', 'created_at', { ascending: false }),
      fetchAllRows('products', 'id, sku, name, unit, current_cost, status', 'name'),
      supabase.from('lists').select('value').eq('list_type', 'ReturnReason').eq('active', true).order('value'),
      supabase.from('lists').select('value').eq('list_type', 'WasteReason').eq('active', true).order('value'),
    ])

    if (returnsRes.error || wastesRes.error || productsRes.error) {
      setErrorMsg('Could not reach Supabase. Check your .env values and that migrations have run.')
      setLoading(false)
      return
    }
    setReturns(returnsRes.data ?? [])
    setWastes(wastesRes.data ?? [])
    setProducts((productsRes.data ?? []).filter((p) => p.status === 'active'))
    setReturnReasons((returnReasonsRes.data ?? []).map((r) => r.value))
    setWasteReasons((wasteReasonsRes.data ?? []).map((r) => r.value))
    setLoading(false)
  }

  useEffect(() => {
    loadAll()
  }, [])

  function resetForm() {
    setProductId('')
    setBatches([])
    setBatchId('')
    setQuantity('')
    setReason('')
    setReturnType('Customer')
    setRestock(true)
    setDisposedBy('')
    setRemarks('')
    setErrorMsg('')
  }

  function openNew() {
    resetForm()
    setPanelOpen(true)
  }

  async function onProductPick(id) {
    setProductId(id)
    setBatchId('')
    setQuantity('')
    const { data } = await supabase
      .from('batch_cache')
      .select('*')
      .eq('product_id', id)
      .gt('remaining_quantity', 0)
      .order('fifo_sequence')
    setBatches(data ?? [])
  }

  const selectedProduct = products.find((p) => p.id === productId)
  const selectedBatch = batches.find((b) => b.batch_id === batchId)

  const needsBatch = tab === 'waste' || (tab === 'returns' && returnType === 'Supplier')

  async function handleSaveReturn(e) {
    e.preventDefault()
    if (!productId || !quantity || !reason) return
    if (returnType === 'Supplier' && !batchId) {
      setErrorMsg('Pick which batch this is being returned from.')
      return
    }
    setSaving(true)
    setErrorMsg('')

    const qty = Number(quantity)
    const { data: ret, error: retErr } = await supabase
      .from('returns')
      .insert({
        return_type: returnType,
        product_id: productId,
        quantity: qty,
        reason,
        restock: returnType === 'Customer' ? restock : false,
      })
      .select()
      .single()

    if (retErr) {
      setErrorMsg(retErr.message)
      setSaving(false)
      return
    }

    // Customer return, restocked: adds stock back at current cost, no specific batch
    // Supplier return: always reduces stock, drawn from the chosen batch
    let ledgerRow = null
    if (returnType === 'Customer' && restock) {
      ledgerRow = {
        product_id: productId,
        batch_id: null,
        transaction_type: 'Return',
        quantity_change: qty,
        unit_cost_at_transaction: Number(selectedProduct?.current_cost ?? 0),
        source_module: 'Returns',
        source_reference_id: ret.id,
      }
    } else if (returnType === 'Supplier') {
      ledgerRow = {
        product_id: productId,
        batch_id: batchId,
        transaction_type: 'Return',
        quantity_change: -qty,
        unit_cost_at_transaction: Number(selectedBatch?.unit_cost ?? 0),
        source_module: 'Returns',
        source_reference_id: ret.id,
      }
    }

    if (ledgerRow) {
      const { error: ledgerErr } = await supabase.from('inventory_ledger').insert(ledgerRow)
      if (ledgerErr) {
        setErrorMsg(`Return recorded but inventory wasn't updated: ${ledgerErr.message}`)
        setSaving(false)
        loadAll()
        return
      }
    }

    setSaving(false)
    setPanelOpen(false)
    loadAll()
  }

  async function handleSaveWaste(e) {
    e.preventDefault()
    if (!productId || !batchId || !quantity || !reason) return
    const qty = Number(quantity)
    if (selectedBatch && qty > Number(selectedBatch.remaining_quantity)) {
      setErrorMsg(`Only ${selectedBatch.remaining_quantity} ${selectedProduct?.unit} left in that batch.`)
      return
    }
    setSaving(true)
    setErrorMsg('')

    const { data: w, error: wErr } = await supabase
      .from('waste')
      .insert({
        product_id: productId,
        batch_id: batchId,
        quantity: qty,
        reason,
        disposed_by: disposedBy.trim() || null,
        remarks: remarks.trim() || null,
      })
      .select()
      .single()

    if (wErr) {
      setErrorMsg(wErr.message)
      setSaving(false)
      return
    }

    const { error: ledgerErr } = await supabase.from('inventory_ledger').insert({
      product_id: productId,
      batch_id: batchId,
      transaction_type: 'Waste',
      quantity_change: -qty,
      unit_cost_at_transaction: Number(selectedBatch?.unit_cost ?? 0),
      source_module: 'Waste',
      source_reference_id: w.id,
    })
    if (ledgerErr) {
      setErrorMsg(`Waste recorded but inventory wasn't updated: ${ledgerErr.message}`)
      setSaving(false)
      loadAll()
      return
    }

    setSaving(false)
    setPanelOpen(false)
    loadAll()
  }

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold">Returns &amp; Waste</h1>
          <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
            Both write their own ledger entry — nothing here silently edits stock elsewhere.
          </p>
        </div>
        <button
          onClick={openNew}
          className="flex items-center gap-1.5 rounded-md bg-[var(--color-ink)] px-3.5 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          <Plus size={16} />
          New {tab === 'returns' ? 'return' : 'waste entry'}
        </button>
      </div>

      <div className="mb-4 flex gap-1 border-b border-[var(--color-line)]">
        {['returns', 'waste'].map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm font-medium capitalize ${
              tab === t
                ? 'border-b-2 border-[var(--color-ink)] text-[var(--color-ink)]'
                : 'text-[var(--color-ink-soft)]'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {errorMsg && !panelOpen && (
        <div className="mb-4 rounded-md bg-[var(--color-rust-soft)] px-3.5 py-2.5 text-sm text-[var(--color-rust)]">
          {errorMsg}
        </div>
      )}

      {tab === 'returns' ? (
        <div className="overflow-hidden rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)]">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[var(--color-line)] text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
              <tr>
                <SortableTh label="Return #" sortKey="return_number" activeKey={returnSortKey} activeDir={returnSortDir} onSort={toggleReturnSort} />
                <SortableTh label="Date" sortKey="return_date" activeKey={returnSortKey} activeDir={returnSortDir} onSort={toggleReturnSort} />
                <SortableTh label="Type" sortKey="return_type" activeKey={returnSortKey} activeDir={returnSortDir} onSort={toggleReturnSort} />
                <SortableTh label="Product" sortKey="product" activeKey={returnSortKey} activeDir={returnSortDir} onSort={toggleReturnSort} />
                <SortableTh label="Qty" sortKey="quantity" activeKey={returnSortKey} activeDir={returnSortDir} onSort={toggleReturnSort} />
                <th className="px-4 py-3">Reason</th>
                <SortableTh label="Restocked" sortKey="restock" activeKey={returnSortKey} activeDir={returnSortDir} onSort={toggleReturnSort} />
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={7} className="px-4 py-8 text-center text-[var(--color-ink-soft)]">Loading…</td></tr>}
              {!loading && sortedReturns.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-[var(--color-ink-soft)]">No returns recorded yet.</td></tr>
              )}
              {sortedReturns.map((r) => (
                <tr key={r.id} className="border-b border-[var(--color-line)] last:border-0">
                  <td className="font-mono px-4 py-3 text-xs text-[var(--color-ink-soft)]">{r.return_number}</td>
                  <td className="px-4 py-3">{r.return_date}</td>
                  <td className="px-4 py-3">
                    <StatusChip tone={r.return_type === 'Customer' ? 'ok' : 'attention'}>{r.return_type}</StatusChip>
                  </td>
                  <td className="px-4 py-3 font-medium">{r.product?.name}</td>
                  <td className="px-4 py-3">{r.quantity} {r.product?.unit}</td>
                  <td className="px-4 py-3 text-[var(--color-ink-soft)]">{r.reason}</td>
                  <td className="px-4 py-3">
                    <StatusChip tone={r.restock ? 'ok' : 'neutral'}>{r.restock ? 'Yes' : 'No'}</StatusChip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)]">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[var(--color-line)] text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
              <tr>
                <SortableTh label="Waste #" sortKey="waste_number" activeKey={wasteSortKey} activeDir={wasteSortDir} onSort={toggleWasteSort} />
                <SortableTh label="Date" sortKey="waste_date" activeKey={wasteSortKey} activeDir={wasteSortDir} onSort={toggleWasteSort} />
                <SortableTh label="Product" sortKey="product" activeKey={wasteSortKey} activeDir={wasteSortDir} onSort={toggleWasteSort} />
                <th className="px-4 py-3">Batch</th>
                <SortableTh label="Qty" sortKey="quantity" activeKey={wasteSortKey} activeDir={wasteSortDir} onSort={toggleWasteSort} />
                <th className="px-4 py-3">Reason</th>
                <SortableTh label="Disposed by" sortKey="disposed_by" activeKey={wasteSortKey} activeDir={wasteSortDir} onSort={toggleWasteSort} />
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={7} className="px-4 py-8 text-center text-[var(--color-ink-soft)]">Loading…</td></tr>}
              {!loading && sortedWastes.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-[var(--color-ink-soft)]">No waste recorded yet.</td></tr>
              )}
              {sortedWastes.map((w) => (
                <tr key={w.id} className="border-b border-[var(--color-line)] last:border-0">
                  <td className="font-mono px-4 py-3 text-xs text-[var(--color-ink-soft)]">{w.waste_number}</td>
                  <td className="px-4 py-3">{w.waste_date}</td>
                  <td className="px-4 py-3 font-medium">{w.product?.name}</td>
                  <td className="font-mono px-4 py-3 text-xs text-[var(--color-ink-soft)]">{w.batch?.batch_number ?? '—'}</td>
                  <td className="px-4 py-3">
                    <StatusChip tone="critical">-{w.quantity} {w.product?.unit}</StatusChip>
                  </td>
                  <td className="px-4 py-3 text-[var(--color-ink-soft)]">{w.reason}</td>
                  <td className="px-4 py-3 text-[var(--color-ink-soft)]">{w.disposed_by || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SlidePanel
        open={panelOpen}
        title={tab === 'returns' ? 'New return' : 'New waste entry'}
        onClose={() => setPanelOpen(false)}
      >
        {errorMsg && (
          <div className="mb-4 rounded-md bg-[var(--color-rust-soft)] px-3.5 py-2.5 text-sm text-[var(--color-rust)]">
            {errorMsg}
          </div>
        )}

        <form onSubmit={tab === 'returns' ? handleSaveReturn : handleSaveWaste} className="space-y-4">
          {tab === 'returns' && (
            <Field label="Return type">
              <div className="flex gap-2">
                {['Customer', 'Supplier'].map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => { setReturnType(t); setBatchId('') }}
                    className={`flex-1 rounded-md border py-2 text-sm ${returnType === t ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-white' : 'border-[var(--color-line)]'}`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </Field>
          )}

          <Field label="Product" required>
            <select required value={productId} onChange={(e) => onProductPick(e.target.value)} className="input">
              <option value="">Select a product…</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>
              ))}
            </select>
          </Field>

          {productId && needsBatch && (
            <Field label="Batch" required>
              <select required value={batchId} onChange={(e) => setBatchId(e.target.value)} className="input">
                <option value="">Select a batch…</option>
                {batches.map((b) => (
                  <option key={b.batch_id} value={b.batch_id}>
                    {b.remaining_quantity} {selectedProduct?.unit} remaining (cost {Number(b.unit_cost).toFixed(2)})
                    {b.expiration_date ? ` — exp ${b.expiration_date}` : ''}
                  </option>
                ))}
              </select>
              {batches.length === 0 && (
                <span className="mt-1 block text-xs text-[var(--color-rust)]">No stock available for this product.</span>
              )}
            </Field>
          )}

          {productId && (
            <Field label="Quantity" required>
              <input
                type="number" step="0.001" min="0" required
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className="input"
              />
            </Field>
          )}

          {productId && (
            <Field label="Reason" required>
              <select required value={reason} onChange={(e) => setReason(e.target.value)} className="input">
                <option value="">Select…</option>
                {(tab === 'returns' ? returnReasons : wasteReasons).map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </Field>
          )}

          {tab === 'returns' && returnType === 'Customer' && productId && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} />
              Restock this item (adds it back to sellable inventory)
            </label>
          )}

          {tab === 'waste' && productId && (
            <>
              <Field label="Disposed by">
                <input value={disposedBy} onChange={(e) => setDisposedBy(e.target.value)} className="input" />
              </Field>
              <Field label="Remarks">
                <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={2} className="input resize-none" />
              </Field>
            </>
          )}

          {productId && (
            <button
              type="submit"
              disabled={saving}
              className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--color-ink)] py-2.5 text-sm font-medium text-white disabled:opacity-60"
            >
              {tab === 'returns' ? <RotateCcw size={15} /> : <Trash size={15} />}
              {saving ? 'Saving…' : tab === 'returns' ? 'Record return' : 'Record waste'}
            </button>
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
