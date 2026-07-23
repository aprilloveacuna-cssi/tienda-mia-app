import { useEffect, useState } from 'react'
import { Plus, Trash2, Download, Printer } from 'lucide-react'
import { fetchAllRows } from '../lib/fetchAllRows'
import ProductPicker from '../components/ProductPicker'
import { downloadFile } from '../lib/csv'

const EMPTY_LINE_FORM = { product_id: '', quantity: '', unit_cost: '', packaging_note: '' }

export default function PurchaseList() {
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState('')

  const [lines, setLines] = useState([])
  const [lineForm, setLineForm] = useState(EMPTY_LINE_FORM)

  async function loadProducts() {
    setLoading(true)
    const { data, error } = await fetchAllRows('products', 'id, sku, name, unit, barcode, current_cost, status', 'name')
    if (error) {
      setErrorMsg('Could not reach Supabase. Check your .env values and that migrations have run.')
    } else {
      setProducts((data ?? []).filter((p) => p.status === 'active'))
    }
    setLoading(false)
  }

  useEffect(() => {
    loadProducts()
  }, [])

  function onProductPick(id) {
    const p = products.find((x) => x.id === id)
    setLineForm({
      product_id: id,
      // Defaults to the recorded current cost — still fully editable, since
      // this is exactly where you'd catch one that's never been set (shows
      // blank instead of a fake 0.00) or manually override for a price change.
      unit_cost: p?.current_cost ? String(p.current_cost) : '',
      quantity: '',
      packaging_note: '',
    })
  }

  function addLine(e) {
    e.preventDefault()
    if (!lineForm.product_id || !lineForm.quantity || lineForm.unit_cost === '') return
    const p = products.find((x) => x.id === lineForm.product_id)
    setLines([
      ...lines,
      {
        tempId: crypto.randomUUID(),
        product_id: p.id,
        code: p.barcode,
        description: p.name,
        unit: p.unit,
        unit_cost: Number(lineForm.unit_cost),
        quantity: Number(lineForm.quantity),
        packaging_note: lineForm.packaging_note.trim(),
      },
    ])
    setLineForm(EMPTY_LINE_FORM)
  }

  function removeLine(tempId) {
    setLines(lines.filter((l) => l.tempId !== tempId))
  }

  function costPerPiece(l) {
    return Math.round(l.unit_cost * 100) / 100
  }
  function costForecast(l) {
    return l.quantity * costPerPiece(l)
  }
  const grandTotal = lines.reduce((sum, l) => sum + costForecast(l), 0)

  function exportCsv() {
    const headers = ['Code', 'Description', 'Unit Cost', 'Purchase Qty', 'Packaging', 'Cost Per Piece', 'Cost Forecast']
    const rows = lines.map((l) => [
      l.code,
      l.description,
      l.unit_cost.toFixed(2),
      `${l.quantity} ${l.unit}`,
      l.packaging_note,
      costPerPiece(l).toFixed(2),
      costForecast(l).toFixed(2),
    ])
    rows.push(['', '', '', '', '', 'TOTAL', grandTotal.toFixed(2)])
    const csv = [headers, ...rows]
      .map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\n')
    downloadFile('purchase-list.csv', csv, 'text/csv;charset=utf-8;')
  }

  function printList() {
    window.print()
  }

  return (
    <div>
      <div className="no-print mb-5 flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold">Purchase List</h1>
          <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
            A manual planning list for cost analysis — search a product, enter quantity, and it forecasts the total.
            Nothing here touches Inventory; use Purchases to actually record a real delivery.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={exportCsv}
            disabled={lines.length === 0}
            className="flex items-center gap-1.5 rounded-md border border-[var(--color-line)] px-3.5 py-2 text-sm font-medium disabled:opacity-50"
          >
            <Download size={15} />
            Export CSV
          </button>
          <button
            onClick={printList}
            disabled={lines.length === 0}
            className="flex items-center gap-1.5 rounded-md bg-[var(--color-ink)] px-3.5 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            <Printer size={15} />
            Print / Save PDF
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="no-print mb-4 rounded-md bg-[var(--color-rust-soft)] px-3.5 py-2.5 text-sm text-[var(--color-rust)]">
          {errorMsg}
        </div>
      )}

      <form onSubmit={addLine} className="no-print mb-5 grid grid-cols-4 gap-3 rounded-md border border-dashed border-[var(--color-line)] p-4">
        <div className="col-span-2">
          <span className="mb-1 block text-xs font-medium text-[var(--color-ink-soft)]">Product</span>
          <ProductPicker products={products} value={lineForm.product_id} onChange={onProductPick} />
        </div>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-[var(--color-ink-soft)]">Quantity</span>
          <input
            type="number" step="0.001" min="0" required
            value={lineForm.quantity}
            onChange={(e) => setLineForm({ ...lineForm, quantity: e.target.value })}
            className="input"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-[var(--color-ink-soft)]">
            Unit cost {lineForm.product_id && !lineForm.unit_cost && (
              <span className="text-[var(--color-rust)]">— not on file, enter one</span>
            )}
          </span>
          <input
            type="number" step="0.01" min="0" required
            value={lineForm.unit_cost}
            onChange={(e) => setLineForm({ ...lineForm, unit_cost: e.target.value })}
            className="input"
          />
        </label>
        <label className="col-span-3 block">
          <span className="mb-1 block text-xs font-medium text-[var(--color-ink-soft)]">Packaging note (optional)</span>
          <input
            value={lineForm.packaging_note}
            onChange={(e) => setLineForm({ ...lineForm, packaging_note: e.target.value })}
            placeholder="e.g. 1 pack, 2 box, 1 case"
            className="input"
          />
        </label>
        <button
          type="submit"
          className="flex items-end justify-center gap-1.5 rounded-md bg-[var(--color-ink)] py-2 text-sm font-medium text-white"
        >
          <Plus size={15} />
          Add
        </button>
      </form>

      <div id="printable-report">
        <div className="mb-3">
          <div className="font-display text-lg font-semibold">Purchase List</div>
          <div className="text-xs text-[var(--color-ink-soft)]">Generated {new Date().toLocaleString()}</div>
        </div>

        <div className="max-h-[28rem] overflow-auto rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)]">
          <table className="w-full min-w-[720px] whitespace-nowrap text-left text-sm">
            <thead className="sticky top-0 border-b border-[var(--color-line)] bg-[var(--color-paper-raised)] text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
              <tr>
                <th className="px-4 py-3">Code</th>
                <th className="px-4 py-3">Description</th>
                <th className="px-4 py-3">Unit Cost</th>
                <th className="px-4 py-3">Purchase Qty</th>
                <th className="px-4 py-3">Packaging</th>
                <th className="px-4 py-3">Cost Per Piece</th>
                <th className="px-4 py-3">Cost Forecast</th>
                <th className="px-4 py-3 no-print" />
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-[var(--color-ink-soft)]">Loading…</td></tr>
              )}
              {!loading && lines.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-10 text-center text-[var(--color-ink-soft)]">No lines yet — search a product above to start building the list.</td></tr>
              )}
              {lines.map((l) => (
                <tr key={l.tempId} className="border-b border-[var(--color-line)] last:border-0">
                  <td className="font-mono px-4 py-3 text-xs text-[var(--color-ink-soft)]">{l.code}</td>
                  <td className="px-4 py-3 font-medium">{l.description}</td>
                  <td className="px-4 py-3">{l.unit_cost.toFixed(2)}</td>
                  <td className="px-4 py-3">{l.quantity} {l.unit}</td>
                  <td className="px-4 py-3 text-[var(--color-ink-soft)]">{l.packaging_note || '—'}</td>
                  <td className="px-4 py-3">{costPerPiece(l).toFixed(2)}</td>
                  <td className="px-4 py-3 font-medium">{costForecast(l).toFixed(2)}</td>
                  <td className="px-4 py-3 no-print">
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
            {lines.length > 0 && (
              <tfoot className="sticky bottom-0 bg-[var(--color-paper-raised)]">
                <tr className="border-t border-[var(--color-line)] font-medium">
                  <td colSpan={6} className="px-4 py-3 text-right text-[var(--color-ink-soft)]">Total</td>
                  <td className="px-4 py-3">{grandTotal.toFixed(2)}</td>
                  <td className="no-print" />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  )
}
