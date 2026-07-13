import { useEffect, useMemo, useState } from 'react'
import { Check } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

// Known settings get a friendlier label, description, and the right input type.
// Anything else in the table still renders, just with a generic text field —
// so adding a new setting later doesn't require touching this screen.
const FIELD_META = {
  PURCHASING_DAY: {
    label: 'Purchasing day',
    type: 'select',
    options: DAYS,
  },
  DEFAULT_SAFETY_STOCK_PCT: {
    label: 'Default safety stock',
    type: 'number',
    suffix: '% of average weekly demand',
  },
  FORECAST_WINDOW_WEEKS: {
    label: 'Forecast window',
    type: 'number',
    suffix: 'weeks of history',
  },
  DEFAULT_LEAD_TIME_DAYS: {
    label: 'Default lead time',
    type: 'number',
    suffix: 'days',
  },
}

function prettifyKey(key) {
  return key
    .split('_')
    .map((w) => w[0] + w.slice(1).toLowerCase())
    .join(' ')
}

export default function Settings() {
  const [settings, setSettings] = useState([])
  const [values, setValues] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')
  const [savedMsg, setSavedMsg] = useState(false)

  async function load() {
    setLoading(true)
    setErrorMsg('')
    const { data, error } = await supabase.from('settings').select('*').order('key')
    if (error) {
      setErrorMsg('Could not reach Supabase. Check your .env values and that migrations have run.')
      setLoading(false)
      return
    }
    setSettings(data ?? [])
    const initial = {}
    for (const row of data ?? []) initial[row.key] = row.value
    setValues(initial)
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  const isDirty = useMemo(
    () => settings.some((s) => values[s.key] !== s.value),
    [settings, values]
  )

  function handleChange(key, value) {
    setValues({ ...values, [key]: value })
    setSavedMsg(false)
  }

  async function handleSave() {
    setSaving(true)
    setErrorMsg('')
    const changed = settings.filter((s) => values[s.key] !== s.value)

    for (const s of changed) {
      const { error } = await supabase
        .from('settings')
        .update({ value: values[s.key] })
        .eq('key', s.key)
      if (error) {
        setErrorMsg(`Failed saving ${s.key}: ${error.message}`)
        setSaving(false)
        return
      }
    }

    setSaving(false)
    setSavedMsg(true)
    load()
  }

  return (
    <div>
      <div className="mb-5">
        <h1 className="font-display text-2xl font-semibold">Settings</h1>
        <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
          These drive purchasing recommendations and forecasting once there's enough sales history for those to run.
        </p>
      </div>

      {errorMsg && (
        <div className="mb-4 rounded-md bg-[var(--color-rust-soft)] px-3.5 py-2.5 text-sm text-[var(--color-rust)]">
          {errorMsg}
        </div>
      )}

      {loading ? (
        <div className="rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-4 py-8 text-center text-sm text-[var(--color-ink-soft)]">
          Loading settings…
        </div>
      ) : (
        <div className="max-w-md space-y-4">
          {settings.map((s) => {
            const meta = FIELD_META[s.key] ?? { label: prettifyKey(s.key), type: 'text' }
            return (
              <div key={s.key} className="rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)] p-4">
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">{meta.label}</span>
                  {s.description && (
                    <span className="mb-2 block text-xs text-[var(--color-ink-soft)]">{s.description}</span>
                  )}
                  {meta.type === 'select' ? (
                    <select
                      value={values[s.key] ?? ''}
                      onChange={(e) => handleChange(s.key, e.target.value)}
                      className="input"
                    >
                      {meta.options.map((o) => (
                        <option key={o} value={o}>{o}</option>
                      ))}
                    </select>
                  ) : (
                    <div className="flex items-center gap-2">
                      <input
                        type={meta.type}
                        value={values[s.key] ?? ''}
                        onChange={(e) => handleChange(s.key, e.target.value)}
                        className="input"
                      />
                      {meta.suffix && (
                        <span className="whitespace-nowrap text-xs text-[var(--color-ink-soft)]">{meta.suffix}</span>
                      )}
                    </div>
                  )}
                </label>
              </div>
            )
          })}

          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={handleSave}
              disabled={!isDirty || saving}
              className="flex items-center gap-1.5 rounded-md bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              <Check size={15} />
              {saving ? 'Saving…' : 'Save changes'}
            </button>
            {savedMsg && !isDirty && (
              <span className="text-sm text-[var(--color-herb)]">Saved.</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
