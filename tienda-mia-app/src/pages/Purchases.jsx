import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2, Send, Ban } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import SlidePanel from '../components/SlidePanel'
import StatusChip from '../components/StatusChip'
import ProductPicker from '../components/ProductPicker'

const EMPTY_HEADER = { purchase_date: today(), invoice_number: '', supplier: '' }
const EMPTY_LINE = { product_id: '', quantity: '', unit_cost: '', expiration_date: '' }
const EMPTY_QUICK_PRODUCT = { barcode: '', name: '', unit: '', selling_price: '' }

function today() {
  return new Date().toISOString().slice(0, 10)
}

function statusTone(status) {
  if (status === 'posted') return 'ok'
  if (status === 'voided') return 'critical'
  return 'neutral'
}

export default function Purchases() {
  const [purchases, setPurchases] = useState([])
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState('')

  const [panelOpen, setPanelOpen] = useState(false)
  const [selected, setSelected] = useState(null) // the purchase header row, once saved
  const [lines, setLines] = useState([])
  const [headerForm, setHeaderForm] = useState(EMPTY_HEADER)
  const [lineForm, setLineForm] = useState(EMPTY_LINE)
  const [saving, setSaving] = useState(false)

  const [quickAddOpen, setQuickAddOpen] = useState(false)
  const [quickAddForm, setQuickAddForm] = useState(EMPTY_QUICK_PRODUCT)
  const [quickAddSaving, setQuickAddSaving] = useState(false)
  const [quickAddError, setQuickAddError] = useState('')

  async function loadPurchases() {
    setLoading(true)
    setErrorMsg('')
    const { data, error } = await supabase
      .from('purchases')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) {
      setErrorMsg('Could not reach Supabase. Check your .env values and that migrations have run.')
    } else {
      setPurchases(data ?? [])
    }
    setLoading(false)
  }

  async function loadProducts() {
    const { data, error } = await supabase
      .from('products')
      .select('id, sku, name, unit, barcode')
      .eq('status', 'active')
      .order('name')
    if (!error) setProducts(data ?? [])
  }

  function openQuickAdd() {
    setQuickAddForm(EMPTY_QUICK_PRODUCT)
    setQuickAddError('')
    setQuickAddOpen(true)
  }

  async function handleQuickAddProduct(e) {
    e.preventDefault()
    if (!quickAddForm.barcode.trim() || !quickAddForm.name.trim()) return
    setQuickAddSaving(true)
    setQuickAddError('')

    const { data, error } = await supabase
      .from('products')
      .insert({
        barcode: quickAddForm.barcode.trim(),
        name: quickAddForm.name.trim().toUpperCase(),
        unit: quickAddForm.unit.trim() ? quickAddForm.unit.trim().toUpperCase() : null,
        selling_price: quickAddForm.selling_price === '' ? 0 : Number(quickAddForm.selling_price),
      })
      .select()
      .single()

    setQuickAddSaving(false)
    if (error) {
      setQuickAddError(
        error.code === '23505' ? 'That barcode is already assigned to another product.' : error.message
      )
      return
    }

    // Drop it straight into the product list and select it for this line —
    // no need to leave the purchase, or wait on a full Products reload.
    setProducts((prev) => [...prev, { id: data.id, sku: data.sku, name: data.name, unit: data.unit, barcode: data.barcode }].sort((a, b) => a.name.localeCompare(b.name)))
    setLineForm({ ...lineForm, product_id: data.id })
    setQuickAddOpen(false)
  }

  async function loadLines(purchaseId) {
    const { data, error } = await supabase
      .from('purchase_lines')
      .select('*, product:products(name, sku, unit)')
      .eq('purchase_id', purchaseId)
      .order('created_at')
    if (!error) setLines(data ?? [])
  }

  useEffect(() => {
    loadPurchases()
    loadProducts()
  }, [])

  const runningTotal = useMemo(
    () => lines.reduce((sum, l) => sum + Number(l.total_cost ?? l.quantity * l.unit_cost), 0),
    [lines]
  )

  function openNew() {
    setSelected(null)
    setLines([])
    setHeaderForm(EMPTY_HEADER)
    setLineForm(EMPTY_LINE)
    setErrorMsg('')
    setPanelOpen(true)
  }

  async function openExisting(purchase) {
    setSelected(purchase)
    setLineForm(EMPTY_LINE)
    setErrorMsg('')
    await loadLines(purchase.id)
    setPanelOpen(true)
  }

  async function handleCreateHeader(e) {
    e.preventDefault()
    setSaving(true)
    setErrorMsg('')
    const { data, error } = await supabase
      .from('purchases')
      .insert({
        purchase_date: headerForm.purchase_date,
        invoice_number: headerForm.invoice_number.trim() || null,
        supplier: headerForm.supplier.trim() || null,
      })
      .select()
      .single()

    setSaving(false)
    if (error) {
      setErrorMsg(error.message)
      return
    }
    setSelected(data)
    setLines([])
    loadPurchases()
  }

  async function handleAddLine(e) {
    e.preventDefault()
    if (!lineForm.product_id || !lineForm.quantity || !lineForm.unit_cost) return
    setSaving(true)
    setErrorMsg('')

    const { error } = await supabase.from('purchase_lines').insert({
      purchase_id: selected.id,
      product_id: lineForm.product_id,
      quantity: Number(lineForm.quantity),
      unit_cost: Number(lineForm.unit_cost),
      expiration_date: lineForm.expiration_date || null,
    })

    setSaving(false)
    if (error) {
      setErrorMsg(error.message)
      return
    }
    setLineForm(EMPTY_LINE)
    await loadLines(selected.id)
  }

  async function removeLine(lineId) {
    await supabase.from('purchase_lines').delete().eq('id', lineId)
    loadLines(selected.id)
  }

  async function postPurchase() {
    if (lines.length === 0) {
      setErrorMsg('Add at least one line before posting.')
      return
    }
    if (!confirm(`Post ${selected.purchase_number}? This creates batches and updates inventory — it can only be undone by voiding.`)) {
      return
    }
    setSaving(true)
    const { data, error } = await supabase
      .from('purchases')
      .update({ status: 'posted', total_cost: runningTotal })
      .eq('id', selected.id)
      .select()
      .single()
    setSaving(false)
    if (error) {
      setErrorMsg(error.message)
      return
    }
    setSelected(data)
    loadPurchases()
    loadLines(selected.id)
  }

  async function voidPurchase() {
    if (!confirm(`Void ${selected.purchase_number}? This reverses its stock movements — the record stays, it doesn't get deleted.`)) {
      return
    }
    setSaving(true)
    const { data, error } = await supabase
      .from('purchases')
      .update({ status: 'voided' })
      .eq('id', selected.id)
      .select()
      .single()
    setSaving(false)
    if (error) {
      setErrorMsg(error.message)
      return
    }
    setSelected(data)
    loadPurchases()
  }

  const isDraft = selected?.status === 'draft'

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold">Purchases</h1>
          <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
            Posting a purchase is what creates batches and puts stock into Inventory.
          </p>
        </div>
        <button
          onClick={openNew}
          className="flex items-center gap-1.5 rounded-md bg-[var(--color-ink)] px-3.5 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          <Plus size={16} />
          New purchase
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
              <th className="px-4 py-3">Purchase #</th>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Supplier</th>
              <th className="px-4 py-3">Invoice #</th>
              <th className="px-4 py-3">Total</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-[var(--color-ink-soft)]">
                  Loading purchases…
                </td>
              </tr>
            )}

            {!loading && purchases.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-[var(--color-ink-soft)]">
                  No purchases yet — create one to start receiving stock.
                </td>
              </tr>
            )}

            {purchases.map((p) => (
              <tr
                key={p.id}
                onClick={() => openExisting(p)}
                className="cursor-pointer border-b border-[var(--color-line)] last:border-0 hover:bg-[var(--color-paper)]"
              >
                <td className="font-mono px-4 py-3 text-xs text-[var(--color-ink-soft)]">
                  {p.purchase_number}
                </td>
                <td className="px-4 py-3">{p.purchase_date}</td>
                <td className="px-4 py-3">{p.supplier || '—'}</td>
                <td className="px-4 py-3 text-[var(--color-ink-soft)]">{p.invoice_number || '—'}</td>
                <td className="px-4 py-3">{Number(p.total_cost).toFixed(2)}</td>
                <td className="px-4 py-3">
                  <StatusChip tone={statusTone(p.status)}>{p.status}</StatusChip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <SlidePanel
        open={panelOpen}
        title={selected ? selected.purchase_number : 'New purchase'}
        onClose={() => setPanelOpen(false)}
      >
        {errorMsg && (
          <div className="mb-4 rounded-md bg-[var(--color-rust-soft)] px-3.5 py-2.5 text-sm text-[var(--color-rust)]">
            {errorMsg}
          </div>
        )}

        {!selected ? (
          <form onSubmit={handleCreateHeader} className="space-y-4">
            <Field label="Purchase date" required>
              <input
                type="date"
                required
                value={headerForm.purchase_date}
                onChange={(e) => setHeaderForm({ ...headerForm, purchase_date: e.target.value })}
                className="input"
              />
            </Field>
            <Field label="Supplier">
              <input
                value={headerForm.supplier}
                onChange={(e) => setHeaderForm({ ...headerForm, supplier: e.target.value })}
                className="input"
              />
            </Field>
            <Field label="Invoice number">
              <input
                value={headerForm.invoice_number}
                onChange={(e) => setHeaderForm({ ...headerForm, invoice_number: e.target.value })}
                className="input"
              />
            </Field>
            <button
              type="submit"
              disabled={saving}
              className="w-full rounded-md bg-[var(--color-ink)] py-2.5 text-sm font-medium text-white disabled:opacity-60"
            >
              {saving ? 'Creating…' : 'Create purchase'}
            </button>
            <p className="text-xs text-[var(--color-ink-soft)]">
              This saves the header as a draft — you'll add line items next, then post when ready.
            </p>
          </form>
        ) : (
          <div>
            <div className="mb-4 flex items-center justify-between rounded-md bg-[var(--color-paper)] px-3 py-2.5 text-sm">
              <div className="text-[var(--color-ink-soft)]">
                {selected.purchase_date} · {selected.supplier || 'No supplier'}
              </div>
              <StatusChip tone={statusTone(selected.status)}>{selected.status}</StatusChip>
            </div>

            <div className="mb-3 text-xs font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">
              Line items
            </div>

            <div className="mb-4 overflow-hidden rounded-md border border-[var(--color-line)]">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-[var(--color-line)] text-xs text-[var(--color-ink-soft)]">
                  <tr>
                    <th className="px-3 py-2">Product</th>
                    <th className="px-3 py-2">Qty</th>
                    <th className="px-3 py-2">Cost</th>
                    <th className="px-3 py-2">Total</th>
                    {isDraft && <th className="px-3 py-2" />}
                  </tr>
                </thead>
                <tbody>
                  {lines.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-5 text-center text-[var(--color-ink-soft)]">
                        No lines yet.
                      </td>
                    </tr>
                  )}
                  {lines.map((l) => (
                    <tr key={l.id} className="border-b border-[var(--color-line)] last:border-0">
                      <td className="px-3 py-2">{l.product?.name ?? '—'}</td>
                      <td className="px-3 py-2">{l.quantity} {l.product?.unit}</td>
                      <td className="px-3 py-2">{Number(l.unit_cost).toFixed(2)}</td>
                      <td className="px-3 py-2">{Number(l.total_cost).toFixed(2)}</td>
                      {isDraft && (
                        <td className="px-3 py-2">
                          <button
                            onClick={() => removeLine(l.id)}
                            aria-label="Remove line"
                            className="rounded-md p-1 text-[var(--color-ink-soft)] hover:bg-[var(--color-line)]"
                          >
                            <Trash2 size={14} />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-[var(--color-line)] font-medium">
                    <td colSpan={3} className="px-3 py-2 text-right text-[var(--color-ink-soft)]">
                      Total
                    </td>
                    <td className="px-3 py-2">{runningTotal.toFixed(2)}</td>
                    {isDraft && <td />}
                  </tr>
                </tfoot>
              </table>
            </div>

            {isDraft && (
              <form onSubmit={handleAddLine} className="mb-5 space-y-3 rounded-md border border-dashed border-[var(--color-line)] p-3">
                <Field label="Product" required>
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <ProductPicker
                        products={products}
                        value={lineForm.product_id}
                        onChange={(id) => setLineForm({ ...lineForm, product_id: id })}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={openQuickAdd}
                      className="whitespace-nowrap rounded-md border border-[var(--color-line)] px-3 text-sm font-medium hover:bg-[var(--color-paper)]"
                    >
                      + New
                    </button>
                  </div>
                </Field>

                {quickAddOpen && (
                  <div className="space-y-3 rounded-md bg-[var(--color-paper)] p-3">
                    <div className="text-xs font-medium text-[var(--color-ink-soft)]">
                      Quick add — just enough to receive this purchase. Fill in the rest later on the Products page.
                    </div>
                    {quickAddError && (
                      <div className="rounded-md bg-[var(--color-rust-soft)] px-2.5 py-1.5 text-xs text-[var(--color-rust)]">
                        {quickAddError}
                      </div>
                    )}
                    <Field label="Barcode" required>
                      <input
                        required
                        value={quickAddForm.barcode}
                        onChange={(e) => setQuickAddForm({ ...quickAddForm, barcode: e.target.value })}
                        className="input"
                      />
                    </Field>
                    <Field label="Product name" required>
                      <input
                        required
                        value={quickAddForm.name}
                        onChange={(e) => setQuickAddForm({ ...quickAddForm, name: e.target.value })}
                        className="input"
                      />
                    </Field>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Unit">
                        <input
                          value={quickAddForm.unit}
                          onChange={(e) => setQuickAddForm({ ...quickAddForm, unit: e.target.value })}
                          className="input"
                          placeholder="pcs"
                        />
                      </Field>
                      <Field label="Selling price">
                        <input
                          type="number" step="0.01" min="0"
                          value={quickAddForm.selling_price}
                          onChange={(e) => setQuickAddForm({ ...quickAddForm, selling_price: e.target.value })}
                          className="input"
                        />
                      </Field>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={handleQuickAddProduct}
                        disabled={quickAddSaving}
                        className="flex-1 rounded-md bg-[var(--color-ink)] py-2 text-sm font-medium text-white disabled:opacity-60"
                      >
                        {quickAddSaving ? 'Creating…' : 'Create & use'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setQuickAddOpen(false)}
                        className="rounded-md border border-[var(--color-line)] px-3 text-sm font-medium"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
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
                  <Field label="Unit cost" required>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      required
                      value={lineForm.unit_cost}
                      onChange={(e) => setLineForm({ ...lineForm, unit_cost: e.target.value })}
                      className="input"
                    />
                  </Field>
                </div>
                <Field label="Expiration date (optional)">
                  <input
                    type="date"
                    value={lineForm.expiration_date}
                    onChange={(e) => setLineForm({ ...lineForm, expiration_date: e.target.value })}
                    className="input"
                  />
                </Field>
                <button
                  type="submit"
                  disabled={saving}
                  className="flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--color-ink)] py-2 text-sm font-medium disabled:opacity-60"
                >
                  <Plus size={15} />
                  Add line
                </button>
              </form>
            )}

            {isDraft && (
              <button
                onClick={postPurchase}
                disabled={saving}
                className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--color-herb)] py-2.5 text-sm font-medium text-white disabled:opacity-60"
              >
                <Send size={15} />
                Post purchase
              </button>
            )}

            {selected.status === 'posted' && (
              <button
                onClick={voidPurchase}
                disabled={saving}
                className="flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--color-rust)] py-2.5 text-sm font-medium text-[var(--color-rust)] disabled:opacity-60"
              >
                <Ban size={15} />
                Void purchase
              </button>
            )}

            {selected.status === 'voided' && (
              <p className="text-center text-sm text-[var(--color-ink-soft)]">
                This purchase was voided — its stock movements have been reversed.
              </p>
            )}
          </div>
        )}
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
