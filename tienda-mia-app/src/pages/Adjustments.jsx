import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Upload, FileDown, Trash2, Check } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { fetchAllRows } from '../lib/fetchAllRows'
import SlidePanel from '../components/SlidePanel'
import StatusChip from '../components/StatusChip'
import SortableTh from '../components/SortableTh'
import ProductPicker from '../components/ProductPicker'
import SearchBar from '../components/SearchBar'
import { useSort, sortRows } from '../lib/sort'
import { normalizeSearchText } from '../lib/search'
import { parseCsv, normalizeHeader, downloadFile } from '../lib/csv'

export default function Adjustments() {
  const [tab, setTab] = useState('adjustments') // 'adjustments' | 'physicalCount' | 'negativeStock'
  const [adjustments, setAdjustments] = useState([])
  const [inventoryCacheMap, setInventoryCacheMap] = useState({})

  const { sortKey: adjSortKey, sortDir: adjSortDir, toggleSort: toggleAdjSort } = useSort('adjustment_date', 'desc')
  function adjSortAccessor(row, key) {
    if (key === 'product') return row.product?.name
    if (key === 'category') return row.product?.category
    if (key === 'batch') return row.batch?.batch_number ?? ''
    if (key === 'change') return Number(row.adjustment_quantity ?? 0)
    return row[key]
  }
  const sortedAdjustments = sortRows(adjustments, adjSortKey, adjSortDir, adjSortAccessor)

  const [search, setSearch] = useState('')
  const searchedAdjustments = search.trim()
    ? sortedAdjustments.filter((a) => {
        const q = normalizeSearchText(search)
        return (
          normalizeSearchText(a.adjustment_number).includes(q) ||
          normalizeSearchText(a.product?.name).includes(q) ||
          normalizeSearchText(a.reason).includes(q)
        )
      })
    : sortedAdjustments
  const [products, setProducts] = useState([])
  const [extraBarcodeMap, setExtraBarcodeMap] = useState({}) // normalizedBarcode -> product_id, for additional barcodes beyond the primary one
  const [adjustmentTypes, setAdjustmentTypes] = useState([])
  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState('')

  const [panelOpen, setPanelOpen] = useState(false)
  const [productId, setProductId] = useState('')
  const [level, setLevel] = useState('product') // 'product' | 'batch'
  const [batches, setBatches] = useState([])
  const [batchId, setBatchId] = useState('')
  const [expiryDraft, setExpiryDraft] = useState('')
  const [originalExpiry, setOriginalExpiry] = useState('')
  const [oldValue, setOldValue] = useState(null)
  const [newValue, setNewValue] = useState('')
  const [adjustmentType, setAdjustmentType] = useState('')
  const [reason, setReason] = useState('')
  const [referenceNumber, setReferenceNumber] = useState('')
  const [remarks, setRemarks] = useState('')
  const [saving, setSaving] = useState(false)

  // ---------- Physical Count ----------
  const [physicalCounts, setPhysicalCounts] = useState([])
  const [selectedCount, setSelectedCount] = useState(null) // the open physical_counts row, or null = list view
  const [countLines, setCountLines] = useState([]) // persisted lines for the selected count, joined to products
  const [labelDraft, setLabelDraft] = useState('')
  const [countForm, setCountForm] = useState({ product_id: '', counted_qty: '', expiration_date: '' })
  const [countReason, setCountReason] = useState('')
  const [showOnlyMismatches, setShowOnlyMismatches] = useState(true)
  const [countPosting, setCountPosting] = useState(false)
  const [countError, setCountError] = useState('')
  const [countImportSkipped, setCountImportSkipped] = useState([])
  const [countSearch, setCountSearch] = useState('')
  const countFileInputRef = useRef(null)

  // ---------- Negative Stock ----------
  const [negativeStockRows, setNegativeStockRows] = useState([]) // [{ product, current_stock, first_negative_date }]
  const [negativeStockLoading, setNegativeStockLoading] = useState(true)
  const [negativeStockError, setNegativeStockError] = useState('')
  const [negDateFrom, setNegDateFrom] = useState('')
  const [negDateTo, setNegDateTo] = useState('')
  const [fixingProductId, setFixingProductId] = useState(null)
  const [fixNewValue, setFixNewValue] = useState('')
  const [fixReason, setFixReason] = useState('')

  async function loadNegativeStock() {
    setNegativeStockLoading(true)
    setNegativeStockError('')
    const { data, error } = await supabase.rpc('get_first_negative_date')
    if (error) {
      setNegativeStockError(error.message)
      setNegativeStockLoading(false)
      return
    }
    const productIds = (data ?? []).map((r) => r.product_id)
    if (productIds.length === 0) {
      setNegativeStockRows([])
      setNegativeStockLoading(false)
      return
    }
    const { data: productsData, error: prodErr } = await supabase
      .from('products')
      .select('id, name, sku, barcode, unit, category, current_cost')
      .in('id', productIds)
    if (prodErr) {
      setNegativeStockError(prodErr.message)
      setNegativeStockLoading(false)
      return
    }
    const productsById = Object.fromEntries((productsData ?? []).map((p) => [p.id, p]))
    const rows = (data ?? [])
      .map((r) => ({
        product: productsById[r.product_id],
        current_stock: Number(r.current_stock),
        first_negative_date: r.first_negative_date,
      }))
      .filter((r) => r.product)
      .sort((a, b) => a.current_stock - b.current_stock)
    setNegativeStockRows(rows)
    setNegativeStockLoading(false)
  }

  function startFix(row) {
    setFixingProductId(row.product.id)
    setFixNewValue('')
    setFixReason('')
  }

  function cancelFix() {
    setFixingProductId(null)
    setFixNewValue('')
    setFixReason('')
  }

  async function saveFix(row) {
    if (fixNewValue === '' || !fixReason.trim()) {
      setNegativeStockError('Enter both a corrected quantity and a reason before saving.')
      return
    }
    const { error } = await supabase.from('adjustments').insert({
      product_id: row.product.id,
      batch_id: null,
      adjustment_type: 'Count Correction',
      reason: fixReason.trim(),
      old_value: row.current_stock,
      new_value: Number(fixNewValue),
    })
    if (error) {
      setNegativeStockError(error.message)
      return
    }
    setFixingProductId(null)
    setFixNewValue('')
    setFixReason('')
    setNegativeStockError('')
    loadNegativeStock()
    loadAdjustments()
  }

  const filteredNegativeStockRows = negativeStockRows.filter(
    (r) =>
      (!negDateFrom || r.first_negative_date >= negDateFrom) &&
      (!negDateTo || r.first_negative_date <= negDateTo)
  )

  async function loadPhysicalCounts() {
    const { data, error } = await fetchAllRows('physical_counts', '*, physical_count_lines(id, posted)', 'updated_at', { ascending: false })
    if (!error) setPhysicalCounts(data ?? [])
  }

  async function loadCountLines(countId) {
    const { data, error } = await supabase
      .from('physical_count_lines')
      .select('*, product:products(name, sku, barcode, unit, category, current_cost)')
      .eq('physical_count_id', countId)
      .order('created_at')
    if (!error) setCountLines(data ?? [])
  }

  async function openNewCount() {
    setCountError('')
    const { data, error } = await supabase.from('physical_counts').insert({}).select().single()
    if (error) {
      setCountError(error.message)
      return
    }
    setSelectedCount(data)
    setLabelDraft('')
    setCountLines([])
    setCountReason('')
    loadInventoryAsOf(data.count_date)
    loadPhysicalCounts()
  }

  async function openExistingCount(count) {
    setSelectedCount(count)
    setLabelDraft(count.label ?? '')
    setCountReason('')
    setCountError('')
    await loadCountLines(count.id)
    loadInventoryAsOf(count.count_date)
  }

  async function saveCountLabel() {
    if (!selectedCount) return
    await supabase.from('physical_counts').update({ label: labelDraft.trim() || null }).eq('id', selectedCount.id)
    loadPhysicalCounts()
  }

  async function saveCountDate(newDate) {
    if (!selectedCount) return
    await supabase.from('physical_counts').update({ count_date: newDate }).eq('id', selectedCount.id)
    setSelectedCount({ ...selectedCount, count_date: newDate })
    loadInventoryAsOf(newDate)
    loadPhysicalCounts()
  }

  async function markCountCompleted() {
    if (!selectedCount) return
    await supabase.from('physical_counts').update({ status: 'completed' }).eq('id', selectedCount.id)
    setSelectedCount({ ...selectedCount, status: 'completed' })
    loadPhysicalCounts()
  }

  async function touchCountUpdatedAt() {
    if (!selectedCount) return
    await supabase.from('physical_counts').update({ updated_at: new Date().toISOString() }).eq('id', selectedCount.id)
  }

  async function deleteCount(count, e) {
    e.stopPropagation()
    if (!confirm(`Delete ${count.count_number}${count.label ? ` (${count.label})` : ''}? This can't be undone.`)) return
    await supabase.from('physical_counts').delete().eq('id', count.id)
    if (selectedCount?.id === count.id) setSelectedCount(null)
    loadPhysicalCounts()
  }

  async function loadInventoryAsOf(cutoffDate) {
    const { data, error } = await supabase.rpc('get_inventory_as_of', { cutoff_date: cutoffDate })
    if (error) {
      setCountError('Could not load stock as of that date — System Qty may be inaccurate until this is fixed.')
      return
    }
    const map = {}
    for (const row of data ?? []) map[row.product_id] = Number(row.stock)
    setInventoryCacheMap(map)
  }

  async function loadAdjustments() {
    setLoading(true)
    setErrorMsg('')
    const { data, error } = await supabase
      .from('adjustments')
      .select('*, product:products(name, sku, unit, category), batch:batches(batch_number)')
      .order('created_at', { ascending: false })
    if (error) {
      setErrorMsg('Could not reach Supabase. Check your .env values and that migrations have run.')
    } else {
      setAdjustments(data ?? [])
    }
    setLoading(false)
  }

  async function loadProducts() {
    const { data } = await fetchAllRows('products', 'id, sku, name, unit, barcode, status, current_cost, category', 'name')
    setProducts((data ?? []).filter((p) => p.status === 'active'))
  }

  async function loadExtraBarcodes() {
    const { data } = await supabase.from('product_barcodes').select('product_id, barcode')
    const map = {}
    for (const row of data ?? []) map[normalizeSearchText(row.barcode)] = row.product_id
    setExtraBarcodeMap(map)
  }

  async function loadAdjustmentTypes() {
    const { data } = await supabase
      .from('lists')
      .select('value')
      .eq('list_type', 'AdjustmentType')
      .eq('active', true)
      .order('value')
    setAdjustmentTypes((data ?? []).map((r) => r.value))
  }

  useEffect(() => {
    loadAdjustments()
    loadProducts()
    loadExtraBarcodes()
    loadAdjustmentTypes()
    loadPhysicalCounts()
    loadNegativeStock()
  }, [])

  function resetForm() {
    setProductId('')
    setLevel('product')
    setBatches([])
    setBatchId('')
    setOldValue(null)
    setNewValue('')
    setAdjustmentType(adjustmentTypes[0] ?? '')
    setReason('')
    setReferenceNumber('')
    setRemarks('')
    setErrorMsg('')
  }

  function openNew() {
    resetForm()
    setPanelOpen(true)
  }

  async function onProductPick(id) {
    setProductId(id)
    setLevel('product')
    setBatchId('')
    setExpiryDraft('')
    setOriginalExpiry('')
    setNewValue('')

    const { data: cache } = await supabase
      .from('inventory_cache')
      .select('current_stock')
      .eq('product_id', id)
      .maybeSingle()
    setOldValue(cache ? Number(cache.current_stock) : 0)

    const { data: batchRows } = await supabase
      .from('batch_cache')
      .select('*')
      .eq('product_id', id)
      .order('fifo_sequence')
    setBatches(batchRows ?? [])
  }

  function onLevelChange(newLevel) {
    setLevel(newLevel)
    setNewValue('')
    setExpiryDraft('')
    setOriginalExpiry('')
    if (newLevel === 'product') {
      setBatchId('')
      const found = products.find((p) => p.id === productId)
      if (found) onProductPick(productId) // refetch product-level old value
    }
  }

  function onBatchPick(id) {
    setBatchId(id)
    const b = batches.find((x) => x.batch_id === id)
    setOldValue(b ? Number(b.remaining_quantity) : 0)
    setNewValue('')
    setExpiryDraft(b?.expiration_date ?? '')
    setOriginalExpiry(b?.expiration_date ?? '')
  }

  const adjustmentQty = useMemo(() => {
    if (oldValue === null || newValue === '') return null
    return Number(newValue) - oldValue
  }, [oldValue, newValue])

  async function handleSave(e) {
    e.preventDefault()
    if (!productId || newValue === '' || !adjustmentType || !reason.trim()) return
    if (level === 'batch' && !batchId) {
      setErrorMsg('Pick which batch this adjustment applies to, or switch to "Overall product stock".')
      return
    }
    setSaving(true)
    setErrorMsg('')

    const { error } = await supabase.from('adjustments').insert({
      product_id: productId,
      batch_id: level === 'batch' ? batchId : null,
      adjustment_type: adjustmentType,
      reason: reason.trim(),
      reference_number: referenceNumber.trim() || null,
      old_value: oldValue,
      new_value: Number(newValue),
      remarks: remarks.trim() || null,
    })

    if (!error && level === 'batch' && batchId && expiryDraft !== originalExpiry) {
      const newDate = expiryDraft || null
      // batch_cache is a snapshot that only refreshes when a ledger row is
      // written — updating it directly here too, same fix as Inventory's
      // "Edit date," or the screen would keep showing the old date.
      await supabase.from('batches').update({ expiration_date: newDate }).eq('id', batchId)
      await supabase.from('batch_cache').update({ expiration_date: newDate }).eq('batch_id', batchId)
    }

    setSaving(false)
    if (error) {
      setErrorMsg(error.message)
      return
    }
    setPanelOpen(false)
    loadAdjustments()
  }

  const selectedProduct = products.find((p) => p.id === productId)

  // ---------- Physical Count ----------
  async function addCountRow(e) {
    e.preventDefault()
    if (!selectedCount || !countForm.product_id || countForm.counted_qty === '') return
    const p = products.find((x) => x.id === countForm.product_id)
    if (countLines.some((r) => r.product_id === p.id)) {
      setCountError(`${p.name} is already in this list.`)
      return
    }
    const { error } = await supabase.from('physical_count_lines').insert({
      physical_count_id: selectedCount.id,
      product_id: p.id,
      counted_qty: Number(countForm.counted_qty),
      expiration_date: countForm.expiration_date || null,
    })
    if (error) {
      setCountError(error.message)
      return
    }
    setCountForm({ product_id: '', counted_qty: '', expiration_date: '' })
    setCountError('')
    await loadCountLines(selectedCount.id)
    touchCountUpdatedAt()
    loadPhysicalCounts()
  }

  async function removeCountRow(lineId) {
    await supabase.from('physical_count_lines').delete().eq('id', lineId)
    await loadCountLines(selectedCount.id)
    touchCountUpdatedAt()
    loadPhysicalCounts()
  }

  function handleDownloadCountTemplate() {
    const headers = ['Barcode', 'Counted Qty', 'Expiration Date']
    const example1 = ['4800123456789', '48', '2026-12-31']
    const example2 = ['4800987654321', '0', '']
    const csv = [headers, example1, example2]
      .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    downloadFile('physical-count-template.csv', csv, 'text/csv;charset=utf-8;')
  }

  function handleCountImportClick() {
    countFileInputRef.current?.click()
  }

  function handleCountImportFileChange(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !selectedCount) return

    const reader = new FileReader()
    reader.onload = async () => {
      try {
        const rows = parseCsv(String(reader.result))
        if (rows.length < 2) {
          setCountError('That file has no data rows.')
          return
        }
        const headerRow = rows[0].map((h) => h.trim())
        const aliases = {
          barcode: 'barcode', sku: 'sku',
          countedqty: 'counted_qty', counted: 'counted_qty', qty: 'counted_qty', quantity: 'counted_qty', actualcount: 'counted_qty',
          expirationdate: 'expiration_date', expiry: 'expiration_date', expdate: 'expiration_date',
        }
        const canonicalKeys = headerRow.map((h) => aliases[normalizeHeader(h)] ?? null)

        const existingIds = new Set(countLines.map((r) => r.product_id))
        const newLines = []
        const skipped = []

        rows.slice(1).forEach((r, idx) => {
          const rowNum = idx + 2
          if (r.length !== headerRow.length) {
            skipped.push({ rowNum, reason: `Row has ${r.length} columns, expected ${headerRow.length} — likely a stray quote or comma` })
            return
          }
          const obj = {}
          canonicalKeys.forEach((key, i) => {
            if (key) obj[key] = (r[i] ?? '').trim()
          })

          const product = obj.barcode
            ? products.find((p) => normalizeSearchText(p.barcode) === normalizeSearchText(obj.barcode)) ||
              products.find((p) => p.id === extraBarcodeMap[normalizeSearchText(obj.barcode)])
            : obj.sku
              ? products.find((p) => normalizeSearchText(p.sku) === normalizeSearchText(obj.sku))
              : null

          if (!product) {
            skipped.push({ rowNum, reason: obj.barcode || obj.sku ? `No product matches "${obj.barcode || obj.sku}"` : 'Missing barcode/SKU' })
            return
          }
          if (existingIds.has(product.id)) {
            skipped.push({ rowNum, reason: `${product.name} is already in this list` })
            return
          }
          if (obj.counted_qty === '' || isNaN(Number(obj.counted_qty))) {
            skipped.push({ rowNum, reason: 'Missing or invalid counted quantity' })
            return
          }

          existingIds.add(product.id)
          newLines.push({
            physical_count_id: selectedCount.id,
            product_id: product.id,
            counted_qty: Number(obj.counted_qty),
            expiration_date: obj.expiration_date || null,
          })
        })

        if (newLines.length > 0) {
          const { error } = await supabase.from('physical_count_lines').insert(newLines)
          if (error) {
            setCountError(error.message)
            return
          }
        }

        setCountImportSkipped(skipped)
        setCountError('')
        await loadCountLines(selectedCount.id)
        touchCountUpdatedAt()
        loadPhysicalCounts()
      } catch {
        setCountError('Could not read that file — make sure it is a CSV, not an .xlsx.')
      }
    }
    reader.readAsText(file)
  }

  // One rule, one place: a positive count with an expiration date is
  // genuinely new stock — most commonly kickstarting inventory after a wipe
  // — so it gets a real batch with that shelf life, not just a number
  // correction. Everything else (no date, or a decrease) stays a plain
  // product-level adjustment, same as before.
  async function postCountVariance(line) {
    const systemQty = inventoryCacheMap[line.product_id] ?? 0
    const variance = line.counted_qty - systemQty

    if (line.expiration_date && variance > 0) {
      const product = products.find((p) => p.id === line.product_id)
      const { data: newBatch, error: batchErr } = await supabase
        .from('batches')
        .insert({
          product_id: line.product_id,
          source_type: 'BeginningInventory',
          received_quantity: variance,
          unit_cost: Number(product?.current_cost ?? 0),
          expiration_date: line.expiration_date,
          received_date: selectedCount.count_date,
        })
        .select()
        .single()
      if (batchErr) return { error: batchErr }

      const { error } = await supabase.from('adjustments').insert({
        product_id: line.product_id,
        batch_id: newBatch.id,
        adjustment_type: 'Count Correction',
        reason: countReason.trim(),
        old_value: 0,
        new_value: variance,
      })
      return { error }
    }

    const { error } = await supabase.from('adjustments').insert({
      product_id: line.product_id,
      batch_id: null,
      adjustment_type: 'Count Correction',
      reason: countReason.trim(),
      old_value: systemQty,
      new_value: line.counted_qty,
    })
    return { error }
  }

  async function postCountLine(line) {
    if (!countReason.trim()) {
      setCountError('Add a reason before posting — it applies to every adjustment this creates.')
      return
    }
    const { error } = await postCountVariance(line)
    if (error) {
      setCountError(`${line.product?.name}: ${error.message}`)
      return
    }
    await supabase.from('physical_count_lines').update({ posted: true }).eq('id', line.id)
    await loadCountLines(selectedCount.id)
    loadInventoryAsOf(selectedCount.count_date)
  }

  async function postAllCountVariances() {
    if (!countReason.trim()) {
      setCountError('Add a reason before posting — it applies to every adjustment this creates.')
      return
    }
    setCountPosting(true)
    setCountError('')
    const toPost = countLines.filter((r) => !r.posted && r.counted_qty !== (inventoryCacheMap[r.product_id] ?? 0))
    const failed = []

    for (const line of toPost) {
      const { error } = await postCountVariance(line)
      if (error) {
        failed.push(line.product?.name)
      } else {
        await supabase.from('physical_count_lines').update({ posted: true }).eq('id', line.id)
      }
    }

    setCountPosting(false)
    if (failed.length > 0) setCountError(`Posted the rest, but failed for: ${failed.join(', ')}`)
    await loadCountLines(selectedCount.id)
    loadAdjustments()
    loadInventoryAsOf(selectedCount.count_date)
  }

  const { sortKey: countSortKey, sortDir: countSortDir, toggleSort: toggleCountSort } = useSort('added', 'desc')
  function countSortAccessor(row, key) {
    const systemQty = inventoryCacheMap[row.product_id] ?? 0
    if (key === 'added') return new Date(row.created_at).getTime()
    if (key === 'product') return row.product?.name
    if (key === 'category') return row.product?.category
    if (key === 'systemQty') return systemQty
    if (key === 'countedQty') return row.counted_qty
    if (key === 'expiration') return row.expiration_date ?? ''
    if (key === 'variance') return Math.abs(row.counted_qty - systemQty)
    if (key === 'valueImpact') return (row.counted_qty - systemQty) * Number(row.product?.current_cost ?? 0)
    return row[key]
  }
  const countSearchFiltered = countSearch.trim()
    ? countLines.filter((r) => normalizeSearchText(r.product?.name).includes(normalizeSearchText(countSearch)))
    : countLines
  const visibleCountRows = showOnlyMismatches
    ? countSearchFiltered.filter((r) => r.counted_qty !== (inventoryCacheMap[r.product_id] ?? 0))
    : countSearchFiltered
  const sortedCountRows = sortRows(visibleCountRows, countSortKey, countSortDir, countSortAccessor)
  const pendingVarianceCount = countLines.filter((r) => !r.posted && r.counted_qty !== (inventoryCacheMap[r.product_id] ?? 0)).length

  function exportCountCsv() {
    const headers = ['Added', 'Barcode', 'Product', 'Category', `System Qty (as of ${selectedCount.count_date})`, 'Counted Qty', 'Expiration', 'Variance', 'Value Impact', 'Status']
    const rows = sortedCountRows.map((row) => {
      const systemQty = inventoryCacheMap[row.product_id] ?? 0
      const variance = row.counted_qty - systemQty
      const valueImpact = variance * Number(row.product?.current_cost ?? 0)
      return [
        new Date(row.created_at).toLocaleString(),
        row.product?.barcode ?? '',
        row.product?.name ?? '',
        row.product?.category ?? '',
        systemQty,
        row.counted_qty,
        row.expiration_date ?? '',
        variance,
        valueImpact.toFixed(2),
        row.posted ? 'posted' : variance === 0 ? 'matches' : 'pending',
      ]
    })
    const csv = [headers, ...rows]
      .map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\n')
    downloadFile(`${selectedCount.count_number}-variance.csv`, csv, 'text/csv;charset=utf-8;')
  }

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold">Adjustments</h1>
          <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
            Corrects a miscount without touching history — every adjustment writes its own ledger entry, nothing gets edited or deleted.
          </p>
        </div>
        {tab === 'adjustments' && (
          <button
            onClick={openNew}
            className="flex items-center gap-1.5 rounded-md bg-[var(--color-ink)] px-3.5 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            <Plus size={16} />
            New adjustment
          </button>
        )}
      </div>

      <div className="mb-4 flex gap-1 border-b border-[var(--color-line)]">
        {[
          ['adjustments', 'Adjustments'],
          ['physicalCount', 'Physical Count'],
          ['negativeStock', 'Negative Stock'],
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

      {errorMsg && !panelOpen && tab === 'adjustments' && (
        <div className="mb-4 rounded-md bg-[var(--color-rust-soft)] px-3.5 py-2.5 text-sm text-[var(--color-rust)]">
          {errorMsg}
        </div>
      )}

      {tab === 'adjustments' && (
        <>
      <SearchBar value={search} onChange={setSearch} placeholder="Search by adjustment #, product, or reason" />

      <div className="overflow-hidden rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)]">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[var(--color-line)] text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
            <tr>
              <SortableTh label="Adjustment #" sortKey="adjustment_number" activeKey={adjSortKey} activeDir={adjSortDir} onSort={toggleAdjSort} />
              <SortableTh label="Date" sortKey="adjustment_date" activeKey={adjSortKey} activeDir={adjSortDir} onSort={toggleAdjSort} />
              <SortableTh label="Product" sortKey="product" activeKey={adjSortKey} activeDir={adjSortDir} onSort={toggleAdjSort} />
              <SortableTh label="Category" sortKey="category" activeKey={adjSortKey} activeDir={adjSortDir} onSort={toggleAdjSort} />
              <SortableTh label="Batch" sortKey="batch" activeKey={adjSortKey} activeDir={adjSortDir} onSort={toggleAdjSort} />
              <th className="px-4 py-3">Old → New</th>
              <SortableTh label="Change" sortKey="change" activeKey={adjSortKey} activeDir={adjSortDir} onSort={toggleAdjSort} />
              <SortableTh label="Type" sortKey="adjustment_type" activeKey={adjSortKey} activeDir={adjSortDir} onSort={toggleAdjSort} />
              <th className="px-4 py-3">Reason</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={9} className="px-4 py-8 text-center text-[var(--color-ink-soft)]">Loading adjustments…</td></tr>
            )}
            {!loading && searchedAdjustments.length === 0 && (
              <tr><td colSpan={9} className="px-4 py-10 text-center text-[var(--color-ink-soft)]">No adjustments yet — good sign, means nothing's needed correcting.</td></tr>
            )}
            {searchedAdjustments.map((a) => {
              const qty = Number(a.adjustment_quantity)
              return (
                <tr key={a.id} className="border-b border-[var(--color-line)] last:border-0">
                  <td className="font-mono px-4 py-3 text-xs text-[var(--color-ink-soft)]">{a.adjustment_number}</td>
                  <td className="px-4 py-3">{a.adjustment_date}</td>
                  <td className="px-4 py-3 font-medium">{a.product?.name}</td>
                  <td className="px-4 py-3 text-[var(--color-ink-soft)]">{a.product?.category || '—'}</td>
                  <td className="font-mono px-4 py-3 text-xs text-[var(--color-ink-soft)]">{a.batch?.batch_number ?? 'Overall'}</td>
                  <td className="px-4 py-3">{Number(a.old_value)} → {Number(a.new_value)}</td>
                  <td className="px-4 py-3">
                    <StatusChip tone={qty > 0 ? 'ok' : qty < 0 ? 'critical' : 'neutral'}>
                      {qty > 0 ? '+' : ''}{qty} {a.product?.unit}
                    </StatusChip>
                  </td>
                  <td className="px-4 py-3 text-[var(--color-ink-soft)]">{a.adjustment_type}</td>
                  <td className="px-4 py-3 text-[var(--color-ink-soft)]">{a.reason}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
        </>
      )}

      {tab === 'physicalCount' && !selectedCount && (
        <div>
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm text-[var(--color-ink-soft)]">
              Each count is saved as you go, so it's safe to leave and come back — a full store count can take days.
            </p>
            <button
              onClick={openNewCount}
              className="flex items-center gap-1.5 rounded-md bg-[var(--color-ink)] px-3.5 py-2 text-sm font-medium text-white hover:opacity-90"
            >
              <Plus size={16} />
              New count
            </button>
          </div>

          {countError && (
            <div className="mb-4 rounded-md bg-[var(--color-rust-soft)] px-3.5 py-2.5 text-sm text-[var(--color-rust)]">
              {countError}
            </div>
          )}

          <div className="overflow-hidden rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)]">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-[var(--color-line)] text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
                <tr>
                  <th className="px-4 py-3">Count #</th>
                  <th className="px-4 py-3">Label</th>
                  <th className="px-4 py-3">Count date</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Items</th>
                  <th className="px-4 py-3">Posted</th>
                  <th className="px-4 py-3">Last updated</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {physicalCounts.length === 0 && (
                  <tr><td colSpan={8} className="px-4 py-10 text-center text-[var(--color-ink-soft)]">No physical counts yet — start one when you're ready.</td></tr>
                )}
                {physicalCounts.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => openExistingCount(c)}
                    className="cursor-pointer border-b border-[var(--color-line)] last:border-0 hover:bg-[var(--color-paper)]"
                  >
                    <td className="font-mono px-4 py-3 text-xs text-[var(--color-ink-soft)]">{c.count_number}</td>
                    <td className="px-4 py-3 font-medium">{c.label || '—'}</td>
                    <td className="px-4 py-3">{c.count_date}</td>
                    <td className="px-4 py-3"><StatusChip tone={c.status === 'completed' ? 'ok' : 'attention'}>{c.status}</StatusChip></td>
                    <td className="px-4 py-3">{(c.physical_count_lines ?? []).length}</td>
                    <td className="px-4 py-3">{(c.physical_count_lines ?? []).filter((l) => l.posted).length}</td>
                    <td className="px-4 py-3 text-[var(--color-ink-soft)]">{new Date(c.updated_at).toLocaleString()}</td>
                    <td className="px-4 py-3">
                      <button
                        onClick={(e) => deleteCount(c, e)}
                        aria-label="Delete count"
                        className="rounded-md p-1 text-[var(--color-ink-soft)] hover:bg-[var(--color-line)]"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'physicalCount' && selectedCount && (
        <div>
          <button
            onClick={() => setSelectedCount(null)}
            className="mb-4 flex items-center gap-1.5 text-sm font-medium text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
          >
            ← Back to all counts
          </button>

          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="font-display text-lg font-semibold">{selectedCount.count_number}</h2>
              <StatusChip tone={selectedCount.status === 'completed' ? 'ok' : 'attention'}>{selectedCount.status}</StatusChip>
            </div>
            {selectedCount.status !== 'completed' && (
              <button
                onClick={markCountCompleted}
                className="rounded-md border border-[var(--color-ink)] px-3 py-1.5 text-sm font-medium"
              >
                Mark completed
              </button>
            )}
          </div>

          <div className="mb-4 flex gap-4">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-[var(--color-ink-soft)]">Label (optional)</span>
              <input
                value={labelDraft}
                onChange={(e) => setLabelDraft(e.target.value)}
                onBlur={saveCountLabel}
                placeholder="e.g. End of July 2026 count"
                className="input max-w-sm"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-[var(--color-ink-soft)]">Count date</span>
              <input
                type="date"
                value={selectedCount.count_date}
                onChange={(e) => saveCountDate(e.target.value)}
                className="input"
              />
            </label>
          </div>
          <p className="mb-4 text-xs text-[var(--color-ink-soft)]">
            System Qty below reflects stock exactly as it stood on the count date above — not today's live numbers.
            Change this if the count represents an earlier date than when you're actually entering it.
          </p>

          {countError && (
            <div className="mb-4 rounded-md bg-[var(--color-rust-soft)] px-3.5 py-2.5 text-sm text-[var(--color-rust)]">
              {countError}
            </div>
          )}

          <div className="mb-5 rounded-md border border-dashed border-[var(--color-line)] p-4">
            <form onSubmit={addCountRow} className="mb-3 grid grid-cols-5 gap-3">
              <div className="col-span-2">
                <span className="mb-1 block text-xs font-medium text-[var(--color-ink-soft)]">Product</span>
                <ProductPicker products={products} value={countForm.product_id} onChange={(id) => setCountForm({ ...countForm, product_id: id })} />
              </div>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-[var(--color-ink-soft)]">Counted qty</span>
                <input
                  type="number" step="0.001" min="0" required
                  value={countForm.counted_qty}
                  onChange={(e) => setCountForm({ ...countForm, counted_qty: e.target.value })}
                  className="input"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-[var(--color-ink-soft)]">Expiration date (optional)</span>
                <input
                  type="date"
                  value={countForm.expiration_date}
                  onChange={(e) => setCountForm({ ...countForm, expiration_date: e.target.value })}
                  className="input"
                />
              </label>
              <button type="submit" className="flex items-end justify-center gap-1.5 rounded-md bg-[var(--color-ink)] py-2 text-sm font-medium text-white">
                <Plus size={15} />
                Add
              </button>
            </form>

            <div className="flex gap-2">
              <button
                onClick={handleDownloadCountTemplate}
                className="flex items-center gap-1.5 rounded-md border border-[var(--color-line)] px-3.5 py-2 text-sm font-medium hover:bg-[var(--color-paper)]"
              >
                <FileDown size={16} />
                Template
              </button>
              <button
                onClick={handleCountImportClick}
                className="flex items-center gap-1.5 rounded-md border border-[var(--color-line)] px-3.5 py-2 text-sm font-medium hover:bg-[var(--color-paper)]"
              >
                <Upload size={16} />
                Import CSV
              </button>
              <input ref={countFileInputRef} type="file" accept=".csv" onChange={handleCountImportFileChange} className="hidden" />
            </div>
          </div>

          {countImportSkipped.length > 0 && (
            <div className="mb-4">
              <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">
                {countImportSkipped.length} row{countImportSkipped.length === 1 ? '' : 's'} skipped from last import
              </div>
              <div className="max-h-32 space-y-1 overflow-y-auto">
                {countImportSkipped.map((s, i) => (
                  <div key={i} className="rounded-md bg-[var(--color-rust-soft)] px-2.5 py-1.5 text-xs text-[var(--color-rust)]">
                    Row {s.rowNum}: {s.reason}
                  </div>
                ))}
              </div>
            </div>
          )}

          {countLines.length > 0 && (
            <>
              <SearchBar value={countSearch} onChange={setCountSearch} placeholder="Search this count by product name" />

              <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                <label className="flex-1 block">
                  <span className="mb-1 block text-xs font-medium text-[var(--color-ink-soft)]">
                    Reason (applies to every adjustment posted below)
                  </span>
                  <input
                    value={countReason}
                    onChange={(e) => setCountReason(e.target.value)}
                    placeholder="e.g. End of July 2026 physical count"
                    className="input"
                  />
                </label>
                <label className="flex items-center gap-1.5 whitespace-nowrap pb-2 text-xs">
                  <input type="checkbox" checked={showOnlyMismatches} onChange={(e) => setShowOnlyMismatches(e.target.checked)} />
                  Show only mismatches
                </label>
                <button
                  onClick={exportCountCsv}
                  disabled={sortedCountRows.length === 0}
                  className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--color-line)] px-3.5 py-2 text-sm font-medium hover:bg-[var(--color-paper)] disabled:opacity-50"
                >
                  <FileDown size={16} />
                  Export CSV
                </button>
                <button
                  onClick={postAllCountVariances}
                  disabled={countPosting || pendingVarianceCount === 0}
                  className="whitespace-nowrap rounded-md bg-[var(--color-ink)] px-3.5 py-2 text-sm font-medium text-white disabled:opacity-60"
                >
                  {countPosting ? 'Posting…' : `Post all ${pendingVarianceCount} variance${pendingVarianceCount === 1 ? '' : 's'}`}
                </button>
              </div>

              <div className="overflow-hidden rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)]">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-[var(--color-line)] text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
                    <tr>
                      <SortableTh label="Added" sortKey="added" activeKey={countSortKey} activeDir={countSortDir} onSort={toggleCountSort} />
                      <SortableTh label="Product" sortKey="product" activeKey={countSortKey} activeDir={countSortDir} onSort={toggleCountSort} />
                      <SortableTh label="Category" sortKey="category" activeKey={countSortKey} activeDir={countSortDir} onSort={toggleCountSort} />
                      <SortableTh label={`System Qty (as of ${selectedCount.count_date})`} sortKey="systemQty" activeKey={countSortKey} activeDir={countSortDir} onSort={toggleCountSort} />
                      <SortableTh label="Counted Qty" sortKey="countedQty" activeKey={countSortKey} activeDir={countSortDir} onSort={toggleCountSort} />
                      <SortableTh label="Expiration" sortKey="expiration" activeKey={countSortKey} activeDir={countSortDir} onSort={toggleCountSort} />
                      <SortableTh label="Variance" sortKey="variance" activeKey={countSortKey} activeDir={countSortDir} onSort={toggleCountSort} />
                      <SortableTh label="Value Impact" sortKey="valueImpact" activeKey={countSortKey} activeDir={countSortDir} onSort={toggleCountSort} />
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedCountRows.length === 0 && (
                      <tr><td colSpan={9} className="px-4 py-10 text-center text-[var(--color-ink-soft)]">
                        {showOnlyMismatches ? 'No mismatches — everything counted matches the system.' : 'Nothing matches this search.'}
                      </td></tr>
                    )}
                    {sortedCountRows.map((row) => {
                      const systemQty = inventoryCacheMap[row.product_id] ?? 0
                      const variance = row.counted_qty - systemQty
                      const valueImpact = variance * Number(row.product?.current_cost ?? 0)
                      return (
                        <tr key={row.id} className="border-b border-[var(--color-line)] last:border-0">
                          <td className="px-4 py-3 text-[var(--color-ink-soft)]">{new Date(row.created_at).toLocaleString()}</td>
                          <td className="px-4 py-3 font-medium">{row.product?.name}</td>
                          <td className="px-4 py-3 text-[var(--color-ink-soft)]">{row.product?.category || '—'}</td>
                          <td className="px-4 py-3">{systemQty} {row.product?.unit}</td>
                          <td className="px-4 py-3">{row.counted_qty} {row.product?.unit}</td>
                          <td className="px-4 py-3 text-[var(--color-ink-soft)]">{row.expiration_date || '—'}</td>
                          <td className="px-4 py-3">
                            {variance === 0 ? (
                              <StatusChip tone="ok">matches</StatusChip>
                            ) : (
                              <StatusChip tone={variance < 0 ? 'critical' : 'attention'}>
                                {variance > 0 ? '+' : ''}{variance} {row.product?.unit}
                              </StatusChip>
                            )}
                          </td>
                          <td className="px-4 py-3">{valueImpact.toFixed(2)}</td>
                          <td className="px-4 py-3">
                            <div className="flex gap-1">
                              {row.posted ? (
                                <span className="flex items-center gap-1 text-xs text-[var(--color-herb)]"><Check size={13} /> posted</span>
                              ) : variance !== 0 ? (
                                <button
                                  onClick={() => postCountLine(row)}
                                  className="rounded-md border border-[var(--color-ink)] px-2 py-1 text-xs font-medium"
                                >
                                  Post
                                </button>
                              ) : null}
                              <button
                                onClick={() => removeCountRow(row.id)}
                                aria-label="Remove"
                                className="rounded-md p-1 text-[var(--color-ink-soft)] hover:bg-[var(--color-line)]"
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'negativeStock' && (
        <div>
          <p className="mb-4 text-sm text-[var(--color-ink-soft)]">
            Every product currently sitting below zero, with the exact date its running balance first crossed
            negative — computed from the full transaction history, not a guess. Fixing one here posts a single
            adjustment for the whole product, not one per sale line.
          </p>

          <div className="mb-4 flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="mb-1 block text-xs font-medium text-[var(--color-ink-soft)]">Went negative from</span>
              <input type="date" value={negDateFrom} onChange={(e) => setNegDateFrom(e.target.value)} className="input" />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs font-medium text-[var(--color-ink-soft)]">to</span>
              <input type="date" value={negDateTo} onChange={(e) => setNegDateTo(e.target.value)} className="input" />
            </label>
            {(negDateFrom || negDateTo) && (
              <button
                onClick={() => {
                  setNegDateFrom('')
                  setNegDateTo('')
                }}
                className="text-xs text-[var(--color-ink-soft)] underline underline-offset-2"
              >
                Clear dates
              </button>
            )}
          </div>

          {negativeStockError && (
            <div className="mb-4 rounded-md bg-[var(--color-rust-soft)] px-3.5 py-2.5 text-sm text-[var(--color-rust)]">
              {negativeStockError}
            </div>
          )}

          <div className="overflow-hidden rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)]">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-[var(--color-line)] text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
                <tr>
                  <th className="px-4 py-3">Product</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">Current stock</th>
                  <th className="px-4 py-3">Went negative on</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {negativeStockLoading && (
                  <tr><td colSpan={5} className="px-4 py-10 text-center text-[var(--color-ink-soft)]">Loading…</td></tr>
                )}
                {!negativeStockLoading && filteredNegativeStockRows.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-10 text-center text-[var(--color-ink-soft)]">
                    {negativeStockRows.length === 0 ? 'Nothing is negative right now.' : 'Nothing went negative in that date range.'}
                  </td></tr>
                )}
                {filteredNegativeStockRows.map((row) => (
                  <tr key={row.product.id} className="border-b border-[var(--color-line)] last:border-0">
                    <td className="px-4 py-3 font-medium">{row.product.name}</td>
                    <td className="px-4 py-3 text-[var(--color-ink-soft)]">{row.product.category || '—'}</td>
                    <td className="px-4 py-3">
                      <StatusChip tone="critical">{row.current_stock} {row.product.unit}</StatusChip>
                    </td>
                    <td className="px-4 py-3">{row.first_negative_date}</td>
                    <td className="px-4 py-3">
                      {fixingProductId === row.product.id ? (
                        <div className="flex items-end gap-2">
                          <label className="block">
                            <span className="mb-1 block text-[10px] font-medium text-[var(--color-ink-soft)]">Actual qty</span>
                            <input
                              type="number" step="0.001"
                              value={fixNewValue}
                              onChange={(e) => setFixNewValue(e.target.value)}
                              className="input w-24 py-1 text-xs"
                            />
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-[10px] font-medium text-[var(--color-ink-soft)]">Reason</span>
                            <input
                              value={fixReason}
                              onChange={(e) => setFixReason(e.target.value)}
                              placeholder="Why was this negative?"
                              className="input w-48 py-1 text-xs"
                            />
                          </label>
                          <button
                            onClick={() => saveFix(row)}
                            className="rounded-md bg-[var(--color-ink)] px-2 py-1 text-xs font-medium text-white"
                          >
                            Save
                          </button>
                          <button
                            onClick={cancelFix}
                            className="rounded-md border border-[var(--color-line)] px-2 py-1 text-xs font-medium"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => startFix(row)}
                          className="rounded-md border border-[var(--color-ink)] px-2.5 py-1.5 text-xs font-medium"
                        >
                          Fix
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <SlidePanel open={panelOpen} title="New adjustment" onClose={() => setPanelOpen(false)}>
        {errorMsg && (
          <div className="mb-4 rounded-md bg-[var(--color-rust-soft)] px-3.5 py-2.5 text-sm text-[var(--color-rust)]">
            {errorMsg}
          </div>
        )}
        <form onSubmit={handleSave} className="space-y-4">
          <Field label="Product" required>
            <ProductPicker products={products} value={productId} onChange={onProductPick} />
          </Field>

          {productId && (
            <>
              <Field label="Adjusting">
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => onLevelChange('product')}
                    className={`flex-1 rounded-md border py-2 text-sm ${level === 'product' ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-white' : 'border-[var(--color-line)]'}`}
                  >
                    Overall product stock
                  </button>
                  <button
                    type="button"
                    onClick={() => onLevelChange('batch')}
                    className={`flex-1 rounded-md border py-2 text-sm ${level === 'batch' ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-white' : 'border-[var(--color-line)]'}`}
                  >
                    Specific batch
                  </button>
                </div>
              </Field>

              {level === 'batch' && (
                <Field label="Batch" required>
                  <select required value={batchId} onChange={(e) => onBatchPick(e.target.value)} className="input">
                    <option value="">Select a batch…</option>
                    {batches.map((b) => (
                      <option key={b.batch_id} value={b.batch_id}>
                        {b.remaining_quantity} {selectedProduct?.unit} remaining (cost {Number(b.unit_cost).toFixed(2)})
                      </option>
                    ))}
                  </select>
                </Field>
              )}

              {level === 'batch' && batchId && (
                <Field label="Expiration date">
                  <input
                    type="date"
                    value={expiryDraft}
                    onChange={(e) => setExpiryDraft(e.target.value)}
                    className="input"
                  />
                  <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
                    Only changes if you edit it — saved together with the quantity correction below, in one action.
                  </p>
                </Field>
              )}

              <div className="grid grid-cols-2 gap-3">
                <Field label="Current (system) value">
                  <input value={oldValue ?? ''} disabled className="input opacity-70" />
                </Field>
                <Field label="Actual counted value" required>
                  <input
                    type="number" step="0.001" required
                    value={newValue}
                    onChange={(e) => setNewValue(e.target.value)}
                    className="input"
                  />
                </Field>
              </div>

              {adjustmentQty !== null && (
                <div className="rounded-md bg-[var(--color-paper)] px-3 py-2 text-sm">
                  This will record a change of{' '}
                  <span className={adjustmentQty < 0 ? 'font-medium text-[var(--color-rust)]' : 'font-medium text-[var(--color-herb)]'}>
                    {adjustmentQty > 0 ? '+' : ''}{adjustmentQty} {selectedProduct?.unit}
                  </span>
                </div>
              )}

              <Field label="Adjustment type" required>
                <select required value={adjustmentType} onChange={(e) => setAdjustmentType(e.target.value)} className="input">
                  <option value="">Select…</option>
                  {adjustmentTypes.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </Field>

              <Field label="Reason" required>
                <input required value={reason} onChange={(e) => setReason(e.target.value)} className="input" placeholder="e.g. Physical count found short" />
              </Field>

              <Field label="Reference number">
                <input value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} className="input" />
              </Field>

              <Field label="Remarks">
                <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={2} className="input resize-none" />
              </Field>

              <button
                type="submit"
                disabled={saving || newValue === ''}
                className="w-full rounded-md bg-[var(--color-ink)] py-2.5 text-sm font-medium text-white disabled:opacity-60"
              >
                {saving ? 'Saving…' : 'Record adjustment'}
              </button>
            </>
          )}
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
