import { useEffect, useState } from 'react'
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

// Each report: how to fetch its rows, and how to display/export each column.
// `value(row)` is what goes into CSV. `render(row)` (optional) is what's shown
// on screen — lets a cell show a colored chip while CSV still gets plain text.
const REPORTS = {
  inventory: {
    label: 'Inventory',
    description: 'Current stock and value for every active product.',
    async fetch() {
      const { data, error } = await supabase
        .from('products')
        .select('sku, name, category, unit, current_cost, reorder_point, inventory_cache(current_stock, inventory_value)')
        .eq('status', 'active')
        .order('name')
      if (error) throw error
      return (data ?? []).map((p) => ({
        sku: p.sku,
        name: p.name,
        category: p.category ?? '—',
        unit: p.unit,
        stock: Number(p.inventory_cache?.current_stock ?? 0),
        value: Number(p.inventory_cache?.inventory_value ?? 0),
        reorder_point: Number(p.reorder_point ?? 0),
      }))
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
        const cat = p.category ?? 'Uncategorized'
        groups[cat] = groups[cat] ?? { category: cat, productCount: 0, totalValue: 0 }
        groups[cat].productCount += 1
        groups[cat].totalValue += Number(p.inventory_cache?.inventory_value ?? 0)
      }
      return Object.values(groups).sort((a, b) => b.totalValue - a.totalValue)
    },
    columns: [
      { key: 'category', label: 'Category' },
      { key: 'productCount', label: '# Products' },
      { key: 'totalValue', label: 'Total value', value: (r) => r.totalValue.toFixed(2) },
    ],
  },

  batches: {
    label: 'Batches',
    description: 'Every batch ever received, oldest first within each product.',
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

  expiry: {
    label: 'Expiry',
    description: 'Batches with an expiration date, soonest first.',
    async fetch() {
      const { data, error } = await supabase
        .from('batches')
        .select('batch_number, expiration_date, product:products(name, sku, unit), cache:batch_cache(remaining_quantity)')
        .not('expiration_date', 'is', null)
        .order('expiration_date', { ascending: true })
      if (error) throw error
      return (data ?? []).filter((r) => Number(r.cache?.remaining_quantity ?? 0) > 0)
    },
    columns: [
      { key: 'batch_number', label: 'Batch #' },
      { key: 'product', label: 'Product', value: (r) => r.product?.name },
      { key: 'remaining', label: 'Remaining', value: (r) => `${r.cache?.remaining_quantity ?? 0} ${r.product?.unit ?? ''}` },
      { key: 'expiration_date', label: 'Expires' },
      {
        key: 'status',
        label: 'Status',
        value: (r) => expiryLabel(r.expiration_date),
        render: (r) => <StatusChip tone={expiryTone(r.expiration_date)}>{expiryLabel(r.expiration_date)}</StatusChip>,
      },
    ],
  },

  purchases: {
    label: 'Purchases',
    description: 'Every purchase order, regardless of status.',
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

export default function Reports() {
  const [reportKey, setReportKey] = useState('inventory')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState('')

  const report = REPORTS[reportKey]

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setErrorMsg('')
      try {
        const data = await report.fetch()
        if (!cancelled) setRows(data)
      } catch (err) {
        if (!cancelled) setErrorMsg(err.message ?? 'Could not load this report.')
      }
      if (!cancelled) setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [reportKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const generatedAt = new Date().toLocaleString()

  function exportCsv() {
    const csv = toCsv(report.columns, rows)
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
        <div className="flex gap-2">
          <button
            onClick={exportCsv}
            disabled={loading || rows.length === 0}
            className="flex items-center gap-1.5 rounded-md border border-[var(--color-line)] px-3.5 py-2 text-sm font-medium disabled:opacity-50"
          >
            <Download size={15} />
            Export CSV
          </button>
          <button
            onClick={printReport}
            disabled={loading || rows.length === 0}
            className="flex items-center gap-1.5 rounded-md bg-[var(--color-ink)] px-3.5 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            <Printer size={15} />
            Print / Save PDF
          </button>
        </div>
      </div>

      <div className="no-print mb-4 flex flex-wrap gap-1 border-b border-[var(--color-line)]">
        {Object.entries(REPORTS).map(([key, r]) => (
          <button
            key={key}
            onClick={() => setReportKey(key)}
            className={`px-3 py-2 text-sm font-medium ${
              reportKey === key
                ? 'border-b-2 border-[var(--color-ink)] text-[var(--color-ink)]'
                : 'text-[var(--color-ink-soft)]'
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      {errorMsg && (
        <div className="no-print mb-4 rounded-md bg-[var(--color-rust-soft)] px-3.5 py-2.5 text-sm text-[var(--color-rust)]">
          {errorMsg}
        </div>
      )}

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
              {!loading && rows.length === 0 && (
                <tr><td colSpan={report.columns.length} className="px-4 py-10 text-center text-[var(--color-ink-soft)]">No data yet for this report.</td></tr>
              )}
              {rows.map((row, i) => (
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
    </div>
  )
}
