import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Trash2, Send, Ban, Upload, FileDown, Pencil, X } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { fetchAllRows } from '../lib/fetchAllRows'
import SlidePanel from '../components/SlidePanel'
import StatusChip from '../components/StatusChip'
import ProductPicker from '../components/ProductPicker'
import SortableTh from '../components/SortableTh'
import { useSort, sortRows } from '../lib/sort'
import { parseCsv, normalizeHeader, downloadFile } from '../lib/csv'

const LINE_HEADER_ALIASES = {
  barcode: 'barcode', sku: 'sku',
  quantity: 'quantity', qty: 'quantity',
  unitcost: 'unit_cost', cost: 'unit_cost', unitprice: 'unit_cost',
  expirationdate: 'expiration_date', expiry: 'expiration_date', expdate: 'expiration_date',
}

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

  const { sortKey: purchaseSortKey, sortDir: purchaseSortDir, toggleSort: togglePurchaseSort } = useSort('purchase_date', 'desc')
  function purchaseSortAccessor(row, key) {
    if (key === 'total_cost') return Number(row.total_cost ?? 0)
    return row[key]
  }
  const sortedPurchases = sortRows(purchases, purchaseSortKey, purchaseSortDir, purchaseSortAccessor)
  const [products, setProducts] = useState([])
  const activeProducts = products.filter((p) => p.status === 'active')
  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState('')

  const [panelOpen, setPanelOpen] = useState(false)
  const [selected, setSelected] = useState(null) // the purchase header row, once saved
  const [lines, setLines] = useState([])
  const [headerForm, setHeaderForm] = useState(EMPTY_HEADER)
  const [lineForm, setLineForm] = useState(EMPTY_LINE)
  const [editingLineId, setEditingLineId] = useState(null)
  const [saving, setSaving] = useState(false)

  const lineFileInputRef = useRef(null)
  const [lineImportPanelOpen, setLineImportPanelOpen] = useState(false)
  const [lineImportValid, setLineImportValid] = useState([])
  const [lineImportSkipped, setLineImportSkipped] = useState([])
  const [lineImporting, setLineImporting] = useState(false)
  const [lineImportResult, setLineImportResult] = useState(null)

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
    const { data, error } = await fetchAllRows('products', 'id, sku, name, unit, barcode, status', 'name')
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
    setEditingLineId(null)
    setErrorMsg('')
    setPanelOpen(true)
    loadProducts()
  }

  async function openExisting(purchase) {
    setSelected(purchase)
    setLineForm(EMPTY_LINE)
    setEditingLineId(null)
    setErrorMsg('')
    await loadLines(purchase.id)
    setPanelOpen(true)
    loadProducts()
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

    const payload = {
      product_id: lineForm.product_id,
      quantity: Number(lineForm.quantity),
      unit_cost: Number(lineForm.unit_cost),
      expiration_date: lineForm.expiration_date || null,
    }

    const { error } = editingLineId
      ? await supabase.from('purchase_lines').update(payload).eq('id', editingLineId)
      : await supabase.from('purchase_lines').insert({ purchase_id: selected.id, ...payload })

    setSaving(false)
    if (error) {
      setErrorMsg(error.message)
      return
    }
    setLineForm(EMPTY_LINE)
    setEditingLineId(null)
    await loadLines(selected.id)
  }

  function startEditLine(line) {
    setLineForm({
      product_id: line.product_id,
      quantity: String(line.quantity),
      unit_cost: String(line.unit_cost),
      expiration_date: line.expiration_date || '',
    })
    setEditingLineId(line.id)
    setErrorMsg('')
  }

  function cancelEditLine() {
    setLineForm(EMPTY_LINE)
    setEditingLineId(null)
  }

  function handleDownloadLineTemplate() {
    const headers = ['Barcode', 'Quantity', 'Unit Cost', 'Expiration Date']
    // Two rows share the same barcode on purpose — shows this delivery had two
    // batches of the same product with different expiry dates, which is fine:
    // each row becomes its own line, and its own batch, when the purchase posts.
    const example1 = ['4800123456789', '24', '42.50', '2026-12-31']
    const example2 = ['4800123456789', '12', '42.50', '2027-01-15']
    const csv = [headers, example1, example2].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
    downloadFile('purchase-lines-template.csv', csv, 'text/csv;charset=utf-8;')
  }

  function handleLineImportClick() {
    lineFileInputRef.current?.click()
  }

  function handleLineFileChange(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
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
        const canonicalKeys = headerRow.map((h) => LINE_HEADER_ALIASES[normalizeHeader(h)] ?? null)

        // Strips stray whitespace (including the non-breaking spaces Excel/Sheets
        // sometimes paste in) and ignores case, so a barcode that LOOKS identical
        // doesn't get skipped over an invisible formatting difference.
        // Strips regular whitespace PLUS invisible characters that don't count
        // as whitespace to a regex (zero-width spaces, BOM, soft hyphen) —
        // these can end up baked into a stored value from an earlier copy-paste
        // or import, and look completely identical to the naked eye.
        const cleanCode = (v) =>
          (v ?? '')
            .normalize('NFKC')
            // eslint-disable-next-line no-misleading-character-class -- intentional list of individual invisible chars, not a ZWJ sequence
            .replace(/[\s\u200B\u200C\u200D\u2060\uFEFF\u00AD]/g, '')
            .toUpperCase()

        const valid = []
        const skipped = []

        rows.slice(1).forEach((r, idx) => {
          const rowNum = idx + 2

          // A row with the wrong number of columns almost always means a stray
          // quote or unescaped comma earlier in the file threw off parsing from
          // that point on — every row after it looks "wrong" as a result. Catch
          // it here with a clear reason instead of letting it silently produce
          // a garbled barcode that then just fails to match anything.
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

          const product = obj.barcode
            ? products.find((p) => cleanCode(p.barcode) === cleanCode(obj.barcode))
            : obj.sku
              ? products.find((p) => cleanCode(p.sku) === cleanCode(obj.sku))
              : null

          if (!product) {
            skipped.push({ rowNum, reason: obj.barcode || obj.sku ? `No product matches "${obj.barcode || obj.sku}"` : 'Missing barcode/SKU' })
            return
          }
          if (product.status !== 'active') {
            skipped.push({ rowNum, reason: `${product.name} (${product.barcode}) exists but is archived — restore it in Products first` })
            return
          }
          const quantity = Number(obj.quantity)
          const unitCost = Number(obj.unit_cost)
          if (!quantity || quantity <= 0) {
            skipped.push({ rowNum, reason: 'Missing or invalid quantity' })
            return
          }
          if (isNaN(unitCost) || unitCost < 0) {
            skipped.push({ rowNum, reason: 'Missing or invalid unit cost' })
            return
          }

          valid.push({
            product_id: product.id,
            product_name: product.name,
            unit: product.unit,
            quantity,
            unit_cost: unitCost,
            expiration_date: obj.expiration_date || null,
          })
        })

        setLineImportValid(valid)
        setLineImportSkipped(skipped)
        setLineImportResult(null)
        setErrorMsg('')
        setLineImportPanelOpen(true)
      } catch {
        setErrorMsg('Could not read that file — make sure it is a CSV, not an .xlsx.')
      }
    }
    reader.readAsText(file)
  }

  async function handleConfirmLineImport() {
    setLineImporting(true)
    let inserted = 0
    const failed = []
    for (const row of lineImportValid) {
      const { error } = await supabase.from('purchase_lines').insert({
        purchase_id: selected.id,
        product_id: row.product_id,
        quantity: row.quantity,
        unit_cost: row.unit_cost,
        expiration_date: row.expiration_date,
      })
      if (error) {
        failed.push({ name: row.product_name, reason: error.message })
      } else {
        inserted++
      }
    }
    setLineImporting(false)
    setLineImportResult({ inserted, failed })
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

  async function deleteDraft() {
    if (!confirm(`Delete draft ${selected.purchase_number}? This permanently removes it and its ${lines.length} line${lines.length === 1 ? '' : 's'} — there's nothing to undo, since it's never touched inventory.`)) {
      return
    }
    setSaving(true)
    setErrorMsg('')

    // Delete lines first — purchase_lines.purchase_id is ON DELETE RESTRICT,
    // so the purchase row can't go until its lines are gone.
    const { error: linesErr } = await supabase.from('purchase_lines').delete().eq('purchase_id', selected.id)
    if (linesErr) {
      setSaving(false)
      setErrorMsg(linesErr.message)
      return
    }
    const { error } = await supabase.from('purchases').delete().eq('id', selected.id)
    setSaving(false)
    if (error) {
      setErrorMsg(error.message)
      return
    }
    setPanelOpen(false)
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
              <SortableTh label="Purchase #" sortKey="purchase_number" activeKey={purchaseSortKey} activeDir={purchaseSortDir} onSort={togglePurchaseSort} />
              <SortableTh label="Date" sortKey="purchase_date" activeKey={purchaseSortKey} activeDir={purchaseSortDir} onSort={togglePurchaseSort} />
              <SortableTh label="Supplier" sortKey="supplier" activeKey={purchaseSortKey} activeDir={purchaseSortDir} onSort={togglePurchaseSort} />
              <SortableTh label="Invoice #" sortKey="invoice_number" activeKey={purchaseSortKey} activeDir={purchaseSortDir} onSort={togglePurchaseSort} />
              <SortableTh label="Total" sortKey="total_cost" activeKey={purchaseSortKey} activeDir={purchaseSortDir} onSort={togglePurchaseSort} />
              <SortableTh label="Status" sortKey="status" activeKey={purchaseSortKey} activeDir={purchaseSortDir} onSort={togglePurchaseSort} />
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

            {!loading && sortedPurchases.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-[var(--color-ink-soft)]">
                  No purchases yet — create one to start receiving stock.
                </td>
              </tr>
            )}

            {sortedPurchases.map((p) => (
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

            <div className="mb-4 max-h-64 overflow-auto rounded-md border border-[var(--color-line)]">
              <table className="w-full min-w-[560px] whitespace-nowrap text-left text-sm">
                <thead className="sticky top-0 border-b border-[var(--color-line)] bg-[var(--color-paper-raised)] text-xs text-[var(--color-ink-soft)]">
                  <tr>
                    <th className="px-3 py-2">Product</th>
                    <th className="px-3 py-2">Qty</th>
                    <th className="px-3 py-2">Cost</th>
                    <th className="px-3 py-2">Expiry</th>
                    <th className="px-3 py-2">Total</th>
                    {isDraft && <th className="px-3 py-2" />}
                  </tr>
                </thead>
                <tbody>
                  {lines.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-3 py-5 text-center text-[var(--color-ink-soft)]">
                        No lines yet.
                      </td>
                    </tr>
                  )}
                  {lines.map((l) => (
                    <tr key={l.id} className={`border-b border-[var(--color-line)] last:border-0 ${editingLineId === l.id ? 'bg-[var(--color-amber-soft)]' : ''}`}>
                      <td className="px-3 py-2">{l.product?.name ?? '—'}</td>
                      <td className="px-3 py-2">{l.quantity} {l.product?.unit}</td>
                      <td className="px-3 py-2">{Number(l.unit_cost).toFixed(2)}</td>
                      <td className="px-3 py-2 text-[var(--color-ink-soft)]">{l.expiration_date || '—'}</td>
                      <td className="px-3 py-2">{Number(l.total_cost).toFixed(2)}</td>
                      {isDraft && (
                        <td className="px-3 py-2">
                          <div className="flex gap-1">
                            <button
                              onClick={() => startEditLine(l)}
                              aria-label="Edit line"
                              className="rounded-md p-1 text-[var(--color-ink-soft)] hover:bg-[var(--color-line)]"
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              onClick={() => removeLine(l.id)}
                              aria-label="Remove line"
                              className="rounded-md p-1 text-[var(--color-ink-soft)] hover:bg-[var(--color-line)]"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
                <tfoot className="sticky bottom-0 bg-[var(--color-paper-raised)]">
                  <tr className="border-t border-[var(--color-line)] font-medium">
                    <td colSpan={4} className="px-3 py-2 text-right text-[var(--color-ink-soft)]">
                      Total
                    </td>
                    <td className="px-3 py-2">{runningTotal.toFixed(2)}</td>
                    {isDraft && <td />}
                  </tr>
                </tfoot>
              </table>
            </div>

            {isDraft && (
              <div className="mb-3 flex gap-2">
                <button
                  type="button"
                  onClick={handleDownloadLineTemplate}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-[var(--color-line)] py-2 text-sm font-medium hover:bg-[var(--color-paper)]"
                >
                  <FileDown size={15} />
                  Template
                </button>
                <button
                  type="button"
                  onClick={handleLineImportClick}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-[var(--color-line)] py-2 text-sm font-medium hover:bg-[var(--color-paper)]"
                >
                  <Upload size={15} />
                  Import lines CSV
                </button>
                <input ref={lineFileInputRef} type="file" accept=".csv" onChange={handleLineFileChange} className="hidden" />
              </div>
            )}

            {isDraft && (
              <form onSubmit={handleAddLine} className="mb-5 space-y-3 rounded-md border border-dashed border-[var(--color-line)] p-3">
                <Field label="Product" required>
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <ProductPicker
                        products={activeProducts}
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
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={saving}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-[var(--color-ink)] py-2 text-sm font-medium disabled:opacity-60"
                  >
                    {editingLineId ? <Pencil size={15} /> : <Plus size={15} />}
                    {saving ? 'Saving…' : editingLineId ? 'Update line' : 'Add line'}
                  </button>
                  {editingLineId && (
                    <button
                      type="button"
                      onClick={cancelEditLine}
                      aria-label="Cancel edit"
                      className="rounded-md border border-[var(--color-line)] px-3 hover:bg-[var(--color-paper)]"
                    >
                      <X size={15} />
                    </button>
                  )}
                </div>
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

            {isDraft && (
              <button
                onClick={deleteDraft}
                disabled={saving}
                className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--color-rust)] py-2.5 text-sm font-medium text-[var(--color-rust)] disabled:opacity-60"
              >
                <Trash2 size={15} />
                Delete draft
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

      <SlidePanel
        open={lineImportPanelOpen}
        title="Import purchase lines"
        onClose={() => setLineImportPanelOpen(false)}
      >
        {!lineImportResult ? (
          <div>
            <div className="mb-4 grid grid-cols-2 gap-3">
              <div className="rounded-md border border-[var(--color-line)] bg-[var(--color-paper)] p-3 text-center">
                <div className="font-display text-xl font-semibold text-[var(--color-herb)]">{lineImportValid.length}</div>
                <div className="text-xs text-[var(--color-ink-soft)]">ready to import</div>
              </div>
              <div className="rounded-md border border-[var(--color-line)] bg-[var(--color-paper)] p-3 text-center">
                <div className="font-display text-xl font-semibold text-[var(--color-rust)]">{lineImportSkipped.length}</div>
                <div className="text-xs text-[var(--color-ink-soft)]">skipped</div>
              </div>
            </div>

            {lineImportSkipped.length > 0 && (
              <div className="mb-4">
                <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">Skipped rows</div>
                <div className="max-h-48 space-y-1 overflow-y-auto">
                  {lineImportSkipped.map((s, i) => (
                    <div key={i} className="rounded-md bg-[var(--color-rust-soft)] px-2.5 py-1.5 text-xs text-[var(--color-rust)]">
                      Row {s.rowNum}: {s.reason}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {lineImportValid.length > 0 && (
              <div className="mb-4">
                <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">Preview (first 5)</div>
                <div className="space-y-1">
                  {lineImportValid.slice(0, 5).map((r, i) => (
                    <div key={i} className="rounded-md border border-[var(--color-line)] px-2.5 py-1.5 text-xs">
                      <span className="font-medium">{r.product_name}</span> — {r.quantity} {r.unit} @ {r.unit_cost.toFixed(2)}
                      {r.expiration_date && <span className="text-[var(--color-ink-soft)]"> — exp {r.expiration_date}</span>}
                    </div>
                  ))}
                  {lineImportValid.length > 5 && (
                    <div className="text-xs text-[var(--color-ink-soft)]">…and {lineImportValid.length - 5} more</div>
                  )}
                </div>
              </div>
            )}

            <button
              onClick={handleConfirmLineImport}
              disabled={lineImporting || lineImportValid.length === 0}
              className="w-full rounded-md bg-[var(--color-ink)] py-2.5 text-sm font-medium text-white disabled:opacity-60"
            >
              {lineImporting ? 'Importing…' : `Import ${lineImportValid.length} line${lineImportValid.length === 1 ? '' : 's'}`}
            </button>
          </div>
        ) : (
          <div>
            <div className="mb-4 rounded-md bg-[var(--color-herb-soft)] px-3.5 py-2.5 text-sm text-[var(--color-herb)]">
              {lineImportResult.inserted} line{lineImportResult.inserted === 1 ? '' : 's'} added.
            </div>
            {lineImportResult.failed.length > 0 && (
              <div className="mb-4">
                <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">
                  {lineImportResult.failed.length} failed while saving
                </div>
                <div className="max-h-48 space-y-1 overflow-y-auto">
                  {lineImportResult.failed.map((f, i) => (
                    <div key={i} className="rounded-md bg-[var(--color-rust-soft)] px-2.5 py-1.5 text-xs text-[var(--color-rust)]">
                      {f.name}: {f.reason}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <button
              onClick={() => setLineImportPanelOpen(false)}
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
