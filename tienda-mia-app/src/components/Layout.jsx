import { NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  LayoutDashboard,
  Package,
  ShoppingCart,
  ClipboardList,
  Boxes,
  Receipt,
  ChefHat,
  ClipboardEdit,
  RotateCcw,
  FileText,
  TrendingUp,
  Settings as SettingsIcon,
} from 'lucide-react'
import ErrorBoundary from './ErrorBoundary'

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/products', label: 'Products', icon: Package },
  { to: '/purchases', label: 'Purchases', icon: ShoppingCart },
  { to: '/purchase-list', label: 'Purchase List', icon: ClipboardList },
  { to: '/inventory', label: 'Inventory', icon: Boxes },
  { to: '/sales', label: 'Sales', icon: Receipt },
  { to: '/kitchen', label: 'Kitchen', icon: ChefHat },
  { to: '/adjustments', label: 'Adjustments', icon: ClipboardEdit },
  { to: '/returns-waste', label: 'Returns & Waste', icon: RotateCcw },
  { to: '/reports', label: 'Reports', icon: FileText },
  { to: '/analytics', label: 'Analytics', icon: TrendingUp },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
]

export default function Layout() {
  const location = useLocation()
  return (
    <div className="flex h-screen bg-[var(--color-paper)] text-[var(--color-ink)]">
      <aside className="flex w-60 flex-col bg-[var(--color-ink)] text-[var(--color-paper)]">
        <div className="px-5 py-6">
          <span className="font-display text-lg font-semibold tracking-tight">Tienda Mia</span>
          <p className="mt-0.5 text-xs text-[var(--color-paper)]/60">Inventory &amp; Retail Ops</p>
        </div>
        <nav className="flex-1 space-y-0.5 px-3">
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? 'bg-[var(--color-paper)]/10 font-medium text-white'
                    : 'text-[var(--color-paper)]/70 hover:bg-[var(--color-paper)]/5 hover:text-white'
                }`
              }
            >
              <Icon size={17} strokeWidth={2} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-white/10 px-5 py-4 text-xs text-[var(--color-paper)]/50">
          Full spec built — Analytics fills in as sales accumulate
        </div>
      </aside>

      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b border-[var(--color-line)] bg-[var(--color-paper-raised)] px-6 py-3.5">
          <div className="font-mono text-xs text-[var(--color-ink-soft)]">
            every unit traceable to a batch
          </div>
          <div className="h-8 w-8 rounded-full bg-[var(--color-herb-soft)] text-center text-sm font-medium leading-8 text-[var(--color-herb)]">
            TM
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-6">
          <ErrorBoundary key={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  )
}
