import { useEffect, useMemo, useState } from 'react'
import { Plus, Search, Archive, RotateCcw, Pencil } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import SlidePanel from '../components/SlidePanel'
import StatusChip from '../components/StatusChip'

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

  async function loadProducts() {
    setLoading(true)
    setErrorMsg('')
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .order('created_at', { ascending: false })

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
      name: form.name.trim(),
      brand: form.brand.trim() || null,
      category: form.category || null,
      business_unit: form.business_unit || null,
      product_type: form.product_type || null,
      unit: form.unit || null,
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

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold">Products</h1>
          <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
            Master data only — stock levels live in Inventory once purchases start flowing in.
          </p>
        </div>
        <button
          onClick={openAddPanel}
          className="flex items-center gap-1.5 rounded-md bg-[var(--color-ink)] px-3.5 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          <Plus size={16} />
          Add product
        </button>
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
              <th className="px-4 py-3">SKU</th>
              <th className="px-4 py-3">Barcode</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Category</th>
              <th className="px-4 py-3">Unit</th>
              <th className="px-4 py-3">Price</th>
              <th className="px-4 py-3">Status</th>
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

            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-[var(--color-ink-soft)]">
                  {products.length === 0
                    ? 'No products yet — add your first one to start the master list.'
                    : 'No products match that search.'}
                </td>
              </tr>
            )}

            {filtered.map((p) => (
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
