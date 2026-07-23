import { Search } from 'lucide-react'

export default function SearchBar({ value, onChange, placeholder = 'Search…' }) {
  return (
    <div className="mb-4 flex items-center gap-2 rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-3 py-2">
      <Search size={16} className="text-[var(--color-ink-soft)]" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-transparent text-sm outline-none placeholder:text-[var(--color-ink-soft)]/60"
      />
    </div>
  )
}
