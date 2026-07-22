import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { fetchAllRows } from '../lib/fetchAllRows'
import StatusChip from '../components/StatusChip'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// These two aren't in Settings yet — reasonable defaults for EOQ until the
// business wants to tune them (ordering cost per PO, holding cost as a % of
// unit cost per year). Flagged in the UI, not hidden.
const ASSUMED_ORDERING_COST = 50
const ASSUMED_HOLDING_COST_RATE = 0.2

function nextOccurrenceOf(dayName) {
  const targetIdx = WEEKDAYS.indexOf(dayName)
  if (targetIdx === -1) return null
  const today = new Date()
  const diff = (targetIdx - today.getDay() + 7) % 7
  const result = new Date(today)
  result.setDate(today.getDate() + (diff === 0 ? 7 : diff))
  return result
}

function fmtDate(d) {
  if (!d) return '—'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default function Analytics() {
  const [tab, setTab] = useState('velocity')
  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState('')
  const [analytics, setAnalytics] = useState(null)

  useEffect(() => {
    async function load() {
      setLoading(true)
      setErrorMsg('')
      try {
        const [settingsRes, productsRes, saleLinesRes] = await Promise.all([
          supabase.from('settings').select('key, value'),
          fetchAllRows(
            'products',
            'id, sku, name, category, unit, current_cost, selling_price, reorder_point, status, inventory_cache(current_stock, inventory_value)'
          ),
          fetchAllRows('sale_lines', 'product_id, quantity, unit_price, fifo_cost, sale:sales(sale_date)'),
        ])

        if (settingsRes.error) throw settingsRes.error
        if (productsRes.error) throw productsRes.error
        if (saleLinesRes.error) throw saleLinesRes.error

        productsRes.data = (productsRes.data ?? []).filter((p) => p.status === 'active')

        const settingsMap = {}
        for (const s of settingsRes.data ?? []) settingsMap[s.key] = s.value

        const forecastWeeks = Number(settingsMap.FORECAST_WINDOW_WEEKS ?? 8)
        const leadTimeDays = Number(settingsMap.DEFAULT_LEAD_TIME_DAYS ?? 3)
        const safetyStockPct = Number(settingsMap.DEFAULT_SAFETY_STOCK_PCT ?? 20)
        const purchasingDay = settingsMap.PURCHASING_DAY ?? 'Thursday'
        const windowDays = forecastWeeks * 7
        const windowStart = new Date(Date.now() - windowDays * 86400000)

        const salesInWindow = (saleLinesRes.data ?? []).filter(
          (l) => l.sale?.sale_date && new Date(l.sale.sale_date) >= windowStart
        )

        const byProduct = {}
        for (const l of salesInWindow) {
          byProduct[l.product_id] = byProduct[l.product_id] ?? { qty: 0, revenue: 0, cost: 0 }
          byProduct[l.product_id].qty += Number(l.quantity)
          byProduct[l.product_id].revenue += Number(l.quantity) * Number(l.unit_price)
          byProduct[l.product_id].cost += Number(l.fifo_cost)
        }

        const products = (productsRes.data ?? []).map((p) => {
          const cache = Array.isArray(p.inventory_cache) ? p.inventory_cache[0] : p.inventory_cache
          const sold = byProduct[p.id]
          const currentStock = Number(cache?.current_stock ?? 0)
          const inventoryValue = Number(cache?.inventory_value ?? 0)
          const hasSales = !!sold && sold.qty > 0

          const avgDailyDemand = hasSales ? sold.qty / windowDays : 0
          const weeklyDemand = avgDailyDemand * 7
          const monthlyDemand = avgDailyDemand * 30
          const annualDemand = avgDailyDemand * 365

          const safetyStock = weeklyDemand * (safetyStockPct / 100)
          const reorderPoint = avgDailyDemand * leadTimeDays + safetyStock
          const unitCost = Number(p.current_cost) || 0
          const eoq =
            hasSales && unitCost > 0
              ? Math.sqrt((2 * annualDemand * ASSUMED_ORDERING_COST) / (ASSUMED_HOLDING_COST_RATE * unitCost))
              : null

          const daysOfStockRemaining = avgDailyDemand > 0 ? currentStock / avgDailyDemand : null

          return {
            ...p,
            currentStock,
            inventoryValue,
            hasSales,
            qtySold: sold?.qty ?? 0,
            revenue: sold?.revenue ?? 0,
            fifoCost: sold?.cost ?? 0,
            avgDailyDemand,
            weeklyDemand,
            monthlyDemand,
            annualDemand,
            safetyStock,
            reorderPoint,
            eoq,
            daysOfStockRemaining,
          }
        })

        // ABC classification by revenue contribution (Pareto: A=80%, B=95%, C=rest)
        const withSales = products.filter((p) => p.hasSales).sort((a, b) => b.revenue - a.revenue)
        const totalRevenue = withSales.reduce((s, p) => s + p.revenue, 0)
        let cumulative = 0
        const abcMap = {}
        for (const p of withSales) {
          cumulative += p.revenue
          const pct = totalRevenue > 0 ? cumulative / totalRevenue : 0
          abcMap[p.id] = pct <= 0.8 ? 'A' : pct <= 0.95 ? 'B' : 'C'
        }

        const avgDemandAcrossActive = withSales.length
          ? withSales.reduce((s, p) => s + p.avgDailyDemand, 0) / withSales.length
          : 0

        const withClassification = products.map((p) => ({
          ...p,
          abcClass: abcMap[p.id] ?? null,
          movement: !p.hasSales ? 'No Movement' : p.avgDailyDemand >= avgDemandAcrossActive ? 'Fast Moving' : 'Slow Moving',
        }))

        setAnalytics({
          products: withClassification,
          windowDays,
          leadTimeDays,
          safetyStockPct,
          purchasingDay,
          nextPurchasingDate: nextOccurrenceOf(purchasingDay),
          productsWithSales: withSales.length,
          totalProducts: products.length,
        })
      } catch (err) {
        setErrorMsg(err.message ?? 'Could not load analytics.')
      }
      setLoading(false)
    }
    load()
  }, [])

  if (loading) {
    return <div className="py-10 text-center text-sm text-[var(--color-ink-soft)]">Crunching the numbers…</div>
  }

  if (errorMsg) {
    return <div className="rounded-md bg-[var(--color-rust-soft)] px-3.5 py-2.5 text-sm text-[var(--color-rust)]">{errorMsg}</div>
  }

  const { products, windowDays, leadTimeDays, purchasingDay, nextPurchasingDate, productsWithSales, totalProducts } = analytics

  return (
    <div>
      <div className="mb-2">
        <h1 className="font-display text-2xl font-semibold">Analytics</h1>
        <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
          Based on the last {windowDays} days of sales ({productsWithSales} of {totalProducts} active products have sales history so far).
        </p>
      </div>

      {productsWithSales === 0 && (
        <div className="my-6 rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-4 py-8 text-center text-sm text-[var(--color-ink-soft)]">
          No sales recorded yet in this window — velocity, EOQ, purchasing recommendations, and forecasts all need real
          sales history to mean anything. Everything below will fill in as sales accumulate; nothing here is estimated
          from nothing.
        </div>
      )}

      <div className="mb-4 mt-4 flex flex-wrap gap-1 border-b border-[var(--color-line)]">
        {[
          ['velocity', 'Velocity & ABC'],
          ['inventory', 'Inventory Health'],
          ['eoq', 'EOQ & Reorder'],
          ['purchasing', 'Purchasing Recs'],
          ['forecast', 'Forecast'],
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

      {tab === 'velocity' && <VelocityTab products={products} />}
      {tab === 'inventory' && <InventoryHealthTab products={products} />}
      {tab === 'eoq' && <EoqTab products={products} leadTimeDays={leadTimeDays} />}
      {tab === 'purchasing' && (
        <PurchasingTab products={products} purchasingDay={purchasingDay} nextPurchasingDate={nextPurchasingDate} leadTimeDays={leadTimeDays} />
      )}
      {tab === 'forecast' && <ForecastTab products={products} />}
    </div>
  )
}

function Table({ columns, rows, emptyText }) {
  return (
    <div className="overflow-hidden rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)]">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-[var(--color-line)] text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
          <tr>
            {columns.map((c) => (
              <th key={c.key} className="px-4 py-3">{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={columns.length} className="px-4 py-10 text-center text-[var(--color-ink-soft)]">{emptyText}</td></tr>
          )}
          {rows.map((row, i) => (
            <tr key={row.id ?? i} className="border-b border-[var(--color-line)] last:border-0">
              {columns.map((c) => (
                <td key={c.key} className="px-4 py-3">{c.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function VelocityTab({ products }) {
  const withSales = products.filter((p) => p.hasSales).sort((a, b) => b.qtySold - a.qtySold)
  const columns = [
    { key: 'name', label: 'Product', render: (p) => p.name },
    { key: 'abc', label: 'ABC class', render: (p) => <StatusChip tone={p.abcClass === 'A' ? 'ok' : p.abcClass === 'B' ? 'attention' : 'neutral'}>{p.abcClass}</StatusChip> },
    { key: 'qty', label: 'Qty sold', render: (p) => `${p.qtySold} ${p.unit}` },
    { key: 'revenue', label: 'Revenue', render: (p) => p.revenue.toFixed(2) },
    { key: 'daily', label: 'Avg / day', render: (p) => p.avgDailyDemand.toFixed(2) },
    { key: 'movement', label: 'Movement', render: (p) => <StatusChip tone={p.movement === 'Fast Moving' ? 'ok' : 'neutral'}>{p.movement}</StatusChip> },
  ]
  return (
    <div>
      <p className="mb-3 text-xs text-[var(--color-ink-soft)]">
        Class A = top 80% of revenue, B = next 15%, C = the long tail — the classic Pareto cut, computed from products with any sales in the window.
      </p>
      <Table columns={columns} rows={withSales} emptyText="No sales yet to rank." />
    </div>
  )
}

function InventoryHealthTab({ products }) {
  const deadStock = products.filter((p) => !p.hasSales && p.currentStock > 0)
  const columns = [
    { key: 'name', label: 'Product', render: (p) => p.name },
    { key: 'stock', label: 'Stock', render: (p) => `${p.currentStock} ${p.unit}` },
    { key: 'value', label: 'Capital tied up', render: (p) => p.inventoryValue.toFixed(2) },
  ]
  return (
    <div>
      <p className="mb-3 text-xs text-[var(--color-ink-soft)]">
        Dead stock — has stock on hand but zero sales in the window. Worth a discount, bundle, or a hard look at whether to keep carrying it.
      </p>
      <Table columns={columns} rows={deadStock} emptyText="Nothing sitting dead — everything with stock has sold at least once in the window." />
    </div>
  )
}

function EoqTab({ products, leadTimeDays }) {
  const withSales = products.filter((p) => p.hasSales)
  const columns = [
    { key: 'name', label: 'Product', render: (p) => p.name },
    { key: 'weekly', label: 'Weekly demand', render: (p) => p.weeklyDemand.toFixed(1) },
    { key: 'safety', label: 'Safety stock', render: (p) => p.safetyStock.toFixed(1) },
    { key: 'reorder', label: 'Reorder point', render: (p) => p.reorderPoint.toFixed(1) },
    { key: 'eoq', label: 'EOQ', render: (p) => (p.eoq ? p.eoq.toFixed(0) : '—') },
    { key: 'coverage', label: 'Stock coverage', render: (p) => (p.daysOfStockRemaining !== null ? `${p.daysOfStockRemaining.toFixed(0)}d` : '—') },
  ]
  return (
    <div>
      <p className="mb-3 text-xs text-[var(--color-ink-soft)]">
        Lead time assumed at {leadTimeDays} days (from Settings). EOQ uses placeholder ordering/holding-cost assumptions
        (₱{ASSUMED_ORDERING_COST}/order, {(ASSUMED_HOLDING_COST_RATE * 100).toFixed(0)}% holding rate) until those become
        configurable — treat the EOQ number as a rough order-quantity guide, not gospel.
      </p>
      <Table columns={columns} rows={withSales} emptyText="Needs sales history before reorder math means anything." />
    </div>
  )
}

function PurchasingTab({ products, purchasingDay, nextPurchasingDate, leadTimeDays }) {
  const withSales = products.filter((p) => p.hasSales)

  const tiers = { Critical: [], NeedsPurchase: [], CanWait: [], Overstocked: [] }
  for (const p of withSales) {
    const recommendedQty = Math.max(0, Math.round(p.weeklyDemand + p.safetyStock - p.currentStock))
    const enriched = { ...p, recommendedQty }
    if (p.daysOfStockRemaining !== null && p.daysOfStockRemaining < leadTimeDays) {
      tiers.Critical.push(enriched)
    } else if (p.currentStock <= p.reorderPoint) {
      tiers.NeedsPurchase.push(enriched)
    } else if (p.currentStock > p.weeklyDemand * 4) {
      tiers.Overstocked.push(enriched)
    } else {
      tiers.CanWait.push(enriched)
    }
  }

  return (
    <div>
      <p className="mb-4 text-xs text-[var(--color-ink-soft)]">
        Purchasing day is set to <strong>{purchasingDay}</strong> — next one is {fmtDate(nextPurchasingDate)}. Only
        products with sales history are classified here.
      </p>
      <TierBlock title="Critical — will stock out before a new order could arrive" tone="critical" items={tiers.Critical} />
      <TierBlock title={`Needs purchase this ${purchasingDay}`} tone="attention" items={tiers.NeedsPurchase} />
      <TierBlock title="Can wait" tone="ok" items={tiers.CanWait} />
      <TierBlock title="Overstocked" tone="neutral" items={tiers.Overstocked} />
    </div>
  )
}

function TierBlock({ title, tone, items }) {
  return (
    <div className="mb-5">
      <div className="mb-2 flex items-center gap-2">
        <StatusChip tone={tone}>{items.length}</StatusChip>
        <span className="text-sm font-medium">{title}</span>
      </div>
      {items.length === 0 ? (
        <p className="pl-1 text-xs text-[var(--color-ink-soft)]">None right now.</p>
      ) : (
        <div className="space-y-1.5">
          {items.map((p) => (
            <div key={p.id} className="rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-3 py-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium">{p.name}</span>
                <span>{p.currentStock} {p.unit} on hand</span>
              </div>
              <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">
                Current stock will last about {p.daysOfStockRemaining !== null ? p.daysOfStockRemaining.toFixed(0) : '—'} days.
                Average weekly sales is {p.weeklyDemand.toFixed(1)} {p.unit}. Recommended purchase is {p.recommendedQty} {p.unit}.
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ForecastTab({ products }) {
  const withSales = products.filter((p) => p.hasSales)
  const columns = [
    { key: 'name', label: 'Product', render: (p) => p.name },
    { key: 'nextWeek', label: 'Next week (est.)', render: (p) => `${p.weeklyDemand.toFixed(1)} ${p.unit}` },
    { key: 'nextMonth', label: 'Next month (est.)', render: (p) => `${p.monthlyDemand.toFixed(1)} ${p.unit}` },
    {
      key: 'stockout',
      label: 'Estimated stockout',
      render: (p) => {
        if (p.daysOfStockRemaining === null) return '—'
        const d = new Date(Date.now() + p.daysOfStockRemaining * 86400000)
        return fmtDate(d)
      },
    },
  ]
  return (
    <div>
      <p className="mb-3 text-xs text-[var(--color-ink-soft)]">
        Simple moving average over the window — improves automatically as more sales history accumulates. No seasonality
        modeling yet; that needs a lot more history than exists right now.
      </p>
      <Table columns={columns} rows={withSales} emptyText="Needs sales history before a forecast means anything." />
    </div>
  )
}
