import { X } from 'lucide-react'

/**
 * Right-side slide panel — the spec calls for this pattern for every
 * Add/Edit form instead of full-page navigation or modals.
 */
export default function SlidePanel({ open, title, onClose, children }) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        aria-label="Close panel"
        onClick={onClose}
        className="absolute inset-0 bg-[var(--color-ink)]/40"
      />
      <div className="relative flex h-full w-full max-w-md flex-col bg-[var(--color-paper-raised)] shadow-xl">
        <div className="flex items-center justify-between border-b border-[var(--color-line)] px-6 py-4">
          <h2 className="font-display text-lg font-semibold">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-[var(--color-ink-soft)] hover:bg-[var(--color-line)]"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
      </div>
    </div>
  )
}
