import { Component } from 'react'
import { AlertTriangle } from 'lucide-react'

/**
 * Catches errors thrown while rendering a page and keeps the sidebar/nav alive
 * so a bug in one module (like the Reports crash) can't blank out the entire
 * app — you can still navigate elsewhere instead of being stuck reloading.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('Page crashed:', error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full items-center justify-center p-6">
          <div className="max-w-md rounded-md border border-[var(--color-rust)] bg-[var(--color-rust-soft)] p-5 text-center">
            <AlertTriangle className="mx-auto mb-2 text-[var(--color-rust)]" size={22} />
            <div className="font-display font-semibold text-[var(--color-rust)]">This page hit an error</div>
            <p className="mt-1.5 text-sm text-[var(--color-rust)]">
              {this.state.error.message ?? 'Something went wrong rendering this page.'}
            </p>
            <p className="mt-3 text-xs text-[var(--color-ink-soft)]">
              The rest of the app is still fine — use the sidebar to go elsewhere, or refresh to retry this page.
            </p>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
