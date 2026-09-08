import { useEffect, useMemo, useState } from 'react'
import { Check } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

// Known settings get a friendlier label, description, and the right input type.
// Anything else in the table still renders, just with a generic text field —
// so adding a new setting later doesn't require touching this screen.
// `group` controls which section it's shown under below. `unit` is the short
// label that sits right beside the input (e.g. "days", "%") — keep these
// short, since they share a row with a fixed-width input. Anything longer
// goes in `note` instead, which gets its own full-width line below.
const FIELD_META = {
  PURCHASING_DAY: {
    label: 'Purchasing day',
    type: 'select',
    options: DAYS,
    group: 'Purchasing & Forecasting',
  },
  DEFAULT_SAFETY_STOCK_PCT: {
    label: 'Default safety stock',
    type: 'number',
    unit: '% of average weekly demand',
    group: 'Purchasing & Forecasting',
  },
  FORECAST_WINDOW_WEEKS: {
    label: 'Forecast window',
    type: 'number',
    unit: 'weeks of history',
    group: 'Purchasing & Forecasting',
  },
  DEFAULT_LEAD_TIME_DAYS: {
    label: 'Default lead time',
    type: 'number',
    unit: 'days',
    group: 'Purchasing & Forecasting',
  },
  EOQ_ORDERING_COST: {
    label: 'EOQ ordering cost',
    type: 'number',
    unit: '₱ per PO',
    note: 'Used to compute Economic Order Quantity in Analytics.',
    group: 'Purchasing & Forecasting',
  },
  EOQ_HOLDING_COST_PCT: {
    label: 'EOQ holding cost',
    type: 'number',
    unit: '% of unit cost / year',
    note: 'The cost of tying up capital and shelf space in stock — used alongside EOQ ordering cost.',
    group: 'Purchasing & Forecasting',
  },
  SENIOR_PWD_DISCOUNT_PCT: {
    label: 'Senior / PWD discount',
    type: 'number',
    unit: '% off VAT-exclusive price',
    note: 'Applied identically to both Senior and PWD, since the math is the same.',
    group: 'Sales & Discounts',
  },
  EXPIRY_ALERT_DAYS: {
    label: 'Expiry alert window',
    type: 'number',
    unit: 'days before expiration',
    note: 'Controls Dashboard Expiry Alerts and the amber warning color in Inventory.',
    group: 'Alerts',
  },
  VAT_RATE_PCT: {
    label: 'VAT rate',
    type: 'number',
    unit: '%',
    note: 'This is a national tax rate, not a business setting. Changing it affects every VAT and discount figure across Sales, Reports, and Kitchen at once.',
    group: 'Tax & VAT',
    warnOnChange: true,
    formulas: [
      'Regular sale — VAT portion of the price charged:\nVAT = price × (rate ÷ (100 + rate))',
      'Senior/PWD discounted sale — VAT-exclusive price, then the discount applies to that:\nVAT-exclusive price = price ÷ (1 + rate ÷ 100)\nFinal price = VAT-exclusive price × (1 − discount%)',
    ],
  },
}

const GROUP_ORDER = ['Purchasing & Forecasting', 'Sales & Discounts', 'Alerts', 'Tax & VAT']

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
    const changed = settings.filter((s) => values[s.key] !== s.value)

    const riskyChange = changed.find((s) => FIELD_META[s.key]?.warnOnChange)
    if (riskyChange) {
      const meta = FIELD_META[riskyChange.key]
      const confirmed = confirm(
        `You're changing ${meta.label} from ${riskyChange.value}${meta.unit?.startsWith('%') ? '%' : ''} to ${values[riskyChange.key]}${meta.unit?.startsWith('%') ? '%' : ''}.\n\nThis is a national tax rate, not a business preference — changing it immediately changes every VAT and discount figure calculated anywhere in the app from now on, including past reports you re-open. Only proceed if the actual government rate has changed.\n\nContinue?`
      )
      if (!confirmed) return
    }

    setSaving(true)
    setErrorMsg('')

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
        <div className="max-w-md space-y-6">
          {[...GROUP_ORDER, 'Other'].map((groupName) => {
            const groupSettings = settings.filter((s) => (FIELD_META[s.key]?.group ?? 'Other') === groupName)
            if (groupSettings.length === 0) return null
            return (
              <div key={groupName}>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">{groupName}</h2>
                <div className="space-y-4">
                  {groupSettings.map((s) => {
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
                                className="input shrink-0"
                                style={{ width: '6rem' }}
                              />
                              {meta.unit && (
                                <span className="flex-1 text-xs text-[var(--color-ink-soft)]">{meta.unit}</span>
                              )}
                            </div>
                          )}
                          {meta.note && (
                            <p className="mt-2 text-xs text-[var(--color-ink-soft)]">{meta.note}</p>
                          )}
                          {meta.formulas && (
                            <div className="mt-3 space-y-2 rounded-md bg-[var(--color-paper)] p-3">
                              {meta.formulas.map((f, i) => (
                                <pre key={i} className="whitespace-pre-wrap font-mono text-xs text-[var(--color-ink-soft)]">{f}</pre>
                              ))}
                            </div>
                          )}
                        </label>
                      </div>
                    )
                  })}
                </div>
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
