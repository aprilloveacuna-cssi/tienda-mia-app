import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'

/**
 * Search-as-you-type product picker — swaps in for a plain <select> once a
 * catalog is too long to scroll through. Matches on name, SKU, or barcode.
 */
export default function ProductPicker({ products, value, onChange, placeholder = 'Search by name, SKU, or barcode…' }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const containerRef = useRef(null)

  const selected = products.find((p) => p.id === value)

  useEffect(() => {
    function handleClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const filtered = query.trim()
    ? products.filter((p) => {
        const q = query.toLowerCase()
        return (
          p.name?.toLowerCase().includes(q) ||
          p.sku?.toLowerCase().includes(q) ||
          p.barcode?.toLowerCase().includes(q)
        )
      })
    : products

  function selectProduct(p) {
    onChange(p.id)
    setQuery('')
    setOpen(false)
  }

  function clearSelection(e) {
    e.stopPropagation()
    onChange('')
    setQuery('')
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="input flex items-center gap-2 !p-0 pl-2.5 pr-2.5">
        <Search size={14} className="shrink-0 text-[var(--color-ink-soft)]" />
        <input
          type="text"
          value={open ? query : selected ? `${selected.sku} — ${selected.name}` : ''}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => {
            setQuery('')
            setOpen(true)
          }}
          placeholder={placeholder}
          className="w-full bg-transparent py-2 text-sm outline-none"
        />
        {selected && !open && (
          <button
            type="button"
            onClick={clearSelection}
            aria-label="Clear selected product"
            className="shrink-0 text-[var(--color-ink-soft)] hover:text-[var(--color-rust)]"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {open && (
        <div className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)] shadow-lg">
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-sm text-[var(--color-ink-soft)]">No matching products.</div>
          ) : (
            filtered.slice(0, 50).map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => selectProduct(p)}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-[var(--color-paper)]"
              >
                <span>{p.name}</span>
                <span className="font-mono text-xs text-[var(--color-ink-soft)]">{p.sku}</span>
              </button>
            ))
          )}
          {filtered.length > 50 && (
            <div className="px-3 py-1.5 text-xs text-[var(--color-ink-soft)]">
              Showing first 50 matches — keep typing to narrow it down.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
