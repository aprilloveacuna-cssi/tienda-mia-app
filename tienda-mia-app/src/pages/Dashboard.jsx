import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { fetchAllRows } from '../lib/fetchAllRows'
import { downloadFile } from '../lib/csv'
import StatusChip from '../components/StatusChip'
import DisposeConfirm from '../components/DisposeConfirm'

function daysUntil(dateStr) {
  return Math.ceil((new Date(dateStr) - new Date()) / (1000 * 60 * 60 * 24))
}

function expiryLabel(dateStr) {
  const d = daysUntil(dateStr)
  if (d < 0) return `expired ${Math.abs(d)}d ago`
  if (d === 0) return 'expires today'
  return `${d}d left`
}

export default function Dashboard() {
  const [counts, setCounts] = useState({ total: null, active: null, archived: null })
  const [inventoryValue, setInventoryValue] = useState(null)
  const [alerts, setAlerts] = useState([])
  const [expiryAlerts, setExpiryAlerts] = useState([])
  const [hasAnyStock, setHasAnyStock] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')
  const [disposeBatch, setDisposeBatch] = useState(null)

  const [mealProduct, setMealProduct] = useState(null)
  const [mealTotalSold, setMealTotalSold] = useState(0)
  const [mealUnaccountedLog, setMealUnaccountedLog] = useState([])
  const [mealLogForm, setMealLogForm] = useState({ quantity: '', description: '', total_price: '' })
  const [mealLogSaving, setMealLogSaving] = useState(false)

  async function loadExpiryAlerts() {
    const cutoff = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)
    const { data, error } = await supabase
      .from('batch_cache')
      .select('*, batch:batches(batch_number), product:products(name, unit)')
      .gt('remaining_quantity', 0)
      .not('expiration_date', 'is', null)
      .lte('expiration_date', cutoff)
      .order('expiration_date', { ascending: true })
    if (!error) setExpiryAlerts(data ?? [])
  }

  async function loadMealUnaccounted() {
    const { data: product } = await supabase.from('products').select('id, name, unit').eq('name', 'MEAL@100').maybeSingle()
    setMealProduct(product ?? null)
    if (!product) return

    const { data: saleLines } = await supabase
      .from('sale_lines')
      .select('quantity, sale:sales(status)')
      .eq('product_id', product.id)
    const sold = (saleLines ?? [])
      .filter((l) => l.sale?.status !== 'voided')
      .reduce((sum, l) => sum + Number(l.quantity), 0)
    setMealTotalSold(sold)

    const { data: log } = await supabase
      .from('meal_unaccounted_log')
      .select('*')
      .order('log_date', { ascending: false })
      .order('created_at', { ascending: false })
    setMealUnaccountedLog(log ?? [])
  }

  function exportExpiryAlertsCsv() {
    const headers = ['Product', 'Unit', 'Batch', 'Remaining Qty', 'Expiration Date', 'Status']
    const rows = expiryAlerts.map((row) => [
      row.product?.name ?? '',
      row.product?.unit ?? '',
      row.batch?.batch_number ?? '',
      row.remaining_quantity,
      row.expiration_date,
      daysUntil(row.expiration_date) < 0 ? 'expired' : expiryLabel(row.expiration_date),
    ])
    const csv = [headers, ...rows].map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
    downloadFile(`expiry-alerts_${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv;charset=utf-8;')
  }

  async function handleAddMealLogEntry(e) {
    e.preventDefault()
    if (!mealLogForm.quantity || !mealLogForm.description.trim()) return
    setMealLogSaving(true)
    const { error } = await supabase.from('meal_unaccounted_log').insert({
      quantity: Number(mealLogForm.quantity),
      description: mealLogForm.description.trim(),
      total_price: mealLogForm.total_price === '' ? null : Number(mealLogForm.total_price),
    })
    setMealLogSaving(false)
    if (!error) {
      setMealLogForm({ quantity: '', description: '', total_price: '' })
      loadMealUnaccounted()
    }
  }

  async function loadAll() {
    try {
      const [totalRes, activeRes, archivedRes, invRes] = await Promise.all([
        supabase.from('products').select('*', { count: 'exact', head: true }),
        supabase.from('products').select('*', { count: 'exact', head: true }).eq('status', 'active'),
        supabase.from('products').select('*', { count: 'exact', head: true }).eq('status', 'archived'),
        fetchAllRows('inventory_cache', '*, product:products(name, sku, reorder_point)', null, { tiebreaker: 'product_id' }),
      ])

      const firstError = totalRes.error || activeRes.error || archivedRes.error || invRes.error
      if (firstError) {
        setErrorMsg('Could not reach Supabase — check your .env values.')
        return
      }

      setCounts({ total: totalRes.count, active: activeRes.count, archived: archivedRes.count })

      const invRows = (invRes.data ?? []).filter((r) => r.product)
      setHasAnyStock(invRows.length > 0)
      setInventoryValue(invRows.reduce((sum, r) => sum + Number(r.inventory_value ?? 0), 0))

      const lowStock = invRows
        .filter((r) => r.current_stock <= 0 || (r.product.reorder_point && r.current_stock <= r.product.reorder_point))
        .sort((a, b) => a.current_stock - b.current_stock)
        .slice(0, 5)
      setAlerts(lowStock)

      await loadExpiryAlerts()
      await loadMealUnaccounted()
    } catch {
      setErrorMsg('Could not reach Supabase — check your .env values.')
    }
  }

  useEffect(() => {
    loadAll()
  }, [])

  function openDispose(row) {
    setDisposeBatch({
      batch_id: row.batch_id,
      product_id: row.product_id,
      product_name: row.product?.name,
      batch_number: row.batch?.batch_number,
      unit: row.product?.unit,
      remaining_quantity: Number(row.remaining_quantity),
      unit_cost: Number(row.unit_cost),
      expiration_date: row.expiration_date,
    })
  }

  return (
    <div>
      <h1 className="font-display text-2xl font-semibold">Dashboard</h1>
      <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
        Live counts come from real tables. Everything below that needs purchases or sales history
        stays honest about having none yet, rather than showing a fake zero.
      </p>

      {errorMsg && (
        <div className="mt-4 rounded-md bg-[var(--color-rust-soft)] px-3.5 py-2.5 text-sm text-[var(--color-rust)]">
          {errorMsg}
        </div>
      )}

      <div className="mt-5 grid grid-cols-4 gap-4">
        <Kpi label="Total products" value={counts.total} />
        <Kpi label="Active products" value={counts.active} />
        <Kpi label="Archived" value={counts.archived} />
        <Kpi
          label="Inventory value"
          value={hasAnyStock ? inventoryValue.toFixed(2) : null}
          note={hasAnyStock ? null : 'Needs a posted purchase'}
        />
      </div>

      <div className="mt-6 grid grid-cols-2 gap-4">
        <Panel title="Stock alerts">
          {!hasAnyStock ? (
            <EmptyRow text="No purchases have been posted yet, so there's nothing to check against reorder points." />
          ) : alerts.length === 0 ? (
            <EmptyRow text="Everything is above its reorder point right now." />
          ) : (
            <div className="space-y-2">
              {alerts.map((r) => (
                <div key={r.product_id} className="flex items-center justify-between text-sm">
                  <span>{r.product.name}</span>
                  <StatusChip tone={r.current_stock <= 0 ? 'critical' : 'attention'}>
                    {r.current_stock <= 0 ? 'out of stock' : `${r.current_stock} left`}
                  </StatusChip>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Expiry alerts">
          {expiryAlerts.length > 0 && (
            <button
              onClick={exportExpiryAlertsCsv}
              className="mb-3 rounded-md border border-[var(--color-line)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--color-paper)]"
            >
              Export CSV
            </button>
          )}
          {expiryAlerts.length === 0 ? (
            <EmptyRow text="Nothing expired or expiring within 7 days — good shape." />
          ) : (
            <div className="space-y-2">
              {expiryAlerts.map((row) => (
                <div key={row.batch_id} className="flex items-center justify-between gap-2 text-sm">
                  <div className="min-w-0">
                    <div className="truncate">{row.product?.name}</div>
                    <div className="text-xs text-[var(--color-ink-soft)]">
                      {row.remaining_quantity} {row.product?.unit} · {row.batch?.batch_number}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <StatusChip tone={daysUntil(row.expiration_date) < 0 ? 'critical' : 'attention'}>
                      {expiryLabel(row.expiration_date)}
                    </StatusChip>
                    <span className="text-xs text-[var(--color-ink-soft)]">{row.expiration_date}</span>
                    <button
                      onClick={() => openDispose(row)}
                      className="rounded-md border border-[var(--color-rust)] px-2 py-1 text-xs font-medium text-[var(--color-rust)] hover:bg-[var(--color-rust-soft)]"
                    >
                      Dispose
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      {mealProduct && (
        <Panel title="MEAL@100 monitoring" className="mt-4">
          <div className="mb-4 flex items-center gap-3">
            <div className="rounded-md border border-[var(--color-line)] bg-[var(--color-paper)] px-4 py-3">
              <div className="font-display text-2xl font-semibold">
                {Math.max(0, mealTotalSold - mealUnaccountedLog.reduce((s, l) => s + Number(l.quantity), 0)).toFixed(0)}
              </div>
              <div className="text-xs text-[var(--color-ink-soft)]">unaccounted for</div>
            </div>
            <p className="text-xs text-[var(--color-ink-soft)]">
              {mealTotalSold.toFixed(0)} sold in total, {mealUnaccountedLog.reduce((s, l) => s + Number(l.quantity), 0).toFixed(0)} explained
              below — logging an entry doesn't touch Sales or Inventory, it's just for keeping track of where these went.
            </p>
          </div>

          <form onSubmit={handleAddMealLogEntry} className="mb-4 grid grid-cols-4 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-[var(--color-ink-soft)]">Qty</span>
              <input
                type="number" step="1" min="0" required
                value={mealLogForm.quantity}
                onChange={(e) => setMealLogForm({ ...mealLogForm, quantity: e.target.value })}
                className="input"
              />
            </label>
            <label className="col-span-2 block">
              <span className="mb-1 block text-xs font-medium text-[var(--color-ink-soft)]">Description</span>
              <input
                required
                value={mealLogForm.description}
                onChange={(e) => setMealLogForm({ ...mealLogForm, description: e.target.value })}
                placeholder="e.g. Staff lunch July 1"
                className="input"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-[var(--color-ink-soft)]">Total price</span>
              <input
                type="number" step="0.01" min="0"
                value={mealLogForm.total_price}
                onChange={(e) => setMealLogForm({ ...mealLogForm, total_price: e.target.value })}
                placeholder="optional"
                className="input"
              />
            </label>
            <button
              type="submit"
              disabled={mealLogSaving}
              className="col-span-4 rounded-md border border-[var(--color-ink)] py-2 text-sm font-medium disabled:opacity-60"
            >
              {mealLogSaving ? 'Adding…' : 'Add entry'}
            </button>
          </form>

          {mealUnaccountedLog.length > 0 && (
            <div className="max-h-48 overflow-auto rounded-md border border-[var(--color-line)]">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 border-b border-[var(--color-line)] bg-[var(--color-paper-raised)] text-xs text-[var(--color-ink-soft)]">
                  <tr>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Qty</th>
                    <th className="px-3 py-2">Description</th>
                    <th className="px-3 py-2">Total price</th>
                  </tr>
                </thead>
                <tbody>
                  {mealUnaccountedLog.map((l) => (
                    <tr key={l.id} className="border-b border-[var(--color-line)] last:border-0">
                      <td className="px-3 py-2">{l.log_date}</td>
                      <td className="px-3 py-2">{l.quantity}</td>
                      <td className="px-3 py-2">{l.description}</td>
                      <td className="px-3 py-2 text-[var(--color-ink-soft)]">{l.total_price != null ? Number(l.total_price).toFixed(2) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      <p className="mt-4 text-xs text-[var(--color-ink-soft)]">
        Looking for purchasing recommendations, EOQ, or sales forecasts? Those now live on the Analytics page,
        once there's enough sales history for them to mean anything.
      </p>

      <DisposeConfirm
        open={!!disposeBatch}
        batch={disposeBatch}
        onClose={() => setDisposeBatch(null)}
        onDisposed={loadAll}
      />
    </div>
  )
}

function Kpi({ label, value, note }) {
  return (
    <div className="rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)] p-4">
      <div className="text-xs font-medium text-[var(--color-ink-soft)]">{label}</div>
      <div className="font-display mt-1.5 text-2xl font-semibold">
        {value === null || value === undefined ? '—' : value}
      </div>
      {note && (
        <div className="mt-1">
          <StatusChip tone="neutral">{note}</StatusChip>
        </div>
      )}
    </div>
  )
}

function Panel({ title, children, className = '' }) {
  return (
    <div className={`rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)] p-4 ${className}`}>
      <div className="font-display text-sm font-semibold">{title}</div>
      <div className="mt-3">{children}</div>
    </div>
  )
}

function EmptyRow({ text }) {
  return <p className="text-sm text-[var(--color-ink-soft)]">{text}</p>
}
