import { useEffect, useState, Fragment } from 'react'
import { Printer, Download } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import StatusChip from '../components/StatusChip'

function daysUntil(dateStr) {
  if (!dateStr) return null
  return Math.ceil((new Date(dateStr) - new Date()) / (1000 * 60 * 60 * 24))
}

function expiryTone(dateStr) {
  const d = daysUntil(dateStr)
  if (d === null) return 'neutral'
  if (d < 0) return 'critical'
  if (d <= 7) return 'attention'
  return 'ok'
}

function expiryLabel(dateStr) {
  const d = daysUntil(dateStr)
  if (d === null) return 'no expiry'
  if (d < 0) return 'expired'
  if (d === 0) return 'today'
  return `${d}d left`
}

function stockTone(stock, reorderPoint) {
  if (stock <= 0) return 'critical'
  if (reorderPoint && stock <= reorderPoint) return 'attention'
  return 'ok'
}

function toDateOnly(value) {
  if (!value) return null
  return String(value).slice(0, 10)
}

function withinRange(dateStr, from, to) {
  const d = toDateOnly(dateStr)
  if (!d) return true
  if (from && d < from) return false
  if (to && d > to) return false
  return true
}

function datesInRange(from, to) {
  const dates = []
  const cur = new Date(from + 'T00:00:00')
  const end = new Date(to + 'T00:00:00')
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10))
    cur.setDate(cur.getDate() + 1)
  }
  return dates
}

// Falls back to a plain row[key] lookup when a column didn't define its own
// value function — every column needs SOME way to produce a value, this
// guarantees it instead of assuming each column definition remembered to.
function getValue(column, row) {
  return column.value ? column.value(row) : row[column.key]
}

function toCsv(columns, rows) {
  const header = columns.map((c) => `"${c.label.replace(/"/g, '""')}"`).join(',')
  const lines = rows.map((r) =>
    columns.map((c) => `"${String(getValue(c, r) ?? '').replace(/"/g, '""')}"`).join(',')
  )
  return [header, ...lines].join('\n')
}

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// ---------- Standard (flat-table) reports ----------
const REPORTS = {
  inventory: {
    label: 'Inventory',
    description: 'Current stock and value for every active product.',
    async fetch() {
      const { data, error } = await supabase
        .from('products')
        .select('sku, name, category, unit, reorder_point, inventory_cache(current_stock, inventory_value)')
        .eq('status', 'active')
        .order('name')
      if (error) throw error
      return (data ?? []).map((p) => {
        const cache = Array.isArray(p.inventory_cache) ? p.inventory_cache[0] : p.inventory_cache
        return {
          sku: p.sku,
          name: p.name,
          category: p.category ?? '—',
          unit: p.unit,
          stock: Number(cache?.current_stock ?? 0),
          value: Number(cache?.inventory_value ?? 0),
          reorder_point: Number(p.reorder_point ?? 0),
        }
      })
    },
    columns: [
      { key: 'sku', label: 'SKU' },
      { key: 'name', label: 'Product' },
      { key: 'category', label: 'Category' },
      { key: 'stock', label: 'Stock', value: (r) => `${r.stock} ${r.unit}` },
      { key: 'value', label: 'Value', value: (r) => r.value.toFixed(2) },
      {
        key: 'status',
        label: 'Status',
        value: (r) => (r.stock <= 0 ? 'out of stock' : r.reorder_point && r.stock <= r.reorder_point ? 'below reorder point' : 'ok'),
        render: (r) => (
          <StatusChip tone={stockTone(r.stock, r.reorder_point)}>
            {r.stock <= 0 ? 'out of stock' : r.reorder_point && r.stock <= r.reorder_point ? 'below reorder point' : 'ok'}
          </StatusChip>
        ),
      },
    ],
  },

  valuation: {
    label: 'Inventory Valuation',
    description: 'Inventory value rolled up by category.',
    async fetch() {
      const { data, error } = await supabase
        .from('products')
        .select('category, inventory_cache(current_stock, inventory_value)')
        .eq('status', 'active')
      if (error) throw error
      const groups = {}
      for (const p of data ?? []) {
        const cache = Array.isArray(p.inventory_cache) ? p.inventory_cache[0] : p.inventory_cache
        const cat = p.category ?? 'Uncategorized'
        groups[cat] = groups[cat] ?? { category: cat, productCount: 0, totalValue: 0 }
        groups[cat].productCount += 1
        groups[cat].totalValue += Number(cache?.inventory_value ?? 0)
      }
      return Object.values(groups).sort((a, b) => b.totalValue - a.totalValue)
    },
    columns: [
      { key: 'category', label: 'Category' },
      { key: 'productCount', label: '# Products' },
      { key: 'totalValue', label: 'Total value', value: (r) => Number(r.totalValue ?? 0).toFixed(2) },
    ],
  },

  batches: {
    label: 'Batches',
    description: 'Every batch ever received, oldest first within each product.',
    dateField: (r) => r.received_date,
    async fetch() {
      const { data, error } = await supabase
        .from('batches')
        .select('batch_number, received_date, expiration_date, unit_cost, status, product:products(name, sku, unit), cache:batch_cache(remaining_quantity)')
        .order('received_date', { ascending: false })
      if (error) throw error
      return data ?? []
    },
    columns: [
      { key: 'batch_number', label: 'Batch #' },
      { key: 'product', label: 'Product', value: (r) => r.product?.name },
      { key: 'received_date', label: 'Received' },
      { key: 'remaining', label: 'Remaining', value: (r) => `${r.cache?.remaining_quantity ?? 0} ${r.product?.unit ?? ''}` },
      { key: 'unit_cost', label: 'Unit cost', value: (r) => Number(r.unit_cost).toFixed(2) },
      { key: 'status', label: 'Status', value: (r) => r.status },
    ],
  },

  expiryWaste: {
    label: 'Expiry & Waste',
    description: 'Every batch nearing/past expiration, plus every waste event — one combined timeline.',
    dateField: (r) => r.date,
    async fetch() {
      const [batchesRes, wasteRes] = await Promise.all([
        supabase
          .from('batches')
          .select('batch_number, expiration_date, product:products(name, sku, unit), cache:batch_cache(remaining_quantity)')
          .not('expiration_date', 'is', null),
        supabase
          .from('waste')
          .select('waste_number, waste_date, quantity, reason, product:products(name, sku, unit), batch:batches(batch_number)'),
      ])
      if (batchesRes.error) throw batchesRes.error
      if (wasteRes.error) throw wasteRes.error

      const expiryRows = (batchesRes.data ?? [])
        .filter((r) => Number((Array.isArray(r.cache) ? r.cache[0] : r.cache)?.remaining_quantity ?? 0) > 0)
        .map((r) => ({
          type: 'Expiry',
          date: r.expiration_date,
          reference: r.batch_number,
          product: r.product?.name,
          unit: r.product?.unit,
          quantity: (Array.isArray(r.cache) ? r.cache[0] : r.cache)?.remaining_quantity ?? 0,
          note: expiryLabel(r.expiration_date),
        }))

      const wasteRows = (wasteRes.data ?? []).map((w) => ({
        type: 'Waste',
        date: w.waste_date,
        reference: w.waste_number,
        product: w.product?.name,
        unit: w.product?.unit,
        quantity: w.quantity,
        note: w.reason,
      }))

      return [...expiryRows, ...wasteRows].sort((a, b) => (a.date < b.date ? -1 : 1))
    },
    columns: [
      {
        key: 'type',
        label: 'Type',
        render: (r) => <StatusChip tone={r.type === 'Waste' ? 'critical' : expiryTone(r.date)}>{r.type}</StatusChip>,
      },
      { key: 'date', label: 'Date' },
      { key: 'reference', label: 'Reference' },
      { key: 'product', label: 'Product' },
      { key: 'quantity', label: 'Quantity', value: (r) => `${r.quantity} ${r.unit ?? ''}` },
      { key: 'note', label: 'Note' },
    ],
  },

  purchases: {
    label: 'Purchases',
    description: 'Every purchase order, regardless of status.',
    dateField: (r) => r.purchase_date,
    async fetch() {
      const { data, error } = await supabase.from('purchases').select('*').order('purchase_date', { ascending: false })
      if (error) throw error
      return data ?? []
    },
    columns: [
      { key: 'purchase_number', label: 'Purchase #' },
      { key: 'purchase_date', label: 'Date' },
      { key: 'supplier', label: 'Supplier', value: (r) => r.supplier ?? '—' },
      { key: 'invoice_number', label: 'Invoice #', value: (r) => r.invoice_number ?? '—' },
      { key: 'total_cost', label: 'Total', value: (r) => Number(r.total_cost).toFixed(2) },
      { key: 'status', label: 'Status', value: (r) => r.status },
    ],
  },

  sales: {
    label: 'Sales',
    description: 'Every sale line, with FIFO cost and gross profit.',
    dateField: (r) => r.sale?.sale_date,
    async fetch() {
      const { data, error } = await supabase
        .from('sale_lines')
        .select('quantity, unit_price, fifo_cost, gross_profit, sale:sales(sale_number, sale_date, status), product:products(name, sku, unit)')
        .order('sale_date', { foreignTable: 'sales', ascending: false })
      if (error) throw error
      return data ?? []
    },
    columns: [
      { key: 'sale_number', label: 'Sale #', value: (r) => r.sale?.sale_number },
      { key: 'sale_date', label: 'Date', value: (r) => (r.sale?.sale_date ? new Date(r.sale.sale_date).toLocaleDateString() : '') },
      { key: 'product', label: 'Product', value: (r) => r.product?.name },
      { key: 'quantity', label: 'Qty', value: (r) => `${r.quantity} ${r.product?.unit ?? ''}` },
      { key: 'unit_price', label: 'Price', value: (r) => Number(r.unit_price).toFixed(2) },
      { key: 'fifo_cost', label: 'FIFO cost', value: (r) => Number(r.fifo_cost).toFixed(2) },
      { key: 'gross_profit', label: 'Profit', value: (r) => Number(r.gross_profit).toFixed(2) },
    ],
  },

  kitchen: {
    label: 'Kitchen Production',
    description: 'Every production run, with actual (not theoretical) cost.',
    dateField: (r) => r.production_date,
    async fetch() {
      const { data, error } = await supabase
        .from('kitchen_production')
        .select('*, recipe:recipes(product:products(name, sku, unit))')
        .order('production_date', { ascending: false })
      if (error) throw error
      return data ?? []
    },
    columns: [
      { key: 'production_number', label: 'Production #' },
      { key: 'production_date', label: 'Date' },
      { key: 'product', label: 'Product', value: (r) => r.recipe?.product?.name },
      { key: 'quantity_produced', label: 'Qty produced', value: (r) => `${r.quantity_produced} ${r.recipe?.product?.unit ?? ''}` },
      { key: 'cost_per_unit', label: 'Cost/unit', value: (r) => Number(r.cost_per_unit).toFixed(2) },
      { key: 'total_cost', label: 'Total cost', value: (r) => Number(r.total_cost).toFixed(2) },
    ],
  },
}

export default function Reports() {
  const [reportKey, setReportKey] = useState('inventory')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState('')

  const today = new Date().toISOString().slice(0, 10)
  const thirtyDaysAgo = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10)
  const [dateFrom, setDateFrom] = useState(thirtyDaysAgo)
  const [dateTo, setDateTo] = useState(today)

  const isMatrix = reportKey === 'dailyMatrix'
  const report = isMatrix ? null : REPORTS[reportKey]

  useEffect(() => {
    if (isMatrix) return
    let cancelled = false
    setRows([]) // clear stale rows from the previous report immediately, before fetching
    async function load() {
      setLoading(true)
      setErrorMsg('')
      try {
        const data = await REPORTS[reportKey].fetch()
        if (!cancelled) setRows(data)
      } catch (err) {
        if (!cancelled) setErrorMsg(err.message ?? 'Could not load this report.')
      }
      if (!cancelled) setLoading(false)
    }
    load()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportKey])

  const filteredRows = report?.dateField
    ? rows.filter((r) => withinRange(report.dateField(r), dateFrom, dateTo))
    : rows

  const generatedAt = new Date().toLocaleString()

  function exportCsv() {
    const csv = toCsv(report.columns, filteredRows)
    downloadFile(`${reportKey}-report.csv`, csv, 'text/csv;charset=utf-8;')
  }

  function printReport() {
    window.print()
  }

  return (
    <div>
      <div className="no-print mb-5 flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold">Reports</h1>
          <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
            Every export reflects real transaction data, computed the same way the rest of the app sees it.
          </p>
        </div>
        {!isMatrix && (
          <div className="flex gap-2">
            <button
              onClick={exportCsv}
              disabled={loading || filteredRows.length === 0}
              className="flex items-center gap-1.5 rounded-md border border-[var(--color-line)] px-3.5 py-2 text-sm font-medium disabled:opacity-50"
            >
              <Download size={15} />
              Export CSV
            </button>
            <button
              onClick={printReport}
              disabled={loading || filteredRows.length === 0}
              className="flex items-center gap-1.5 rounded-md bg-[var(--color-ink)] px-3.5 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              <Printer size={15} />
              Print / Save PDF
            </button>
          </div>
        )}
      </div>

      <div className="no-print mb-4 flex flex-wrap gap-1 border-b border-[var(--color-line)]">
        {Object.entries(REPORTS).map(([key, r]) => (
          <button
            key={key}
            onClick={() => setReportKey(key)}
            className={`px-3 py-2 text-sm font-medium ${
              reportKey === key ? 'border-b-2 border-[var(--color-ink)] text-[var(--color-ink)]' : 'text-[var(--color-ink-soft)]'
            }`}
          >
            {r.label}
          </button>
        ))}
        <button
          onClick={() => setReportKey('dailyMatrix')}
          className={`px-3 py-2 text-sm font-medium ${
            isMatrix ? 'border-b-2 border-[var(--color-ink)] text-[var(--color-ink)]' : 'text-[var(--color-ink-soft)]'
          }`}
        >
          Daily Sales Matrix
        </button>
      </div>

      {!isMatrix && (
        <div className="no-print mb-4 flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-[var(--color-ink-soft)]">From</span>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="input" disabled={!report?.dateField} />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-[var(--color-ink-soft)]">To</span>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="input" disabled={!report?.dateField} />
          </label>
          {!report?.dateField && (
            <span className="pb-2 text-xs text-[var(--color-ink-soft)]">This report is a current snapshot — date range doesn't apply.</span>
          )}
        </div>
      )}

      {errorMsg && (
        <div className="no-print mb-4 rounded-md bg-[var(--color-rust-soft)] px-3.5 py-2.5 text-sm text-[var(--color-rust)]">
          {errorMsg}
        </div>
      )}

      {isMatrix ? (
        <DailySalesMatrix dateFrom={dateFrom} dateTo={dateTo} setDateFrom={setDateFrom} setDateTo={setDateTo} />
      ) : (
        <div id="printable-report">
          <div className="mb-3">
            <div className="font-display text-lg font-semibold">{report.label} Report</div>
            <div className="text-xs text-[var(--color-ink-soft)]">{report.description}</div>
            <div className="mt-1 text-xs text-[var(--color-ink-soft)]">Generated {generatedAt}</div>
          </div>

          <div className="overflow-hidden rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)]">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-[var(--color-line)] text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
                <tr>
                  {report.columns.map((c) => (
                    <th key={c.key} className="px-4 py-3">{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={report.columns.length} className="px-4 py-8 text-center text-[var(--color-ink-soft)]">Loading…</td></tr>
                )}
                {!loading && filteredRows.length === 0 && (
                  <tr><td colSpan={report.columns.length} className="px-4 py-10 text-center text-[var(--color-ink-soft)]">No data for this report or date range.</td></tr>
                )}
                {!loading && filteredRows.map((row, i) => (
                  <tr key={i} className="border-b border-[var(--color-line)] last:border-0">
                    {report.columns.map((c) => (
                      <td key={c.key} className="px-4 py-3">
                        {c.render ? c.render(row) : getValue(c, row)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------- Daily Sales Matrix ----------
// Rows = products, columns = one pair of terminal sub-columns per day in range,
// tailed by the same rollup columns as the spreadsheet this mirrors.
function DailySalesMatrix({ dateFrom, dateTo, setDateFrom, setDateTo }) {
  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState('')
  const [matrix, setMatrix] = useState(null) // { days, terminals, productRows }

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setErrorMsg('')
      try {
        const days = datesInRange(dateFrom, dateTo)

        const [productsRes, saleLinesRes, wasteRes] = await Promise.all([
          supabase
            .from('products')
            .select('id, sku, name, unit, current_cost, selling_price, reorder_point, inventory_cache(current_stock)')
            .eq('status', 'active')
            .order('name'),
          supabase
            .from('sale_lines')
            .select('product_id, quantity, unit_price, fifo_cost, sale:sales(sale_date, pos_terminal)')
            .gte('sale_date', dateFrom, { foreignTable: 'sales' })
            .lte('sale_date', dateTo, { foreignTable: 'sales' }),
          supabase
            .from('waste')
            .select('product_id, quantity, waste_date')
            .gte('waste_date', dateFrom)
            .lte('waste_date', dateTo),
        ])

        if (productsRes.error) throw productsRes.error
        if (saleLinesRes.error) throw saleLinesRes.error
        if (wasteRes.error) throw wasteRes.error

        const saleLines = saleLinesRes.data ?? []

        // Detect up to 2 terminal labels actually in use, most frequent first.
        const terminalCounts = {}
        for (const l of saleLines) {
          const t = (l.sale?.pos_terminal || '').trim() || 'Unspecified'
          terminalCounts[t] = (terminalCounts[t] ?? 0) + 1
        }
        let terminals = Object.entries(terminalCounts).sort((a, b) => b[1] - a[1]).map(([t]) => t).slice(0, 2)
        if (terminals.length === 0) terminals = ['POS 1', 'POS 2']
        if (terminals.length === 1) terminals.push(terminals[0] === 'POS 2' ? 'POS 1' : 'POS 2')

        const wastByProduct = {}
        for (const w of wasteRes.data ?? []) {
          wastByProduct[w.product_id] = (wastByProduct[w.product_id] ?? 0) + Number(w.quantity)
        }

        // grid[productId][day][terminal] = qty
        const grid = {}
        let grandTotalQty = 0
        const productTotals = {}

        for (const l of saleLines) {
          const day = toDateOnly(l.sale?.sale_date)
          const terminal = (l.sale?.pos_terminal || '').trim() || 'Unspecified'
          const termIndex = terminals[0] === terminal ? 0 : terminals[1] === terminal ? 1 : null
          if (termIndex === null || !day) continue

          grid[l.product_id] = grid[l.product_id] ?? {}
          grid[l.product_id][day] = grid[l.product_id][day] ?? [0, 0]
          grid[l.product_id][day][termIndex] += Number(l.quantity)

          const qty = Number(l.quantity)
          const lineTotal = qty * Number(l.unit_price)
          const lineCost = Number(l.fifo_cost)
          productTotals[l.product_id] = productTotals[l.product_id] ?? { qty: 0, sales: 0, cost: 0 }
          productTotals[l.product_id].qty += qty
          productTotals[l.product_id].sales += lineTotal
          productTotals[l.product_id].cost += lineCost
          grandTotalQty += qty
        }

        const avgDailyAll = Object.values(productTotals).map((t) => t.qty / (days.length || 1))
        const overallAvg = avgDailyAll.length ? avgDailyAll.reduce((a, b) => a + b, 0) / avgDailyAll.length : 0

        const productRows = (productsRes.data ?? []).map((p) => {
          const cache = Array.isArray(p.inventory_cache) ? p.inventory_cache[0] : p.inventory_cache
          const totals = productTotals[p.id] ?? { qty: 0, sales: 0, cost: 0 }
          const remaining = Number(cache?.current_stock ?? 0)
          const avgDaily = totals.qty / (days.length || 1)
          const wasteQty = wastByProduct[p.id] ?? 0
          return {
            product: p,
            byDay: grid[p.id] ?? {},
            totalQtySold: totals.qty,
            totalSales: totals.sales,
            totalCost: totals.cost,
            remainingQty: remaining,
            percent: grandTotalQty > 0 ? (totals.qty / grandTotalQty) * 100 : 0,
            avgDailySales: avgDaily,
            movement: totals.qty === 0 ? 'No Movement' : avgDaily >= overallAvg ? 'Fast Moving' : 'Slow Moving',
            suggestedPurchase: Math.max(0, Math.round(avgDaily * 7 - remaining)),
            waste: wasteQty,
          }
        })

        if (!cancelled) setMatrix({ days, terminals, productRows })
      } catch (err) {
        if (!cancelled) setErrorMsg(err.message ?? 'Could not load the daily sales matrix.')
      }
      if (!cancelled) setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [dateFrom, dateTo])

  function exportMatrixCsv() {
    if (!matrix) return
    const { days, terminals, productRows } = matrix
    const dayHeader1 = ['', '', '', ''].concat(
      days.flatMap((d) => [d, ''])
    ).concat(['', '', '', '', '', '', '', ''])
    const dayHeader2 = ['SKU', 'Description', 'Unit Cost', 'Price'].concat(
      days.flatMap(() => terminals)
    ).concat(['Total Qty Sold', 'Total Sales', 'Total Cost', 'Remaining Qty', 'Percent', 'Avg Qty Sales', 'Movement', 'Waste', 'Suggested Purchase (7d)'])

    const lines = [dayHeader1, dayHeader2].map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))

    for (const pr of productRows) {
      const row = [pr.product.sku, pr.product.name, Number(pr.product.current_cost).toFixed(2), Number(pr.product.selling_price).toFixed(2)]
      for (const d of days) {
        const cell = pr.byDay[d] ?? [0, 0]
        row.push(cell[0], cell[1])
      }
      row.push(
        pr.totalQtySold,
        pr.totalSales.toFixed(2),
        pr.totalCost.toFixed(2),
        pr.remainingQty,
        pr.percent.toFixed(2) + '%',
        pr.avgDailySales.toFixed(2),
        pr.movement,
        pr.waste,
        pr.suggestedPurchase
      )
      lines.push(row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
    }

    downloadFile('daily-sales-matrix.csv', lines.join('\n'), 'text/csv;charset=utf-8;')
  }

  return (
    <div>
      <div className="no-print mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-[var(--color-ink-soft)]">From</span>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="input" />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-[var(--color-ink-soft)]">To</span>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="input" />
          </label>
          <span className="pb-2 text-xs text-[var(--color-ink-soft)]">Terminal columns are detected automatically from your sales data.</span>
        </div>
        <div className="flex gap-2">
          <button
            onClick={exportMatrixCsv}
            disabled={loading || !matrix}
            className="flex items-center gap-1.5 rounded-md border border-[var(--color-line)] px-3.5 py-2 text-sm font-medium disabled:opacity-50"
          >
            <Download size={15} />
            Export CSV
          </button>
          <button
            onClick={() => window.print()}
            disabled={loading || !matrix}
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

      {loading && <div className="py-10 text-center text-sm text-[var(--color-ink-soft)]">Building the matrix…</div>}

      {!loading && matrix && (
        <div id="printable-report">
          <div className="mb-3">
            <div className="font-display text-lg font-semibold">Daily Sales Matrix</div>
            <div className="text-xs text-[var(--color-ink-soft)]">{dateFrom} to {dateTo} · terminals: {matrix.terminals.join(', ')}</div>
          </div>

          <div className="overflow-auto rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)]">
            <table className="w-full whitespace-nowrap text-left text-xs">
              <thead className="text-[var(--color-ink-soft)]">
                <tr className="border-b border-[var(--color-line)]">
                  <th className="px-2 py-2" colSpan={4} />
                  {matrix.days.map((d) => (
                    <th key={d} className="px-2 py-2 text-center" colSpan={2}>{d.slice(5)}</th>
                  ))}
                  <th className="px-2 py-2" colSpan={9} />
                </tr>
                <tr className="border-b border-[var(--color-line)] uppercase tracking-wide">
                  <th className="px-2 py-2">SKU</th>
                  <th className="px-2 py-2">Description</th>
                  <th className="px-2 py-2">Cost</th>
                  <th className="px-2 py-2">Price</th>
                  {matrix.days.map((d) => (
                    <Fragment key={d}>
                      <th className="px-1 py-2 text-center">{matrix.terminals[0]}</th>
                      <th className="px-1 py-2 text-center">{matrix.terminals[1]}</th>
                    </Fragment>
                  ))}
                  <th className="px-2 py-2">Total Qty</th>
                  <th className="px-2 py-2">Total Sales</th>
                  <th className="px-2 py-2">Total Cost</th>
                  <th className="px-2 py-2">Remaining</th>
                  <th className="px-2 py-2">%</th>
                  <th className="px-2 py-2">Avg/Day</th>
                  <th className="px-2 py-2">Movement</th>
                  <th className="px-2 py-2">Waste</th>
                  <th className="px-2 py-2">Sugg. Purchase (7d)</th>
                </tr>
              </thead>
              <tbody>
                {matrix.productRows.length === 0 && (
                  <tr><td colSpan={4 + matrix.days.length * 2 + 9} className="px-4 py-10 text-center text-[var(--color-ink-soft)]">No active products.</td></tr>
                )}
                {matrix.productRows.map((pr) => (
                  <tr key={pr.product.id} className="border-b border-[var(--color-line)] last:border-0">
                    <td className="font-mono px-2 py-1.5">{pr.product.sku}</td>
                    <td className="px-2 py-1.5">{pr.product.name}</td>
                    <td className="px-2 py-1.5">{Number(pr.product.current_cost).toFixed(2)}</td>
                    <td className="px-2 py-1.5">{Number(pr.product.selling_price).toFixed(2)}</td>
                    {matrix.days.map((d) => {
                      const cell = pr.byDay[d] ?? [0, 0]
                      return (
                        <Fragment key={d}>
                          <td className="px-1 py-1.5 text-center text-[var(--color-ink-soft)]">{cell[0] || ''}</td>
                          <td className="px-1 py-1.5 text-center text-[var(--color-ink-soft)]">{cell[1] || ''}</td>
                        </Fragment>
                      )
                    })}
                    <td className="px-2 py-1.5 font-medium">{pr.totalQtySold}</td>
                    <td className="px-2 py-1.5">{pr.totalSales.toFixed(2)}</td>
                    <td className="px-2 py-1.5">{pr.totalCost.toFixed(2)}</td>
                    <td className="px-2 py-1.5">{pr.remainingQty}</td>
                    <td className="px-2 py-1.5">{pr.percent.toFixed(1)}%</td>
                    <td className="px-2 py-1.5">{pr.avgDailySales.toFixed(2)}</td>
                    <td className="px-2 py-1.5">{pr.movement}</td>
                    <td className="px-2 py-1.5">{pr.waste || ''}</td>
                    <td className="px-2 py-1.5">{pr.suggestedPurchase}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
