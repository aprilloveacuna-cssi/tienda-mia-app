import { ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react'

export default function SortableTh({ label, sortKey, activeKey, activeDir, onSort, className = '' }) {
  const isActive = activeKey === sortKey
  return (
    <th
      onClick={() => onSort(sortKey)}
      className={`cursor-pointer select-none px-4 py-3 hover:text-[var(--color-ink)] ${className}`}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {isActive ? (
          activeDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />
        ) : (
          <ArrowUpDown size={12} className="opacity-30" />
        )}
      </span>
    </th>
  )
}
