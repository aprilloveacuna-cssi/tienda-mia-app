import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Search, Archive, RotateCcw, Pencil, Download, Upload, FileDown } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { fetchAllRows } from '../lib/fetchAllRows'
import SlidePanel from '../components/SlidePanel'
import StatusChip from '../components/StatusChip'
import SortableTh from '../components/SortableTh'
import { useSort, sortRows } from '../lib/sort'

// Maps flexible spreadsheet header names to the actual product columns, so an
// import doesn't fail just because someone wrote "Price" instead of "Selling Price".
const HEADER_ALIASES = {
  barcode: 'barcode',
  name: 'name', productname: 'name', description: 'name', item: 'name',
  brand: 'brand',
  category: 'category',
  businessunit: 'business_unit', unit_business: 'business_unit',
  producttype: 'product_type', type: 'product_type',
  unit: 'unit', uom: 'unit',
  sellingprice: 'selling_price', price: 'selling_price',
  minimumstock: 'minimum_stock', minstock: 'minimum_stock',
  reorderpoint: 'reorder_point', reorder: 'reorder_point',
  safetystock: 'safety_stock',
  notes: 'notes', remarks: 'notes',
}

function normalizeHeader(h) {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '')
}

// Small hand-written CSV parser — handles quoted fields containing commas
// (product names/notes often do), which a plain split(',') would break on.
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  const pushField = () => { row.push(field); field = '' }
  const pushRow = () => { pushField(); rows.push(row); row = [] }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else { inQuotes = false }
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      pushField()
    } else if (c === '\n') {
      pushRow()
    } else if (c !== '\r') {
      field += c
    }
  }
  if (field !== '' || row.length > 0) pushRow()
  return rows.filter((r) => r.some((v) => v.trim() !== ''))
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

// Name/category/brand/etc. get forced to caps for consistency across the
// catalog — matches the convention already used in the spreadsheet this
// replaced. Barcode and Notes are left as typed (an identifier and free text,
// not descriptive labels).
function upper(v) {
  return v ? v.toUpperCase() : v
}

const EMPTY_FORM = {
  barcode: '',
  name: '',
  brand: '',
  category: '',
  business_unit: '',
  product_type: '',
  unit: '',
  selling_price: '',
  minimum_stock: '',
  reorder_point: '',
  safety_stock: '',
  notes: '',
}

export default function Products() {
  const [products, setProducts] = useState([])
  const [lists, setLists] = useState({})
  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState('')
  const [search, setSearch] = useState('')
  const [panelOpen, setPanelOpen] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  const fileInputRef = useRef(null)
  const [importPanelOpen, setImportPanelOpen] = useState(false)
  const [importValid, setImportValid] = useState([])
  const [importSkipped, setImportSkipped] = useState([])
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState(null)

  async function loadProducts() {
    setLoading(true)
    setErrorMsg('')
    const { data, error } = await fetchAllRows('products', '*', 'created_at', { ascending: false })

    if (error) {
      setErrorMsg(
        error.message.includes('fetch')
          ? 'Could not reach Supabase. Check your .env values and that the migrations have run.'
          : error.message
      )
    } else {
      setProducts(data ?? [])
    }
    setLoading(false)
  }

  async function loadLists() {
    const { data, error } = await supabase
      .from('lists')
      .select('list_type, value')
      .eq('active', true)
      .order('value')

    if (!error && data) {
      const grouped = {}
      for (const row of data) {
        grouped[row.list_type] = grouped[row.list_type] ?? []
        grouped[row.list_type].push(row.value)
      }
      setLists(grouped)
    }
  }

  useEffect(() => {
    loadProducts()
    loadLists()
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return products
    return products.filter(
      (p) =>
        p.name?.toLowerCase().includes(q) ||
        p.barcode?.toLowerCase().includes(q) ||
        p.sku?.toLowerCase().includes(q)
    )
  }, [products, search])

  const { sortKey, sortDir, toggleSort } = useSort('name')
  function sortAccessor(row, key) {
    if (key === 'price') return Number(row.selling_price ?? 0)
    return row[key]
  }
  const sorted = sortRows(filtered, sortKey, sortDir, sortAccessor)

  function openAddPanel() {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setPanelOpen(true)
  }

  function openEditPanel(product) {
    setEditingId(product.id)
    setForm({
      barcode: product.barcode ?? '',
      name: product.name ?? '',
      brand: product.brand ?? '',
      category: product.category ?? '',
      business_unit: product.business_unit ?? '',
      product_type: product.product_type ?? '',
      unit: product.unit ?? '',
      selling_price: product.selling_price ?? '',
      minimum_stock: product.minimum_stock ?? '',
      reorder_point: product.reorder_point ?? '',
      safety_stock: product.safety_stock ?? '',
      notes: product.notes ?? '',
    })
    setPanelOpen(true)
  }

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)
    setErrorMsg('')

    const payload = {
      barcode: form.barcode.trim(),
      name: upper(form.name.trim()),
      brand: upper(form.brand.trim()) || null,
      category: upper(form.category) || null,
      business_unit: upper(form.business_unit) || null,
      product_type: upper(form.product_type) || null,
      unit: upper(form.unit) || null,
      selling_price: form.selling_price === '' ? 0 : Number(form.selling_price),
      minimum_stock: form.minimum_stock === '' ? 0 : Number(form.minimum_stock),
      reorder_point: form.reorder_point === '' ? 0 : Number(form.reorder_point),
      safety_stock: form.safety_stock === '' ? 0 : Number(form.safety_stock),
      notes: form.notes.trim() || null,
    }

    const { error } = editingId
      ? await supabase.from('products').update(payload).eq('id', editingId)
      : await supabase.from('products').insert(payload)

    if (error) {
      // Postgres unique_violation on barcode surfaces here in plain terms
      setErrorMsg(
        error.code === '23505'
          ? 'That barcode is already assigned to another product.'
          : error.message
      )
      setSaving(false)
      return
    }

    setSaving(false)
    setPanelOpen(false)
    loadProducts()
  }

  async function toggleArchive(product) {
    const nextStatus = product.status === 'active' ? 'archived' : 'active'
    const { error } = await supabase
      .from('products')
      .update({ status: nextStatus })
      .eq('id', product.id)
    if (!error) loadProducts()
  }

  function handleExportCsv() {
    const headers = [
      'SKU', 'Barcode', 'Name', 'Brand', 'Category', 'Business Unit', 'Product Type', 'Unit',
      'Selling Price', 'Current Cost', 'Minimum Stock', 'Reorder Point', 'Safety Stock', 'Status', 'Notes',
    ]
    const dataRows = products.map((p) => [
      p.sku, p.barcode, p.name, p.brand ?? '', p.category ?? '', p.business_unit ?? '',
      p.product_type ?? '', p.unit ?? '', p.selling_price, p.current_cost, p.minimum_stock,
      p.reorder_point, p.safety_stock, p.status, p.notes ?? '',
    ])
    const csv = [headers, ...dataRows]
      .map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\n')
    downloadFile('products-export.csv', csv, 'text/csv;charset=utf-8;')
  }

  function handleDownloadTemplate() {
    const headers = [
      'Barcode', 'Name', 'Brand', 'Category', 'Business Unit', 'Product Type', 'Unit',
      'Selling Price', 'Minimum Stock', 'Reorder Point', 'Safety Stock', 'Notes',
    ]
    // One retail example, one kitchen example — kitchen items still need SOME
    // barcode value (schema requires it), so an internal code works fine here.
    const exampleRetail = ['4800123456789', 'Coke 330ML', 'Coca-Cola', 'Beverages', 'Retail', 'Retail Item', 'pcs', '45', '24', '12', '6', '']
    const exampleKitchen = ['TMIA-TURON-001', 'T.Mia Banana Turon', '', 'Bakery', 'Kitchen', 'Finished Good', 'pcs', '25', '0', '0', '0', 'Prepared in-house, no supplier barcode']
    const csv = [headers, exampleRetail, exampleKitchen]
      .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    downloadFile('products-import-template.csv', csv, 'text/csv;charset=utf-8;')
  }

  function handleImportClick() {
    fileInputRef.current?.click()
  }

  function handleFileChange(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // reset so picking the same file again still fires onChange
    if (!file) return

    const reader = new FileReader()
    reader.onload = () => {
      try {
        const rows = parseCsv(String(reader.result))
        if (rows.length < 2) {
          setErrorMsg('That file has no data rows.')
          return
        }
        const headerRow = rows[0].map((h) => h.trim())
        const canonicalKeys = headerRow.map((h) => HEADER_ALIASES[normalizeHeader(h)] ?? null)

        const existingBarcodes = new Set(products.map((p) => p.barcode))
        const seenInFile = new Set()
        const valid = []
        const skipped = []

        rows.slice(1).forEach((r, idx) => {
          const rowNum = idx + 2 // human-friendly: header is row 1

          if (r.length !== headerRow.length) {
            skipped.push({
              rowNum,
              reason: `Row has ${r.length} column${r.length === 1 ? '' : 's'}, expected ${headerRow.length} — likely a stray quote or comma in this row or an earlier one threw off parsing from here on`,
            })
            return
          }

          const obj = {}
          canonicalKeys.forEach((key, i) => {
            if (key) obj[key] = (r[i] ?? '').trim()
          })
          const barcode = obj.barcode || ''
          const name = obj.name || ''

          if (!barcode || !name) {
            skipped.push({ rowNum, reason: 'Missing barcode or name' })
            return
          }
          if (existingBarcodes.has(barcode)) {
            skipped.push({ rowNum, reason: `Barcode ${barcode} already exists in Products` })
            return
          }
          if (seenInFile.has(barcode)) {
            skipped.push({ rowNum, reason: `Duplicate barcode ${barcode} within this file` })
            return
          }
          seenInFile.add(barcode)

          valid.push({
            barcode,
            name: upper(name),
            brand: upper(obj.brand) || null,
            category: upper(obj.category) || null,
            business_unit: upper(obj.business_unit) || null,
            product_type: upper(obj.product_type) || null,
            unit: upper(obj.unit) || null,
            selling_price: obj.selling_price ? Number(obj.selling_price) || 0 : 0,
            minimum_stock: obj.minimum_stock ? Number(obj.minimum_stock) || 0 : 0,
            reorder_point: obj.reorder_point ? Number(obj.reorder_point) || 0 : 0,
            safety_stock: obj.safety_stock ? Number(obj.safety_stock) || 0 : 0,
            notes: obj.notes || null,
          })
        })

        setImportValid(valid)
        setImportSkipped(skipped)
        setImportResult(null)
        setErrorMsg('')
        setImportPanelOpen(true)
      } catch {
        setErrorMsg('Could not read that file — make sure it is a CSV export, not an .xlsx.')
      }
    }
    reader.readAsText(file)
  }

  async function syncListsFromImport(rows) {
    const buckets = { Category: new Set(), BusinessUnit: new Set(), ProductType: new Set(), Unit: new Set() }
    for (const r of rows) {
      if (r.category) buckets.Category.add(r.category)
      if (r.business_unit) buckets.BusinessUnit.add(r.business_unit)
      if (r.product_type) buckets.ProductType.add(r.product_type)
      if (r.unit) buckets.Unit.add(r.unit)
    }
    const newListRows = []
    for (const [listType, values] of Object.entries(buckets)) {
      for (const value of values) newListRows.push({ list_type: listType, value })
    }
    if (newListRows.length === 0) return
    // ignoreDuplicates: leaves any list value that already exists untouched
    // (in case someone had deliberately deactivated it), only adds genuinely new ones.
    await supabase.from('lists').upsert(newListRows, { onConflict: 'list_type,value', ignoreDuplicates: true })
  }

  async function handleConfirmImport() {
    setImporting(true)
    let inserted = 0
    const failed = []
    for (const row of importValid) {
      const { error } = await supabase.from('products').insert(row)
      if (error) {
        failed.push({ name: row.name, reason: error.code === '23505' ? 'Barcode already exists' : error.message })
      } else {
        inserted++
      }
    }
    await syncListsFromImport(importValid)
    setImporting(false)
    setImportResult({ inserted, failed })
    loadProducts()
    loadLists() // pick up any new Category/Business Unit/Product Type/Unit values right away
  }

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold">Products</h1>
          <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
            Master data only — stock levels live in Inventory once purchases start flowing in.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleDownloadTemplate}
            className="flex items-center gap-1.5 rounded-md border border-[var(--color-line)] px-3.5 py-2 text-sm font-medium hover:bg-[var(--color-paper)]"
          >
            <FileDown size={16} />
            Template
          </button>
          <button
            onClick={handleExportCsv}
            className="flex items-center gap-1.5 rounded-md border border-[var(--color-line)] px-3.5 py-2 text-sm font-medium hover:bg-[var(--color-paper)]"
          >
            <Download size={16} />
            Export CSV
          </button>
          <button
            onClick={handleImportClick}
            className="flex items-center gap-1.5 rounded-md border border-[var(--color-line)] px-3.5 py-2 text-sm font-medium hover:bg-[var(--color-paper)]"
          >
            <Upload size={16} />
            Import CSV
          </button>
          <input ref={fileInputRef} type="file" accept=".csv" onChange={handleFileChange} className="hidden" />
          <button
            onClick={openAddPanel}
            className="flex items-center gap-1.5 rounded-md bg-[var(--color-ink)] px-3.5 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            <Plus size={16} />
            Add product
          </button>
        </div>
      </div>

      <div className="mb-4 flex items-center gap-2 rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-3 py-2">
        <Search size={16} className="text-[var(--color-ink-soft)]" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, barcode, or SKU"
          className="w-full bg-transparent text-sm outline-none placeholder:text-[var(--color-ink-soft)]/60"
        />
      </div>

      {errorMsg && (
        <div className="mb-4 rounded-md bg-[var(--color-rust-soft)] px-3.5 py-2.5 text-sm text-[var(--color-rust)]">
          {errorMsg}
        </div>
      )}

      <div className="overflow-hidden rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)]">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[var(--color-line)] text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
            <tr>
              <SortableTh label="SKU" sortKey="sku" activeKey={sortKey} activeDir={sortDir} onSort={toggleSort} />
              <SortableTh label="Barcode" sortKey="barcode" activeKey={sortKey} activeDir={sortDir} onSort={toggleSort} />
              <SortableTh label="Name" sortKey="name" activeKey={sortKey} activeDir={sortDir} onSort={toggleSort} />
              <SortableTh label="Category" sortKey="category" activeKey={sortKey} activeDir={sortDir} onSort={toggleSort} />
              <SortableTh label="Unit" sortKey="unit" activeKey={sortKey} activeDir={sortDir} onSort={toggleSort} />
              <SortableTh label="Price" sortKey="price" activeKey={sortKey} activeDir={sortDir} onSort={toggleSort} />
              <SortableTh label="Status" sortKey="status" activeKey={sortKey} activeDir={sortDir} onSort={toggleSort} />
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-[var(--color-ink-soft)]">
                  Loading products…
                </td>
              </tr>
            )}

            {!loading && sorted.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-[var(--color-ink-soft)]">
                  {products.length === 0
                    ? 'No products yet — add your first one to start the master list.'
                    : 'No products match that search.'}
                </td>
              </tr>
            )}

            {sorted.map((p) => (
              <tr key={p.id} className="border-b border-[var(--color-line)] last:border-0">
                <td className="font-mono px-4 py-3 text-xs text-[var(--color-ink-soft)]">{p.sku}</td>
                <td className="font-mono px-4 py-3 text-xs text-[var(--color-ink-soft)]">{p.barcode}</td>
                <td className="px-4 py-3 font-medium">{p.name}</td>
                <td className="px-4 py-3 text-[var(--color-ink-soft)]">{p.category || '—'}</td>
                <td className="px-4 py-3 text-[var(--color-ink-soft)]">{p.unit || '—'}</td>
                <td className="px-4 py-3">
                  {p.selling_price ? Number(p.selling_price).toFixed(2) : '—'}
                </td>
                <td className="px-4 py-3">
                  <StatusChip tone={p.status === 'active' ? 'ok' : 'neutral'}>
                    {p.status}
                  </StatusChip>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    <button
                      onClick={() => openEditPanel(p)}
                      aria-label={`Edit ${p.name}`}
                      className="rounded-md p-1.5 text-[var(--color-ink-soft)] hover:bg-[var(--color-line)]"
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      onClick={() => toggleArchive(p)}
                      aria-label={p.status === 'active' ? `Archive ${p.name}` : `Restore ${p.name}`}
                      className="rounded-md p-1.5 text-[var(--color-ink-soft)] hover:bg-[var(--color-line)]"
                    >
                      {p.status === 'active' ? <Archive size={15} /> : <RotateCcw size={15} />}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <SlidePanel
        open={panelOpen}
        title={editingId ? 'Edit product' : 'Add product'}
        onClose={() => setPanelOpen(false)}
      >
        <form onSubmit={handleSave} className="space-y-4">
          <Field label="Barcode" required>
            <input
              required
              value={form.barcode}
              onChange={(e) => setForm({ ...form, barcode: e.target.value })}
              className="input"
            />
          </Field>

          <Field label="Product name" required>
            <input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="input"
            />
          </Field>

          <Field label="Brand">
            <input
              value={form.brand}
              onChange={(e) => setForm({ ...form, brand: e.target.value })}
              className="input"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Category">
              <SelectOrText
                value={form.category}
                onChange={(v) => setForm({ ...form, category: v })}
                options={lists.Category}
              />
            </Field>
            <Field label="Unit">
              <SelectOrText
                value={form.unit}
                onChange={(v) => setForm({ ...form, unit: v })}
                options={lists.Unit}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Business unit">
              <SelectOrText
                value={form.business_unit}
                onChange={(v) => setForm({ ...form, business_unit: v })}
                options={lists.BusinessUnit}
              />
            </Field>
            <Field label="Product type">
              <SelectOrText
                value={form.product_type}
                onChange={(v) => setForm({ ...form, product_type: v })}
                options={lists.ProductType}
              />
            </Field>
          </div>

          <Field label="Selling price">
            <input
              type="number"
              step="0.01"
              min="0"
              value={form.selling_price}
              onChange={(e) => setForm({ ...form, selling_price: e.target.value })}
              className="input"
            />
          </Field>

          <div className="grid grid-cols-3 gap-3">
            <Field label="Min stock">
              <input
                type="number"
                min="0"
                value={form.minimum_stock}
                onChange={(e) => setForm({ ...form, minimum_stock: e.target.value })}
                className="input"
              />
            </Field>
            <Field label="Reorder pt.">
              <input
                type="number"
                min="0"
                value={form.reorder_point}
                onChange={(e) => setForm({ ...form, reorder_point: e.target.value })}
                className="input"
              />
            </Field>
            <Field label="Safety stock">
              <input
                type="number"
                min="0"
                value={form.safety_stock}
                onChange={(e) => setForm({ ...form, safety_stock: e.target.value })}
                className="input"
              />
            </Field>
          </div>

          <Field label="Notes">
            <textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              rows={3}
              className="input resize-none"
            />
          </Field>

          <button
            type="submit"
            disabled={saving}
            className="w-full rounded-md bg-[var(--color-ink)] py-2.5 text-sm font-medium text-white disabled:opacity-60"
          >
            {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add product'}
          </button>
        </form>
      </SlidePanel>

      <SlidePanel
        open={importPanelOpen}
        title="Import products"
        onClose={() => setImportPanelOpen(false)}
      >
        {!importResult ? (
          <div>
            <div className="mb-4 grid grid-cols-2 gap-3">
              <div className="rounded-md border border-[var(--color-line)] bg-[var(--color-paper)] p-3 text-center">
                <div className="font-display text-xl font-semibold text-[var(--color-herb)]">{importValid.length}</div>
                <div className="text-xs text-[var(--color-ink-soft)]">ready to import</div>
              </div>
              <div className="rounded-md border border-[var(--color-line)] bg-[var(--color-paper)] p-3 text-center">
                <div className="font-display text-xl font-semibold text-[var(--color-rust)]">{importSkipped.length}</div>
                <div className="text-xs text-[var(--color-ink-soft)]">skipped</div>
              </div>
            </div>

            {importSkipped.length > 0 && (
              <div className="mb-4">
                <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">Skipped rows</div>
                <div className="max-h-48 space-y-1 overflow-y-auto">
                  {importSkipped.map((s, i) => (
                    <div key={i} className="rounded-md bg-[var(--color-rust-soft)] px-2.5 py-1.5 text-xs text-[var(--color-rust)]">
                      Row {s.rowNum}: {s.reason}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {importValid.length > 0 && (
              <div className="mb-4">
                <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">Preview (first 5)</div>
                <div className="space-y-1">
                  {importValid.slice(0, 5).map((r, i) => (
                    <div key={i} className="rounded-md border border-[var(--color-line)] px-2.5 py-1.5 text-xs">
                      <span className="font-medium">{r.name}</span> — {r.barcode} — {r.business_unit || 'no business unit'}
                    </div>
                  ))}
                  {importValid.length > 5 && (
                    <div className="text-xs text-[var(--color-ink-soft)]">…and {importValid.length - 5} more</div>
                  )}
                </div>
              </div>
            )}

            <button
              onClick={handleConfirmImport}
              disabled={importing || importValid.length === 0}
              className="w-full rounded-md bg-[var(--color-ink)] py-2.5 text-sm font-medium text-white disabled:opacity-60"
            >
              {importing ? 'Importing…' : `Import ${importValid.length} product${importValid.length === 1 ? '' : 's'}`}
            </button>
          </div>
        ) : (
          <div>
            <div className="mb-4 rounded-md bg-[var(--color-herb-soft)] px-3.5 py-2.5 text-sm text-[var(--color-herb)]">
              {importResult.inserted} product{importResult.inserted === 1 ? '' : 's'} added.
            </div>
            {importResult.failed.length > 0 && (
              <div className="mb-4">
                <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">
                  {importResult.failed.length} failed while saving
                </div>
                <div className="max-h-48 space-y-1 overflow-y-auto">
                  {importResult.failed.map((f, i) => (
                    <div key={i} className="rounded-md bg-[var(--color-rust-soft)] px-2.5 py-1.5 text-xs text-[var(--color-rust)]">
                      {f.name}: {f.reason}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <button
              onClick={() => setImportPanelOpen(false)}
              className="w-full rounded-md bg-[var(--color-ink)] py-2.5 text-sm font-medium text-white"
            >
              Done
            </button>
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

function SelectOrText({ value, onChange, options }) {
  // Falls back to free text until the `lists` table has values for this type seeded.
  if (options && options.length > 0) {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} className="input">
        <option value="">Select…</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    )
  }
  return <input value={value} onChange={(e) => onChange(e.target.value)} className="input" />
}
