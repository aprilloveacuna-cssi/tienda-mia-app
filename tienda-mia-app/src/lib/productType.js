export function productTypeGroup(p) {
  if (p.product_type === 'RAW MATERIAL') return 'INGREDIENT'
  if (p.business_unit === 'KITCHEN') return 'KITCHEN'
  return 'RETAIL'
}
