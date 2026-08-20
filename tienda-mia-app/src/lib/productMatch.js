/**
 * Resolves a barcode (or SKU) to a product, checking both the primary
 * barcode field and any additional barcodes. An active product always wins
 * over an archived one — even when the archived product matched via its
 * own primary barcode and the active one only matched via an additional
 * barcode. Without this, merging a duplicate (archiving the old one, adding
 * its barcode as an additional one on the surviving product) would still
 * resolve to the archived product, since its own barcode field never
 * actually changed.
 *
 * `cleanFn` is the normalization function the caller already uses
 * (cleanCode in Sales/Purchases/Kitchen, normalizeSearchText in Adjustments)
 * — passed in rather than hardcoded so this works with either convention.
 */
export function resolveProductByCode(products, extraCodeMap, code, cleanFn) {
  if (!code) return null
  const cleaned = cleanFn(code)

  const primaryMatch = products.find((p) => cleanFn(p.barcode) === cleaned)
  const extraProductId = extraCodeMap[cleaned]
  const extraMatch = extraProductId ? products.find((p) => p.id === extraProductId) : null

  if (primaryMatch?.status === 'active') return primaryMatch
  if (extraMatch?.status === 'active') return extraMatch
  return primaryMatch || extraMatch || null
}
