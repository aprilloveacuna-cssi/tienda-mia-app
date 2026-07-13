import { Fragment, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import StatusChip from '../components/StatusChip'

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

  async function load() {
    setLoading(true)
    setErrorMsg('')
    const { data, error } = await supabase
      .from('inventory_cache')
      .select('*, product:products(name, sku, unit, reorder_point)')

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

  useEffect(() => {
    load()
  }, [])

  async function toggleExpand(productId) {
    const next = new Set(expanded)
    if (next.has(productId)) {
      next.delete(productId)
    } else {
      next.add(productId)
      if (!batchesByProduct[productId]) {
        const { data } = await supabase
          .from('batch_cache')
          .select('*')
          .eq('product_id', productId)
          .order('fifo_sequence')
        setBatchesByProduct((prev) => ({ ...prev, [productId]: data ?? [] }))
      }
    }
    setExpanded(next)
  }

  const totalValue = useMemo(
    () => rows.reduce((sum, r) => sum + Number(r.inventory_value ?? 0), 0),
    [rows]
  )

  return (
    <div>
      <div className="mb-5">
        <h1 className="font-display text-2xl font-semibold">Inventory</h1>
        <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
          Read-only — computed from every posted purchase, sale, and adjustment. Nothing here is hand-edited.
        </p>
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

      <div className="overflow-hidden rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)]">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[var(--color-line)] text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
            <tr>
              <th className="w-8 px-4 py-3" />
              <th className="px-4 py-3">SKU</th>
              <th className="px-4 py-3">Product</th>
              <th className="px-4 py-3">Stock</th>
              <th className="px-4 py-3">Value</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-[var(--color-ink-soft)]">
                  Loading inventory…
                </td>
              </tr>
            )}

            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-[var(--color-ink-soft)]">
                  No stock movements yet — post a purchase to see inventory appear here.
                </td>
              </tr>
            )}

            {rows.map((r) => (
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
                    <td colSpan={5} className="px-4 py-3">
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
                                <StatusChip tone={expiryTone(b.expiration_date)}>
                                  {expiryLabel(b.expiration_date)}
                                </StatusChip>
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
    </div>
  )
}
