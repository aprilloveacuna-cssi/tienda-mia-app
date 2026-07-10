/**
 * Placeholder for modules not yet built. Per design guidance, an empty
 * screen should say what unlocks it next, not just "coming soon."
 */
export default function PhaseNotice({ title, phase, unlocksWith }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-md text-center">
        <span className="font-mono text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
          Phase {phase}
        </span>
        <h1 className="font-display mt-2 text-2xl font-semibold">{title}</h1>
        <p className="mt-3 text-sm leading-relaxed text-[var(--color-ink-soft)]">
          {unlocksWith}
        </p>
      </div>
    </div>
  )
}
