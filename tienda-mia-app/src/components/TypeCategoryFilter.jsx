import { useEffect, useMemo, useRef } from 'react'

const TYPES = ['RETAIL', 'KITCHEN', 'INGREDIENT']

function categoryOf(p) {
  return p.category || '(none)'
}

export default function TypeCategoryFilter({ products, selectedTypes, setSelectedTypes, selectedCategories, setSelectedCategories }) {
  const categories = useMemo(() => [...new Set(products.map(categoryOf))].sort(), [products])
  const initialized = useRef(false)

  useEffect(() => {
    if (!initialized.current && categories.length > 0) {
      setSelectedTypes(TYPES)
      setSelectedCategories(categories)
      initialized.current = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories])

  function toggleType(type) {
    setSelectedTypes(selectedTypes.includes(type) ? selectedTypes.filter((t) => t !== type) : [...selectedTypes, type])
  }
  function toggleCategory(cat) {
    setSelectedCategories(selectedCategories.includes(cat) ? selectedCategories.filter((c) => c !== cat) : [...selectedCategories, cat])
  }

  return (
    <div className="no-print mb-4 rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)] p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">Filter</div>
        <button
          onClick={() => {
            setSelectedTypes(TYPES)
            setSelectedCategories(categories)
          }}
          className="text-xs text-[var(--color-ink-soft)] underline underline-offset-2"
        >
          Reset filters
        </button>
      </div>
      <div className="mb-3 flex gap-4">
        {TYPES.map((type) => (
          <label key={type} className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={selectedTypes.includes(type)} onChange={() => toggleType(type)} />
            {type === 'INGREDIENT' ? 'Ingredients' : type.charAt(0) + type.slice(1).toLowerCase()}
          </label>
        ))}
      </div>
      <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">Categories</div>
      <div className="flex max-h-28 flex-wrap gap-x-3 gap-y-1 overflow-y-auto">
        {categories.map((cat) => (
          <label key={cat} className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={selectedCategories.includes(cat)} onChange={() => toggleCategory(cat)} />
            {cat}
          </label>
        ))}
      </div>
    </div>
  )
}
