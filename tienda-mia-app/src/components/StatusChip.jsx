/**
 * Three-state chip that mirrors the app's own stock-health vocabulary:
 * ok (herb) / attention (amber) / critical (rust) / neutral (line).
 * Reused everywhere a status appears so the color language stays consistent
 * across Dashboard, Products, Inventory, and Purchasing.
 */
const TONES = {
  ok: 'bg-[var(--color-herb-soft)] text-[var(--color-herb)]',
  attention: 'bg-[var(--color-amber-soft)] text-[var(--color-amber)]',
  critical: 'bg-[var(--color-rust-soft)] text-[var(--color-rust)]',
  neutral: 'bg-[var(--color-line)] text-[var(--color-ink-soft)]',
}

export default function StatusChip({ tone = 'neutral', children }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${TONES[tone] ?? TONES.neutral}`}
    >
      {children}
    </span>
  )
}
