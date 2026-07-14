import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2, Check, Ban, AlertTriangle } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import SlidePanel from '../components/SlidePanel'
import StatusChip from '../components/StatusChip'
import ProductPicker from '../components/ProductPicker'

const EMPTY_LINE_FORM = { product_id: '', quantity: '', unit_price: '' }

function statusTone(status) {
  return status === 'voided' ? 'critical' : 'ok'
}

export default function Sales() {
  const [sales, setSales] = useState([])
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState('')

  const [panelOpen, setPanelOpen] = useState(false)
  const [mode, setMode] = useState('new') // 'new' | 'view'
  const [pendingLines, setPendingLines] = useState([]) // not yet saved to DB
  const [viewedSale, setViewedSale] = useState(null)
  const [viewedLines, setViewedLines] = useState([])
  const [headerForm, setHeaderForm] = useState({ pos_terminal: '', cashier: '' })
  const [lineForm, setLineForm] = useState(EMPTY_LINE_FORM)
  const [lineWarning, setLineWarning] = useState('')
  const [saving, setSaving] = useState(false)

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
    const { data, error } = await supabase
      .from('products')
      .select('id, sku, name, unit, selling_price, barcode')
      .eq('status', 'active')
      .order('name')
    if (!error) setProducts(data ?? [])
  }

  useEffect(() => {
    loadSales()
    loadProducts()
  }, [])

  function openNew() {
    setMode('new')
    setHeaderForm({ pos_terminal: '', cashier: '' })
    setPendingLines([])
    setLineForm(EMPTY_LINE_FORM)
    setLineWarning('')
    setErrorMsg('')
    setPanelOpen(true)
  }

  async function openView(sale) {
    setMode('view')
    setViewedSale(sale)
    setErrorMsg('')
    const { data } = await supabase
      .from('sale_lines')
      .select('*, product:products(name, sku, unit)')
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
  async function computeFifoConsumption(productId, qtyNeeded) {
    const { data: batches, error } = await supabase
      .from('batch_cache')
      .select('*')
      .eq('product_id', productId)
      .gt('remaining_quantity', 0)
      .order('fifo_sequence')

    if (error) throw error

    const reserved = {}
    for (const line of pendingLines) {
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

  async function handleAddLine(e) {
    e.preventDefault()
    setLineWarning('')
    if (!lineForm.product_id || !lineForm.quantity || !lineForm.unit_price) return

    const qty = Number(lineForm.quantity)
    const product = products.find((p) => p.id === lineForm.product_id)

    try {
      const { consumption, satisfied, totalAvailable } = await computeFifoConsumption(
        lineForm.product_id,
        qty
      )
      if (!satisfied) {
        setLineWarning(
          totalAvailable === 0
            ? `${product.name} has no stock available.`
            : `Only ${totalAvailable} ${product.unit} of ${product.name} available (across pending lines already added).`
        )
        return
      }

      const unitPrice = Number(lineForm.unit_price)
      const lineTotal = qty * unitPrice
      const fifoCost = consumption.reduce((sum, c) => sum + c.qty * c.unit_cost, 0)

      setPendingLines([
        ...pendingLines,
        {
          tempId: crypto.randomUUID(),
          product_id: lineForm.product_id,
          product_name: product.name,
          unit: product.unit,
          quantity: qty,
          unit_price: unitPrice,
          line_total: lineTotal,
          fifo_cost: fifoCost,
          gross_profit: lineTotal - fifoCost,
          consumption,
        },
      ])
      setLineForm(EMPTY_LINE_FORM)
    } catch {
      setLineWarning('Could not check available stock — try again.')
    }
  }

  function removeLine(tempId) {
    setPendingLines(pendingLines.filter((l) => l.tempId !== tempId))
  }

  const runningTotal = useMemo(
    () => pendingLines.reduce((sum, l) => sum + l.line_total, 0),
    [pendingLines]
  )
  const runningProfit = useMemo(
    () => pendingLines.reduce((sum, l) => sum + l.gross_profit, 0),
    [pendingLines]
  )

  async function completeSale() {
    if (pendingLines.length === 0) {
      setErrorMsg('Add at least one line before completing the sale.')
      return
    }
    setSaving(true)
    setErrorMsg('')

    const { data: sale, error: saleErr } = await supabase
      .from('sales')
      .insert({
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

      <div className="overflow-hidden rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)]">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[var(--color-line)] text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
            <tr>
              <th className="px-4 py-3">Sale #</th>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Terminal</th>
              <th className="px-4 py-3">Cashier</th>
              <th className="px-4 py-3">Total</th>
              <th className="px-4 py-3">Status</th>
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
            {!loading && sales.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-[var(--color-ink-soft)]">
                  No sales yet — record one to see it deduct from Inventory.
                </td>
              </tr>
            )}
            {sales.map((s) => (
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

            <div className="mb-4 overflow-hidden rounded-md border border-[var(--color-line)]">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-[var(--color-line)] text-xs text-[var(--color-ink-soft)]">
                  <tr>
                    <th className="px-3 py-2">Product</th>
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
                      <td colSpan={6} className="px-3 py-5 text-center text-[var(--color-ink-soft)]">
                        No lines yet.
                      </td>
                    </tr>
                  )}
                  {pendingLines.map((l) => (
                    <tr key={l.tempId} className="border-b border-[var(--color-line)] last:border-0">
                      <td className="px-3 py-2">{l.product_name}</td>
                      <td className="px-3 py-2">{l.quantity} {l.unit}</td>
                      <td className="px-3 py-2">{l.unit_price.toFixed(2)}</td>
                      <td className="px-3 py-2">{l.line_total.toFixed(2)}</td>
                      <td className="px-3 py-2 text-[var(--color-herb)]">{l.gross_profit.toFixed(2)}</td>
                      <td className="px-3 py-2">
                        <button
                          onClick={() => removeLine(l.tempId)}
                          aria-label="Remove line"
                          className="rounded-md p-1 text-[var(--color-ink-soft)] hover:bg-[var(--color-line)]"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-[var(--color-line)] font-medium">
                    <td colSpan={3} className="px-3 py-2 text-right text-[var(--color-ink-soft)]">Total</td>
                    <td className="px-3 py-2">{runningTotal.toFixed(2)}</td>
                    <td className="px-3 py-2 text-[var(--color-herb)]">{runningProfit.toFixed(2)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>

            <form onSubmit={handleAddLine} className="mb-5 space-y-3 rounded-md border border-dashed border-[var(--color-line)] p-3">
              <Field label="Product" required>
                <ProductPicker
                  products={products}
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
                <div className="flex items-start gap-1.5 rounded-md bg-[var(--color-amber-soft)] px-3 py-2 text-xs text-[var(--color-amber)]">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  {lineWarning}
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

            <div className="mb-5 overflow-hidden rounded-md border border-[var(--color-line)]">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-[var(--color-line)] text-xs text-[var(--color-ink-soft)]">
                  <tr>
                    <th className="px-3 py-2">Product</th>
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
