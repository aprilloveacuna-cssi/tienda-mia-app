import { useEffect, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'

/**
 * Confirms and records disposal of an expired/expiring batch — writes to
 * `waste` plus its matching ledger entry, same as the manual Returns & Waste
 * flow, just reachable directly from wherever the expiring batch is shown.
 */
export default function DisposeConfirm({ open, batch, onClose, onDisposed }) {
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState('Expired')
  const [disposedBy, setDisposedBy] = useState('')
  const [remarks, setRemarks] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (open && batch) {
      setQuantity(String(batch.remaining_quantity))
      setReason('Expired')
      setDisposedBy('')
      setRemarks('')
      setError('')
    }
  }, [open, batch])

  if (!open || !batch) return null

  async function handleConfirm() {
    const qty = Number(quantity)
    if (!qty || qty <= 0 || qty > Number(batch.remaining_quantity)) {
      setError(`Enter a quantity between 1 and ${batch.remaining_quantity}.`)
      return
    }
    setSaving(true)
    setError('')

    const { data: w, error: wErr } = await supabase
      .from('waste')
      .insert({
        product_id: batch.product_id,
        batch_id: batch.batch_id,
        quantity: qty,
        reason,
        disposed_by: disposedBy.trim() || null,
        remarks: remarks.trim() || null,
      })
      .select()
      .single()

    if (wErr) {
      setError(wErr.message)
      setSaving(false)
      return
    }

    const { error: ledgerErr } = await supabase.from('inventory_ledger').insert({
      product_id: batch.product_id,
      batch_id: batch.batch_id,
      transaction_type: 'Waste',
      quantity_change: -qty,
      unit_cost_at_transaction: Number(batch.unit_cost ?? 0),
      source_module: 'Waste',
      source_reference_id: w.id,
    })

    setSaving(false)
    if (ledgerErr) {
      setError(`Recorded but inventory wasn't fully updated: ${ledgerErr.message}`)
      return
    }

    onDisposed?.()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button aria-label="Close" onClick={onClose} className="absolute inset-0 bg-[var(--color-ink)]/40" />
      <div className="relative w-full max-w-sm rounded-md bg-[var(--color-paper-raised)] p-5 shadow-xl">
        <div className="mb-3 flex items-start justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle size={18} className="text-[var(--color-rust)]" />
            <h2 className="font-display text-base font-semibold">Confirm disposal</h2>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-[var(--color-ink-soft)]">
            <X size={16} />
          </button>
        </div>

        <p className="mb-3 text-sm text-[var(--color-ink-soft)]">
          {batch.product_name}
          {batch.batch_number && <> — batch {batch.batch_number}</>}, {batch.remaining_quantity} {batch.unit} remaining
          {batch.expiration_date && <> · expires {batch.expiration_date}</>}
        </p>

        {error && (
          <div className="mb-3 rounded-md bg-[var(--color-rust-soft)] px-2.5 py-1.5 text-xs text-[var(--color-rust)]">
            {error}
          </div>
        )}

        <label className="mb-3 block text-xs font-medium text-[var(--color-ink-soft)]">
          Quantity to dispose
          <input
            type="number" step="0.001" min="0" max={batch.remaining_quantity}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className="input mt-1"
          />
        </label>
        <label className="mb-3 block text-xs font-medium text-[var(--color-ink-soft)]">
          Disposed by
          <input value={disposedBy} onChange={(e) => setDisposedBy(e.target.value)} className="input mt-1" />
        </label>
        <label className="mb-4 block text-xs font-medium text-[var(--color-ink-soft)]">
          Remarks
          <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={2} className="input mt-1 resize-none" />
        </label>

        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 rounded-md border border-[var(--color-line)] py-2 text-sm font-medium"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={saving}
            className="flex-1 rounded-md bg-[var(--color-rust)] py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {saving ? 'Disposing…' : 'Confirm disposal'}
          </button>
        </div>
      </div>
    </div>
  )
}
