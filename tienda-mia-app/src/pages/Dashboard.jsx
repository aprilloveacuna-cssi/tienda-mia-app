import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import StatusChip from '../components/StatusChip'

export default function Dashboard() {
  const [counts, setCounts] = useState({ total: null, active: null, archived: null })
  const [inventoryValue, setInventoryValue] = useState(null)
  const [alerts, setAlerts] = useState([])
  const [hasAnyStock, setHasAnyStock] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    async function loadAll() {
      try {
        const [totalRes, activeRes, archivedRes, invRes] = await Promise.all([
          supabase.from('products').select('*', { count: 'exact', head: true }),
          supabase.from('products').select('*', { count: 'exact', head: true }).eq('status', 'active'),
          supabase.from('products').select('*', { count: 'exact', head: true }).eq('status', 'archived'),
          supabase.from('inventory_cache').select('*, product:products(name, sku, reorder_point)'),
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
      } catch {
        setErrorMsg('Could not reach Supabase — check your .env values.')
      }
    }
    loadAll()
  }, [])

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
        <Panel title="Purchasing recommendations (Thursday)">
          <EmptyRow text="Recommendations need at least a few weeks of sales history to compute — nothing to show until Phase 2/3." />
        </Panel>
      </div>
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

function Panel({ title, children }) {
  return (
    <div className="rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)] p-4">
      <div className="font-display text-sm font-semibold">{title}</div>
      <div className="mt-3">{children}</div>
    </div>
  )
}

function EmptyRow({ text }) {
  return <p className="text-sm text-[var(--color-ink-soft)]">{text}</p>
}
