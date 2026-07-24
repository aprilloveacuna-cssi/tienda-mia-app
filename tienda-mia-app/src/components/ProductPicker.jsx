import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'

/**
 * Search-as-you-type product picker — swaps in for a plain <select> once a
 * catalog is too long to scroll through. Matches on name, SKU, or barcode.
 * Fully keyboard-operable: Arrow Up/Down moves the highlight, Enter selects
 * the highlighted option, Escape closes without changing anything.
 */
export default function ProductPicker({ products, value, onChange, placeholder = 'Search by name, SKU, or barcode…' }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  const containerRef = useRef(null)
  const optionRefs = useRef([])

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

  const visibleResults = filtered.slice(0, 50)

  // Keeps the highlight sane whenever the visible results change shape (new
  // query, dropdown just opened) — starting fresh rather than pointing at
  // something that may no longer exist at that index.
  useEffect(() => {
    setHighlightedIndex(visibleResults.length > 0 ? 0 : -1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, open])

  useEffect(() => {
    if (highlightedIndex >= 0 && optionRefs.current[highlightedIndex]) {
      optionRefs.current[highlightedIndex].scrollIntoView({ block: 'nearest' })
    }
  }, [highlightedIndex])

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

  function handleKeyDown(e) {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        setOpen(true)
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightedIndex((i) => (i + 1 < visibleResults.length ? i + 1 : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightedIndex((i) => (i - 1 >= 0 ? i - 1 : visibleResults.length - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (highlightedIndex >= 0 && visibleResults[highlightedIndex]) {
        selectProduct(visibleResults[highlightedIndex])
      }
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
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
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="w-full bg-transparent py-2 text-sm outline-none"
          role="combobox"
          aria-expanded={open}
          aria-controls="product-picker-listbox"
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
        <div
          id="product-picker-listbox"
          role="listbox"
          className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)] shadow-lg"
        >
          {visibleResults.length === 0 ? (
            <div className="px-3 py-2 text-sm text-[var(--color-ink-soft)]">No matching products.</div>
          ) : (
            visibleResults.map((p, i) => (
              <button
                key={p.id}
                ref={(el) => (optionRefs.current[i] = el)}
                type="button"
                role="option"
                aria-selected={i === highlightedIndex}
                onClick={() => selectProduct(p)}
                onMouseEnter={() => setHighlightedIndex(i)}
                className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm ${
                  i === highlightedIndex ? 'bg-[var(--color-paper)]' : ''
                }`}
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
