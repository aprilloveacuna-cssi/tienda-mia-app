// Small hand-written CSV parser — handles quoted fields containing commas,
// which a plain split(',') would break on. Shared by any page that needs
// CSV import (Products, Purchases, Sales all use this).
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  const pushField = () => { row.push(field); field = '' }
  const pushRow = () => { pushField(); rows.push(row); row = [] }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else { inQuotes = false }
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      pushField()
    } else if (c === '\n') {
      pushRow()
    } else if (c !== '\r') {
      field += c
    }
  }
  if (field !== '' || row.length > 0) pushRow()
  return rows.filter((r) => r.some((v) => v.trim() !== ''))
}

export function normalizeHeader(h) {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
