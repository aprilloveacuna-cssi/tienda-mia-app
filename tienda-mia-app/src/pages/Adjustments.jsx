import { useEffect, useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import SlidePanel from '../components/SlidePanel'
import StatusChip from '../components/StatusChip'

export default function Adjustments() {
  const [adjustments, setAdjustments] = useState([])
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

  async function loadAdjustments() {
    setLoading(true)
    setErrorMsg('')
    const { data, error } = await supabase
      .from('adjustments')
      .select('*, product:products(name, sku, unit), batch:batches(batch_number)')
      .order('created_at', { ascending: false })
    if (error) {
      setErrorMsg('Could not reach Supabase. Check your .env values and that migrations have run.')
    } else {
      setAdjustments(data ?? [])
    }
    setLoading(false)
  }

  async function loadProducts() {
    const { data } = await supabase
      .from('products')
      .select('id, sku, name, unit')
      .eq('status', 'active')
      .order('name')
    setProducts(data ?? [])
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

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold">Adjustments</h1>
          <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
            Corrects a miscount without touching history — every adjustment writes its own ledger entry, nothing gets edited or deleted.
          </p>
        </div>
        <button
          onClick={openNew}
          className="flex items-center gap-1.5 rounded-md bg-[var(--color-ink)] px-3.5 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          <Plus size={16} />
          New adjustment
        </button>
      </div>

      {errorMsg && !panelOpen && (
        <div className="mb-4 rounded-md bg-[var(--color-rust-soft)] px-3.5 py-2.5 text-sm text-[var(--color-rust)]">
          {errorMsg}
        </div>
      )}

      <div className="overflow-hidden rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)]">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[var(--color-line)] text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
            <tr>
              <th className="px-4 py-3">Adjustment #</th>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Product</th>
              <th className="px-4 py-3">Batch</th>
              <th className="px-4 py-3">Old → New</th>
              <th className="px-4 py-3">Change</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Reason</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-[var(--color-ink-soft)]">Loading adjustments…</td></tr>
            )}
            {!loading && adjustments.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-10 text-center text-[var(--color-ink-soft)]">No adjustments yet — good sign, means nothing's needed correcting.</td></tr>
            )}
            {adjustments.map((a) => {
              const qty = Number(a.adjustment_quantity)
              return (
                <tr key={a.id} className="border-b border-[var(--color-line)] last:border-0">
                  <td className="font-mono px-4 py-3 text-xs text-[var(--color-ink-soft)]">{a.adjustment_number}</td>
                  <td className="px-4 py-3">{a.adjustment_date}</td>
                  <td className="px-4 py-3 font-medium">{a.product?.name}</td>
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

      <SlidePanel open={panelOpen} title="New adjustment" onClose={() => setPanelOpen(false)}>
        {errorMsg && (
          <div className="mb-4 rounded-md bg-[var(--color-rust-soft)] px-3.5 py-2.5 text-sm text-[var(--color-rust)]">
            {errorMsg}
          </div>
        )}
        <form onSubmit={handleSave} className="space-y-4">
          <Field label="Product" required>
            <select required value={productId} onChange={(e) => onProductPick(e.target.value)} className="input">
              <option value="">Select a product…</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>
              ))}
            </select>
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
