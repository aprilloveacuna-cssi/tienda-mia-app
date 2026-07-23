import { useEffect, useState } from 'react'
import { Plus, Trash2, Download, Printer, ArrowLeft, Pencil, X, Archive, RotateCcw } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { fetchAllRows } from '../lib/fetchAllRows'
import ProductPicker from '../components/ProductPicker'
import SearchBar from '../components/SearchBar'
import { downloadFile } from '../lib/csv'

const EMPTY_LINE_FORM = { product_id: '', quantity: '', unit_cost: '', packaging_note: '' }

function costPerPiece(l) {
  return Math.round(Number(l.unit_cost) * 100) / 100
}
function costForecast(l) {
  return Number(l.quantity) * costPerPiece(l)
}
function listTotal(list) {
  return (list.purchase_list_lines ?? []).reduce((sum, l) => sum + costForecast(l), 0)
}
function listItemCount(list) {
  return (list.purchase_list_lines ?? []).length
}

export default function PurchaseList() {
  const [lists, setLists] = useState([])
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState('')
  const [search, setSearch] = useState('')
  const [showArchived, setShowArchived] = useState(false)

  const [selected, setSelected] = useState(null)
  const [lines, setLines] = useState([])
  const [labelDraft, setLabelDraft] = useState('')
  const [lineForm, setLineForm] = useState(EMPTY_LINE_FORM)
  const [editingLineId, setEditingLineId] = useState(null)
  const [saving, setSaving] = useState(false)

  async function loadLists() {
    setLoading(true)
    setErrorMsg('')
    const { data, error } = await fetchAllRows('purchase_lists', '*, purchase_list_lines(quantity, unit_cost)', 'updated_at', { ascending: false })
    if (error) {
      setErrorMsg('Could not reach Supabase. Check your .env values and that migrations have run.')
    } else {
      setLists(data ?? [])
    }
    setLoading(false)
  }

  async function loadProducts() {
    const { data, error } = await fetchAllRows('products', 'id, sku, name, unit, barcode, current_cost, status', 'name')
    if (!error) setProducts((data ?? []).filter((p) => p.status === 'active'))
  }

  useEffect(() => {
    loadLists()
    loadProducts()
  }, [])

  async function loadLines(listId) {
    const { data, error } = await supabase
      .from('purchase_list_lines')
      .select('*, product:products(name, sku, unit, barcode)')
      .eq('purchase_list_id', listId)
      .order('created_at')
    if (!error) setLines(data ?? [])
  }

  async function openNew() {
    setErrorMsg('')
    const { data, error } = await supabase.from('purchase_lists').insert({}).select().single()
    if (error) {
      setErrorMsg(error.message)
      return
    }
    setSelected(data)
    setLabelDraft('')
    setLines([])
    setLineForm(EMPTY_LINE_FORM)
    setEditingLineId(null)
    loadLists()
  }

  async function openExisting(list) {
    setSelected(list)
    setLabelDraft(list.label ?? '')
    setLineForm(EMPTY_LINE_FORM)
    setEditingLineId(null)
    setErrorMsg('')
    await loadLines(list.id)
  }

  async function saveLabel() {
    const { error } = await supabase.from('purchase_lists').update({ label: labelDraft.trim() || null }).eq('id', selected.id)
    if (!error) loadLists()
  }

  async function archiveList(list, e) {
    e.stopPropagation()
    if (!confirm(`Archive ${list.list_number}${list.label ? ` (${list.label})` : ''}? It'll move out of the main list, but nothing is lost — you can restore it anytime from "Show archived."`)) return
    await supabase.from('purchase_lists').update({ status: 'archived' }).eq('id', list.id)
    if (selected?.id === list.id) setSelected(null)
    loadLists()
  }

  async function restoreList(list, e) {
    e.stopPropagation()
    await supabase.from('purchase_lists').update({ status: 'active' }).eq('id', list.id)
    loadLists()
  }

  async function permanentlyDeleteList(list, e) {
    e.stopPropagation()
    if (!confirm(`Permanently delete ${list.list_number}${list.label ? ` (${list.label})` : ''}? This genuinely cannot be undone — there's no archive after this.`)) return
    await supabase.from('purchase_lists').delete().eq('id', list.id)
    if (selected?.id === list.id) setSelected(null)
    loadLists()
  }

  function onProductPick(id) {
    const p = products.find((x) => x.id === id)
    setLineForm({
      product_id: id,
      quantity: '',
      unit_cost: p?.current_cost ? String(p.current_cost) : '',
      packaging_note: '',
    })
  }

  function startEditLine(line) {
    setEditingLineId(line.id)
    setLineForm({
      product_id: line.product_id,
      quantity: String(line.quantity),
      unit_cost: String(line.unit_cost),
      packaging_note: line.packaging_note ?? '',
    })
  }

  function cancelEditLine() {
    setEditingLineId(null)
    setLineForm(EMPTY_LINE_FORM)
  }

  async function submitLine(e) {
    e.preventDefault()
    if (!lineForm.product_id || !lineForm.quantity || lineForm.unit_cost === '') return
    setSaving(true)
    setErrorMsg('')

    const payload = {
      product_id: lineForm.product_id,
      quantity: Number(lineForm.quantity),
      unit_cost: Number(lineForm.unit_cost),
      packaging_note: lineForm.packaging_note.trim() || null,
    }

    const { error } = editingLineId
      ? await supabase.from('purchase_list_lines').update(payload).eq('id', editingLineId)
      : await supabase.from('purchase_list_lines').insert({ purchase_list_id: selected.id, ...payload })

    await supabase.from('purchase_lists').update({ updated_at: new Date().toISOString() }).eq('id', selected.id)

    setSaving(false)
    if (error) {
      setErrorMsg(error.message)
      return
    }
    setLineForm(EMPTY_LINE_FORM)
    setEditingLineId(null)
    await loadLines(selected.id)
    loadLists()
  }

  async function removeLine(lineId) {
    await supabase.from('purchase_list_lines').delete().eq('id', lineId)
    await supabase.from('purchase_lists').update({ updated_at: new Date().toISOString() }).eq('id', selected.id)
    await loadLines(selected.id)
    loadLists()
  }

  const grandTotal = lines.reduce((sum, l) => sum + costForecast(l), 0)

  function exportCsv() {
    const headers = ['Code', 'Description', 'Unit Cost', 'Purchase Qty', 'Packaging', 'Cost Per Piece', 'Cost Forecast']
    const rows = lines.map((l) => [
      l.product?.barcode,
      l.product?.name,
      Number(l.unit_cost).toFixed(2),
      `${l.quantity} ${l.product?.unit ?? ''}`,
      l.packaging_note ?? '',
      costPerPiece(l).toFixed(2),
      costForecast(l).toFixed(2),
    ])
    rows.push(['', '', '', '', '', 'TOTAL', grandTotal.toFixed(2)])
    const csv = [headers, ...rows]
      .map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\n')
    downloadFile(`${selected.list_number}.csv`, csv, 'text/csv;charset=utf-8;')
  }

  function printList() {
    window.print()
  }

  const visibleLists = lists.filter((l) => (showArchived ? l.status === 'archived' : l.status !== 'archived'))
  const searchedLists = search.trim()
    ? visibleLists.filter((l) => {
        const q = search.trim().toLowerCase()
        return l.list_number?.toLowerCase().includes(q) || l.label?.toLowerCase().includes(q)
      })
    : visibleLists

  if (selected) {
    return (
      <div>
        <button
          onClick={() => setSelected(null)}
          className="no-print mb-4 flex items-center gap-1.5 text-sm font-medium text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
        >
          <ArrowLeft size={15} />
          Back to all lists
        </button>

        <div className="no-print mb-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div>
              <h1 className="font-display text-2xl font-semibold">{selected.list_number}</h1>
              <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
                Saved automatically as you go — safe to switch tabs and come back anytime.
              </p>
            </div>
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

        <div className="no-print mb-5 flex items-end gap-2">
          <label className="block flex-1">
            <span className="mb-1 block text-xs font-medium text-[var(--color-ink-soft)]">Label (optional)</span>
            <input
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              onBlur={saveLabel}
              placeholder="e.g. Week of July 20 grocery run"
              className="input"
            />
          </label>
        </div>

        <form onSubmit={submitLine} className="no-print mb-5 grid grid-cols-4 gap-3 rounded-md border border-dashed border-[var(--color-line)] p-4">
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
          <label className="col-span-2 block">
            <span className="mb-1 block text-xs font-medium text-[var(--color-ink-soft)]">Packaging note (optional)</span>
            <input
              value={lineForm.packaging_note}
              onChange={(e) => setLineForm({ ...lineForm, packaging_note: e.target.value })}
              placeholder="e.g. 1 pack, 2 box, 1 case"
              className="input"
            />
          </label>
          <div className="flex items-end gap-2">
            <button
              type="submit"
              disabled={saving}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-[var(--color-ink)] py-2 text-sm font-medium text-white disabled:opacity-60"
            >
              {editingLineId ? <Pencil size={15} /> : <Plus size={15} />}
              {saving ? 'Saving…' : editingLineId ? 'Update' : 'Add'}
            </button>
            {editingLineId && (
              <button
                type="button"
                onClick={cancelEditLine}
                aria-label="Cancel edit"
                className="rounded-md border border-[var(--color-line)] px-3 py-2 hover:bg-[var(--color-paper)]"
              >
                <X size={15} />
              </button>
            )}
          </div>
        </form>

        <div id="printable-report">
          <div className="mb-3">
            <div className="font-display text-lg font-semibold">{selected.label || selected.list_number}</div>
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
                {lines.length === 0 && (
                  <tr><td colSpan={8} className="px-4 py-10 text-center text-[var(--color-ink-soft)]">No lines yet — search a product above to start building the list.</td></tr>
                )}
                {lines.map((l) => (
                  <tr key={l.id} className={`border-b border-[var(--color-line)] last:border-0 ${editingLineId === l.id ? 'bg-[var(--color-amber-soft)]' : ''}`}>
                    <td className="font-mono px-4 py-3 text-xs text-[var(--color-ink-soft)]">{l.product?.barcode}</td>
                    <td className="px-4 py-3 font-medium">{l.product?.name}</td>
                    <td className="px-4 py-3">{Number(l.unit_cost).toFixed(2)}</td>
                    <td className="px-4 py-3">{l.quantity} {l.product?.unit}</td>
                    <td className="px-4 py-3 text-[var(--color-ink-soft)]">{l.packaging_note || '—'}</td>
                    <td className="px-4 py-3">{costPerPiece(l).toFixed(2)}</td>
                    <td className="px-4 py-3 font-medium">{costForecast(l).toFixed(2)}</td>
                    <td className="px-4 py-3 no-print">
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

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold">Purchase List</h1>
          <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
            Manual planning lists for cost analysis — saved for real, so they build up as history over time. Nothing
            here touches Inventory; use Purchases to record an actual delivery.
          </p>
        </div>
        <button
          onClick={openNew}
          className="flex items-center gap-1.5 rounded-md bg-[var(--color-ink)] px-3.5 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          <Plus size={16} />
          New list
        </button>
      </div>

      {errorMsg && (
        <div className="mb-4 rounded-md bg-[var(--color-rust-soft)] px-3.5 py-2.5 text-sm text-[var(--color-rust)]">
          {errorMsg}
        </div>
      )}

      <div className="mb-4 flex items-center justify-between">
        <SearchBar value={search} onChange={setSearch} placeholder="Search by list # or label" />
      </div>
      <button
        onClick={() => setShowArchived(!showArchived)}
        className="mb-4 -mt-2 flex items-center gap-1.5 text-xs font-medium text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
      >
        <Archive size={13} />
        {showArchived ? 'Hide archived' : 'Show archived'}
      </button>

      <div className="overflow-hidden rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)]">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[var(--color-line)] text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
            <tr>
              <th className="px-4 py-3">List #</th>
              <th className="px-4 py-3">Label</th>
              <th className="px-4 py-3">Last updated</th>
              <th className="px-4 py-3">Items</th>
              <th className="px-4 py-3">Total</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-[var(--color-ink-soft)]">Loading…</td></tr>
            )}
            {!loading && searchedLists.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-10 text-center text-[var(--color-ink-soft)]">
                {showArchived ? 'Nothing archived.' : lists.length === 0 ? 'No purchase lists yet — create one to start planning.' : 'No lists match that search.'}
              </td></tr>
            )}
            {searchedLists.map((list) => (
              <tr
                key={list.id}
                onClick={() => !showArchived && openExisting(list)}
                className={`border-b border-[var(--color-line)] last:border-0 ${showArchived ? '' : 'cursor-pointer hover:bg-[var(--color-paper)]'}`}
              >
                <td className="font-mono px-4 py-3 text-xs text-[var(--color-ink-soft)]">{list.list_number}</td>
                <td className="px-4 py-3 font-medium">{list.label || '—'}</td>
                <td className="px-4 py-3 text-[var(--color-ink-soft)]">{new Date(list.updated_at).toLocaleString()}</td>
                <td className="px-4 py-3">{listItemCount(list)}</td>
                <td className="px-4 py-3">{listTotal(list).toFixed(2)}</td>
                <td className="px-4 py-3">
                  {showArchived ? (
                    <div className="flex gap-1">
                      <button
                        onClick={(e) => restoreList(list, e)}
                        aria-label="Restore list"
                        className="rounded-md p-1 text-[var(--color-ink-soft)] hover:bg-[var(--color-line)]"
                        title="Restore"
                      >
                        <RotateCcw size={14} />
                      </button>
                      <button
                        onClick={(e) => permanentlyDeleteList(list, e)}
                        aria-label="Permanently delete"
                        className="rounded-md p-1 text-[var(--color-rust)] hover:bg-[var(--color-rust-soft)]"
                        title="Permanently delete"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={(e) => archiveList(list, e)}
                      aria-label="Archive list"
                      className="rounded-md p-1 text-[var(--color-ink-soft)] hover:bg-[var(--color-line)]"
                      title="Archive"
                    >
                      <Archive size={14} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
