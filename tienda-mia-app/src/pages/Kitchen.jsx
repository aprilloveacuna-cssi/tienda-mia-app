import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Trash2, Check, FileDown, Upload, Pencil, Archive } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { fetchAllRows } from '../lib/fetchAllRows'
import SlidePanel from '../components/SlidePanel'
import StatusChip from '../components/StatusChip'
import SortableTh from '../components/SortableTh'
import ProductPicker from '../components/ProductPicker'
import { useSort, sortRows } from '../lib/sort'
import { parseCsv, normalizeHeader, downloadFile } from '../lib/csv'

const INGREDIENT_HEADER_ALIASES = {
  barcode: 'barcode', sku: 'sku',
  name: 'name', ingredient: 'name', ingredientname: 'name', productname: 'name',
  quantityperyield: 'quantity_per_yield', qty: 'quantity_per_yield', quantity: 'quantity_per_yield',
  unit: 'unit',
}

const EMPTY_RECIPE_FORM = {
  product_id: '',
  yield_quantity: '1',
  prep_loss_pct: '0',
  packaging_cost: '0',
  labor_cost: '0',
  overhead_cost: '0',
}
const EMPTY_INGREDIENT_FORM = { ingredient_product_id: '', quantity_per_yield: '', unit: '' }

// A recipe's measurement (2 tsp of vanilla) is often different from how that
// ingredient is stocked (a 1L bottle) — this covers common cooking units on
// top of whatever the product's own inventory unit is, so either works.
const RECIPE_UNITS = ['pcs', 'g', 'kg', 'ml', 'L', 'tsp', 'tbsp', 'cup', 'pinch', 'slice', 'clove', 'oz']

// Base unit per family — grams for weight, ml for volume. Counted units
// (pcs/slice/clove) have no reliable conversion to anything else, since that
// depends on the specific ingredient (a "clove" of garlic isn't a fixed weight).
const WEIGHT_TO_GRAMS = { g: 1, kg: 1000, oz: 28.3495 }
const VOLUME_TO_ML = { ml: 1, l: 1000, tsp: 4.92892, tbsp: 14.7868, cup: 236.588, pinch: 0.3081 }

function unitFamily(unit) {
  const u = (unit || '').toLowerCase()
  if (u in WEIGHT_TO_GRAMS) return 'weight'
  if (u in VOLUME_TO_ML) return 'volume'
  return null
}

// Converts a quantity from one unit to another when they're in the same
// family (both weight, or both volume). Returns null when conversion isn't
// possible — different families, or either side is a counted unit — so the
// caller can fall back and flag it rather than silently computing something wrong.
function convertQuantity(qty, fromUnit, toUnit) {
  if (!fromUnit || !toUnit) return qty
  const from = fromUnit.toLowerCase()
  const to = toUnit.toLowerCase()
  if (from === to) return qty
  const family = unitFamily(from)
  if (!family || family !== unitFamily(to)) return null
  const table = family === 'weight' ? WEIGHT_TO_GRAMS : VOLUME_TO_ML
  return (qty * table[from]) / table[to]
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

function upper(v) {
  return v ? v.toUpperCase() : v
}

function recipeCost(recipe, ingredients) {
  const rawCost = ingredients.reduce((sum, i) => {
    const converted = convertQuantity(i.quantity_per_yield, i.unit, i.product_unit)
    // Falls back to the raw quantity_per_yield when units aren't convertible —
    // same behavior as before this existed, just now flagged (see unitMismatch)
    // instead of silently assumed correct.
    const effectiveQty = converted !== null ? converted : i.quantity_per_yield
    return sum + effectiveQty * i.current_cost
  }, 0)
  const lossFactor = 1 - Number(recipe.prep_loss_pct || 0) / 100
  const adjustedRawCost = lossFactor > 0 ? rawCost / lossFactor : rawCost
  const total =
    adjustedRawCost +
    Number(recipe.packaging_cost || 0) +
    Number(recipe.labor_cost || 0) +
    Number(recipe.overhead_cost || 0)
  const yieldQty = Number(recipe.yield_quantity || 1)
  return { total, perUnit: yieldQty > 0 ? total / yieldQty : total }
}

export default function Kitchen() {
  const [tab, setTab] = useState('recipes')
  const [products, setProducts] = useState([])
  const [recipes, setRecipes] = useState([])
  const [leftovers, setLeftovers] = useState([])
  const [dailyMealsDate, setDailyMealsDate] = useState(today())
  const [dailyMealLines, setDailyMealLines] = useState([])
  const [dailyMealForm, setDailyMealForm] = useState({ product_id: '', quantity: '', unit_cost: '', expiration_date: '' })
  const [dailyMealsSaving, setDailyMealsSaving] = useState(false)
  const [dailyMealsError, setDailyMealsError] = useState('')
  const [leftoverForm, setLeftoverForm] = useState({ product_id: '', quantity: '', leftover_date: today(), notes: '' })

  // Ingredients (raw materials) — separate management list, kept out of the
  // main Products page since these aren't sold on their own.
  const [ingredientProducts, setIngredientProducts] = useState([])
  const ingredientProductFileInputRef = useRef(null)
  const [ingredientProductImportOpen, setIngredientProductImportOpen] = useState(false)
  const [ingredientProductImportValid, setIngredientProductImportValid] = useState([])
  const [ingredientProductImportSkipped, setIngredientProductImportSkipped] = useState([])
  const [ingredientProductImporting, setIngredientProductImporting] = useState(false)
  const [ingredientProductPanelOpen, setIngredientProductPanelOpen] = useState(false)
  const [editingIngredientId, setEditingIngredientId] = useState(null)
  const [ingredientProductForm, setIngredientProductForm] = useState({ barcode: '', name: '', unit: '', current_cost: '' })
  const [savingIngredientProduct, setSavingIngredientProduct] = useState(false)
  const [ingredientProductError, setIngredientProductError] = useState('')
  const [leftoverSaving, setLeftoverSaving] = useState(false)
  const [leftoverError, setLeftoverError] = useState('')
  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState('')

  // Recipe cost/margin are derived, not stored — compute them once per recipe
  // here so sorting has a real number to sort by, instead of recomputing
  // per-row inside the render (and having nothing to sort against).
  const recipesWithDerived = useMemo(() => {
    return recipes.map((r) => {
      const ingredients = r.recipe_ingredients.map((ri) => ({
        quantity_per_yield: ri.quantity_per_yield,
        current_cost: Number(ri.ingredient?.current_cost || 0),
        unit: ri.unit,
        product_unit: ri.ingredient?.unit,
      }))
      const { perUnit } = recipeCost(r, ingredients)
      const sellingPrice = Number(r.product?.selling_price || 0)
      const margin = sellingPrice > 0 ? ((sellingPrice - perUnit) / sellingPrice) * 100 : null
      return { ...r, perUnit, margin }
    })
  }, [recipes])

  const { sortKey: recipeSortKey, sortDir: recipeSortDir, toggleSort: toggleRecipeSort } = useSort('name')
  function recipeSortAccessor(row, key) {
    if (key === 'name') return row.product?.name
    if (key === 'yield') return Number(row.yield_quantity ?? 0)
    if (key === 'ingredients') return row.recipe_ingredients.length
    if (key === 'cost') return row.perUnit
    if (key === 'margin') return row.margin ?? -Infinity
    return row[key]
  }
  const sortedRecipes = sortRows(recipesWithDerived, recipeSortKey, recipeSortDir, recipeSortAccessor)

  // Recipe builder panel
  const [recipePanelOpen, setRecipePanelOpen] = useState(false)
  const [editingRecipeId, setEditingRecipeId] = useState(null)
  const [recipeForm, setRecipeForm] = useState(EMPTY_RECIPE_FORM)
  const [recipeIngredients, setRecipeIngredients] = useState([])
  const [ingredientForm, setIngredientForm] = useState(EMPTY_INGREDIENT_FORM)
  const ingredientFileInputRef = useRef(null)
  const [ingredientImportPanelOpen, setIngredientImportPanelOpen] = useState(false)
  const [ingredientImportValid, setIngredientImportValid] = useState([])
  const [ingredientImportSkipped, setIngredientImportSkipped] = useState([])
  const [savingRecipe, setSavingRecipe] = useState(false)

  async function loadAll() {
    setLoading(true)
    setErrorMsg('')
    const [productsRes, recipesRes, leftoversRes] = await Promise.all([
      fetchAllRows('products', 'id, sku, name, unit, barcode, current_cost, selling_price, status, business_unit, category, product_type', 'name'),
      supabase
        .from('recipes')
        .select('*, product:products(name, sku, unit, selling_price), recipe_ingredients(*, ingredient:products(name, sku, unit, current_cost))')
        .eq('status', 'active')
        .order('created_at', { ascending: false }),
      fetchAllRows('waste', '*, product:products(name, sku, unit)', 'waste_date', { ascending: false }),
    ])

    if (productsRes.error || recipesRes.error || leftoversRes.error) {
      setErrorMsg('Could not reach Supabase. Check your .env values and that migrations have run.')
      setLoading(false)
      return
    }
    const allProducts = productsRes.data ?? []
    setProducts(allProducts.filter((p) => p.status === 'active'))
    setIngredientProducts(allProducts.filter((p) => p.product_type === 'RAW MATERIAL'))
    setRecipes(recipesRes.data ?? [])
    setLeftovers((leftoversRes.data ?? []).filter((w) => w.reason === 'Daily Leftover'))
    setLoading(false)
  }

  useEffect(() => {
    loadAll()
  }, [])

  // ---------- Recipe builder ----------
  function openNewRecipe() {
    setEditingRecipeId(null)
    setRecipeForm(EMPTY_RECIPE_FORM)
    setRecipeIngredients([])
    setIngredientForm(EMPTY_INGREDIENT_FORM)
    setErrorMsg('')
    setRecipePanelOpen(true)
  }

  function openEditRecipe(recipe) {
    setEditingRecipeId(recipe.id)
    setRecipeForm({
      product_id: recipe.product_id,
      yield_quantity: String(recipe.yield_quantity),
      prep_loss_pct: String(recipe.prep_loss_pct),
      packaging_cost: String(recipe.packaging_cost),
      labor_cost: String(recipe.labor_cost),
      overhead_cost: String(recipe.overhead_cost),
    })
    setRecipeIngredients(
      recipe.recipe_ingredients.map((ri) => ({
        tempId: crypto.randomUUID(),
        ingredient_product_id: ri.ingredient_product_id,
        name: ri.ingredient?.name,
        current_cost: Number(ri.ingredient?.current_cost || 0),
        quantity_per_yield: Number(ri.quantity_per_yield),
        unit: ri.unit,
        product_unit: ri.ingredient?.unit,
      }))
    )
    setIngredientForm(EMPTY_INGREDIENT_FORM)
    setErrorMsg('')
    setRecipePanelOpen(true)
  }

  async function deleteRecipe(recipe) {
    if (!confirm(`Delete the recipe for ${recipe.product?.name}? This can't be undone.`)) return
    setErrorMsg('')

    const { error: ingErr } = await supabase.from('recipe_ingredients').delete().eq('recipe_id', recipe.id)
    if (ingErr) {
      setErrorMsg(ingErr.message)
      return
    }
    const { error } = await supabase.from('recipes').delete().eq('id', recipe.id)
    if (error) {
      // Most likely a production run in the (now-retired) Production flow still
      // references this recipe — archiving is always safe, so offer that instead
      // of leaving the user stuck on a raw database error.
      if (confirm(`Couldn't delete — it's likely still referenced by an old production record.\n\nArchive it instead? It'll stop showing up here and won't be usable in Daily Meals' cost auto-fill.`)) {
        await supabase.from('recipes').update({ status: 'archived' }).eq('id', recipe.id)
      } else {
        return
      }
    }
    loadAll()
  }

  function addIngredientToRecipe(e) {
    e.preventDefault()
    if (!ingredientForm.ingredient_product_id || !ingredientForm.quantity_per_yield) return
    const p = products.find((x) => x.id === ingredientForm.ingredient_product_id)
    setRecipeIngredients([
      ...recipeIngredients,
      {
        tempId: crypto.randomUUID(),
        ingredient_product_id: p.id,
        name: p.name,
        current_cost: Number(p.current_cost || 0),
        quantity_per_yield: Number(ingredientForm.quantity_per_yield),
        unit: ingredientForm.unit || p.unit,
        product_unit: p.unit,
      },
    ])
    setIngredientForm(EMPTY_INGREDIENT_FORM)
  }

  function removeIngredientFromRecipe(tempId) {
    setRecipeIngredients(recipeIngredients.filter((i) => i.tempId !== tempId))
  }

  function handleDownloadIngredientTemplate() {
    const headers = ['Name', 'Quantity per Yield', 'Unit']
    const example1 = ['PORK', '2', 'kg']
    const example2 = ['ONION', '250', 'g']
    const csv = [headers, example1, example2]
      .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    downloadFile('recipe-ingredients-template.csv', csv, 'text/csv;charset=utf-8;')
  }

  function handleIngredientFileChange(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    const reader = new FileReader()
    reader.onload = () => {
      try {
        const rows = parseCsv(String(reader.result))
        if (rows.length < 2) {
          setErrorMsg('That file has no data rows.')
          return
        }
        const headerRow = rows[0].map((h) => h.trim())
        const canonicalKeys = headerRow.map((h) => INGREDIENT_HEADER_ALIASES[normalizeHeader(h)] ?? null)
        const cleanCode = (v) =>
          (v ?? '')
            .normalize('NFKC')
            // eslint-disable-next-line no-misleading-character-class -- intentional list of individual invisible chars, not a ZWJ sequence
            .replace(/[\s\u200B\u200C\u200D\u2060\uFEFF\u00AD]/g, '')
            .toUpperCase()

        const valid = []
        const skipped = []

        rows.slice(1).forEach((r, idx) => {
          const rowNum = idx + 2
          if (r.length !== headerRow.length) {
            skipped.push({
              rowNum,
              reason: `Row has ${r.length} column${r.length === 1 ? '' : 's'}, expected ${headerRow.length} — likely a stray quote or comma threw off parsing`,
            })
            return
          }
          const obj = {}
          canonicalKeys.forEach((key, i) => {
            if (key) obj[key] = (r[i] ?? '').trim()
          })

          const product = obj.barcode
            ? products.find((p) => cleanCode(p.barcode) === cleanCode(obj.barcode))
            : obj.sku
              ? products.find((p) => cleanCode(p.sku) === cleanCode(obj.sku))
              : obj.name
                ? products.find((p) => cleanCode(p.name) === cleanCode(obj.name))
                : null

          if (!product) {
            const attempted = obj.barcode || obj.sku || obj.name
            skipped.push({ rowNum, reason: attempted ? `No product matches "${attempted}"` : 'Missing barcode/SKU/name' })
            return
          }
          const qty = Number(obj.quantity_per_yield)
          if (!qty || qty <= 0) {
            skipped.push({ rowNum, reason: 'Missing or invalid quantity' })
            return
          }

          valid.push({
            tempId: crypto.randomUUID(),
            ingredient_product_id: product.id,
            name: product.name,
            current_cost: Number(product.current_cost || 0),
            quantity_per_yield: qty,
            unit: obj.unit || product.unit,
            product_unit: product.unit,
          })
        })

        setIngredientImportValid(valid)
        setIngredientImportSkipped(skipped)
        setErrorMsg('')
        setIngredientImportPanelOpen(true)
      } catch {
        setErrorMsg('Could not read that file — make sure it is a CSV, not an .xlsx.')
      }
    }
    reader.readAsText(file)
  }

  function handleConfirmIngredientImport() {
    setRecipeIngredients([...recipeIngredients, ...ingredientImportValid])
    setIngredientImportPanelOpen(false)
    setIngredientImportValid([])
    setIngredientImportSkipped([])
  }

  const livePreview = useMemo(
    () => recipeCost(recipeForm, recipeIngredients),
    [recipeForm, recipeIngredients]
  )

  async function saveRecipe(e) {
    e.preventDefault()
    if (!recipeForm.product_id || recipeIngredients.length === 0) {
      setErrorMsg('Pick a finished product and add at least one ingredient.')
      return
    }
    setSavingRecipe(true)
    setErrorMsg('')

    const recipePayload = {
      product_id: recipeForm.product_id,
      yield_quantity: Number(recipeForm.yield_quantity),
      prep_loss_pct: Number(recipeForm.prep_loss_pct),
      packaging_cost: Number(recipeForm.packaging_cost),
      labor_cost: Number(recipeForm.labor_cost),
      overhead_cost: Number(recipeForm.overhead_cost),
    }

    let recipeId = editingRecipeId
    if (editingRecipeId) {
      const { error } = await supabase.from('recipes').update(recipePayload).eq('id', editingRecipeId)
      if (error) {
        setErrorMsg(error.message)
        setSavingRecipe(false)
        return
      }
      // Simplest correct way to handle arbitrary add/remove/edit of ingredients —
      // replace the whole set rather than trying to diff old vs new.
      const { error: delErr } = await supabase.from('recipe_ingredients').delete().eq('recipe_id', editingRecipeId)
      if (delErr) {
        setErrorMsg(`Recipe updated but ingredients failed to refresh: ${delErr.message}`)
        setSavingRecipe(false)
        return
      }
    } else {
      const { data: recipe, error: recipeErr } = await supabase.from('recipes').insert(recipePayload).select().single()
      if (recipeErr) {
        setErrorMsg(recipeErr.message)
        setSavingRecipe(false)
        return
      }
      recipeId = recipe.id
    }

    const ingredientRows = recipeIngredients.map((i) => ({
      recipe_id: recipeId,
      ingredient_product_id: i.ingredient_product_id,
      quantity_per_yield: i.quantity_per_yield,
      unit: i.unit,
    }))
    const { error: ingErr } = await supabase.from('recipe_ingredients').insert(ingredientRows)

    setSavingRecipe(false)
    if (ingErr) {
      setErrorMsg(`Recipe saved but ingredients failed: ${ingErr.message}`)
      return
    }
    setRecipePanelOpen(false)
    loadAll()
  }

  // ---------- Daily Available Meals (quick entry, no ingredient deduction) ----------
  const kitchenProducts = products.filter((p) => p.business_unit === 'KITCHEN' || p.category === 'KITCHEN')

  // ---------- Ingredients (raw materials) management ----------
  function openNewIngredientProduct() {
    setEditingIngredientId(null)
    setIngredientProductForm({ barcode: '', name: '', unit: '', current_cost: '' })
    setIngredientProductError('')
    setIngredientProductPanelOpen(true)
  }

  function openEditIngredientProduct(p) {
    setEditingIngredientId(p.id)
    setIngredientProductForm({
      barcode: p.barcode ?? '',
      name: p.name ?? '',
      unit: p.unit ?? '',
      current_cost: String(p.current_cost ?? ''),
    })
    setIngredientProductError('')
    setIngredientProductPanelOpen(true)
  }

  async function handleSaveIngredientProduct(e) {
    e.preventDefault()
    if (!ingredientProductForm.name.trim()) return
    setSavingIngredientProduct(true)
    setIngredientProductError('')

    // Barcode is optional here — these are internal-only items with no real
    // scannable code, so make one up if left blank (the column itself still
    // requires something unique, per the schema).
    const barcode =
      ingredientProductForm.barcode.trim() ||
      `ING-${ingredientProductForm.name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-')}-${Math.floor(1000 + Math.random() * 9000)}`

    const payload = {
      barcode,
      name: upper(ingredientProductForm.name.trim()),
      unit: upper(ingredientProductForm.unit.trim()) || null,
      current_cost: ingredientProductForm.current_cost === '' ? 0 : Number(ingredientProductForm.current_cost),
      product_type: 'RAW MATERIAL',
    }

    const { error } = editingIngredientId
      ? await supabase.from('products').update(payload).eq('id', editingIngredientId)
      : await supabase.from('products').insert(payload)

    setSavingIngredientProduct(false)
    if (error) {
      setIngredientProductError(error.code === '23505' ? 'That code is already used by another product.' : error.message)
      return
    }
    setIngredientProductPanelOpen(false)
    loadAll()
  }

  async function toggleArchiveIngredientProduct(p) {
    const nextStatus = p.status === 'active' ? 'archived' : 'active'
    await supabase.from('products').update({ status: nextStatus }).eq('id', p.id)
    loadAll()
  }

  function handleDownloadIngredientProductTemplate() {
    const headers = ['Name', 'Unit', 'Cost per unit']
    const example1 = ['PORK', 'g', '0.33']
    const example2 = ['ONION', 'g', '0.10']
    const csv = [headers, example1, example2]
      .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    downloadFile('ingredients-template.csv', csv, 'text/csv;charset=utf-8;')
  }

  function handleIngredientProductImportClick() {
    ingredientProductFileInputRef.current?.click()
  }

  function handleIngredientProductFileChange(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    const reader = new FileReader()
    reader.onload = () => {
      try {
        const rows = parseCsv(String(reader.result))
        if (rows.length < 2) {
          setErrorMsg('That file has no data rows.')
          return
        }
        const headerRow = rows[0].map((h) => h.trim())
        const aliases = { name: 'name', ingredient: 'name', unit: 'unit', cost: 'cost', costperunit: 'cost', unitcost: 'cost' }
        const canonicalKeys = headerRow.map((h) => aliases[normalizeHeader(h)] ?? null)

        const existingNames = new Set(ingredientProducts.map((p) => p.name.toUpperCase()))
        const seenInFile = new Set()
        const valid = []
        const skipped = []

        rows.slice(1).forEach((r, idx) => {
          const rowNum = idx + 2
          if (r.length !== headerRow.length) {
            skipped.push({
              rowNum,
              reason: `Row has ${r.length} column${r.length === 1 ? '' : 's'}, expected ${headerRow.length} — likely a stray quote or comma threw off parsing`,
            })
            return
          }
          const obj = {}
          canonicalKeys.forEach((key, i) => {
            if (key) obj[key] = (r[i] ?? '').trim()
          })

          const name = (obj.name || '').toUpperCase()
          if (!name) {
            skipped.push({ rowNum, reason: 'Missing name' })
            return
          }
          if (existingNames.has(name)) {
            skipped.push({ rowNum, reason: `${obj.name} already exists as an ingredient` })
            return
          }
          if (seenInFile.has(name)) {
            skipped.push({ rowNum, reason: `Duplicate "${obj.name}" within this file` })
            return
          }
          const cost = Number(obj.cost)
          if (obj.cost === undefined || obj.cost === '' || isNaN(cost) || cost < 0) {
            skipped.push({ rowNum, reason: 'Missing or invalid cost' })
            return
          }
          seenInFile.add(name)

          valid.push({
            tempId: crypto.randomUUID(),
            name,
            unit: upper(obj.unit) || null,
            current_cost: cost,
          })
        })

        setIngredientProductImportValid(valid)
        setIngredientProductImportSkipped(skipped)
        setErrorMsg('')
        setIngredientProductImportOpen(true)
      } catch {
        setErrorMsg('Could not read that file — make sure it is a CSV, not an .xlsx.')
      }
    }
    reader.readAsText(file)
  }

  async function handleConfirmIngredientProductImport() {
    setIngredientProductImporting(true)
    let inserted = 0
    const failed = []
    for (const row of ingredientProductImportValid) {
      const barcode = `ING-${row.name.replace(/[^A-Z0-9]+/g, '-')}-${Math.floor(1000 + Math.random() * 9000)}`
      const { error } = await supabase.from('products').insert({
        barcode,
        name: row.name,
        unit: row.unit,
        current_cost: row.current_cost,
        product_type: 'RAW MATERIAL',
      })
      if (error) {
        failed.push({ name: row.name, reason: error.message })
      } else {
        inserted++
      }
    }
    setIngredientProductImporting(false)
    setIngredientProductImportOpen(false)
    setIngredientProductImportValid([])
    setIngredientProductImportSkipped([])
    if (failed.length > 0) {
      setErrorMsg(`${inserted} added, ${failed.length} failed: ${failed.map((f) => f.name).join(', ')}`)
    }
    loadAll()
  }

  // If this product has a Recipe defined, auto-fill the day's cost from that
  // recipe's ingredient math — still editable, since actual cost can vary day
  // to day, but saves re-typing it every time for dishes you've already priced.
  function onDailyMealProductPick(id) {
    const recipe = recipes.find((r) => r.product_id === id)
    let autoCost = ''
    if (recipe) {
      const ingredients = recipe.recipe_ingredients.map((ri) => ({
        quantity_per_yield: ri.quantity_per_yield,
        current_cost: Number(ri.ingredient?.current_cost || 0),
        unit: ri.unit,
        product_unit: ri.ingredient?.unit,
      }))
      autoCost = recipeCost(recipe, ingredients).perUnit.toFixed(2)
    }
    setDailyMealForm({ ...dailyMealForm, product_id: id, unit_cost: autoCost || dailyMealForm.unit_cost })
  }

  function addDailyMealLine(e) {
    e.preventDefault()
    if (!dailyMealForm.product_id || !dailyMealForm.quantity || !dailyMealForm.unit_cost) return
    const p = kitchenProducts.find((x) => x.id === dailyMealForm.product_id)
    setDailyMealLines([
      ...dailyMealLines,
      {
        tempId: crypto.randomUUID(),
        product_id: p.id,
        product_name: p.name,
        unit: p.unit,
        quantity: Number(dailyMealForm.quantity),
        unit_cost: Number(dailyMealForm.unit_cost),
        expiration_date: dailyMealForm.expiration_date || null,
      },
    ])
    setDailyMealForm({ product_id: '', quantity: '', unit_cost: '', expiration_date: '' })
  }

  function removeDailyMealLine(tempId) {
    setDailyMealLines(dailyMealLines.filter((l) => l.tempId !== tempId))
  }

  async function handleSaveDailyMeals() {
    if (dailyMealLines.length === 0) return
    setDailyMealsSaving(true)
    setDailyMealsError('')

    for (const line of dailyMealLines) {
      // Same batch + ledger mechanics as a full Production run, just skipping
      // ingredient deduction — this is for items entered straight off the daily
      // kitchen report (quantity + cost only), not a formal recipe run.
      const { data: batch, error: batchErr } = await supabase
        .from('batches')
        .insert({
          product_id: line.product_id,
          source_type: 'KitchenProduction',
          received_quantity: line.quantity,
          unit_cost: line.unit_cost,
          expiration_date: line.expiration_date,
          received_date: dailyMealsDate,
        })
        .select()
        .single()

      if (batchErr) {
        setDailyMealsError(`${line.product_name}: ${batchErr.message}`)
        setDailyMealsSaving(false)
        loadAll()
        return
      }

      const { error: ledgerErr } = await supabase.from('inventory_ledger').insert({
        product_id: line.product_id,
        batch_id: batch.id,
        transaction_type: 'KitchenProduction',
        quantity_change: line.quantity,
        unit_cost_at_transaction: line.unit_cost,
        source_module: 'Kitchen',
        source_reference_id: batch.id,
      })

      if (ledgerErr) {
        setDailyMealsError(`${line.product_name}: inventory wasn't updated — ${ledgerErr.message}`)
        setDailyMealsSaving(false)
        loadAll()
        return
      }

      await supabase.from('products').update({ current_cost: line.unit_cost }).eq('id', line.product_id)
    }

    setDailyMealsSaving(false)
    setDailyMealLines([])
    setDailyMealsDate(today())
    loadAll()
  }

  // ---------- Kitchen Leftovers ----------
  async function handleSaveLeftover(e) {
    e.preventDefault()
    if (!leftoverForm.product_id || !leftoverForm.quantity) return
    setLeftoverSaving(true)
    setLeftoverError('')

    // Informational only — no batch_id, no inventory_ledger entry. This logs
    // the pattern over time (how much of an item consistently goes unsold)
    // for planning purposes. The REAL leftover — what's actually still in a
    // day's batch — is already visible directly in Inventory, since Daily
    // Available Meals now creates a real batch FIFO can track. Whatever's not
    // consumed there just carries over to tomorrow automatically, or can be
    // disposed via the usual Dispose flow if it won't keep.
    const { error } = await supabase.from('waste').insert({
      product_id: leftoverForm.product_id,
      waste_date: leftoverForm.leftover_date,
      quantity: Number(leftoverForm.quantity),
      reason: 'Daily Leftover',
      remarks: leftoverForm.notes.trim() || null,
    })

    setLeftoverSaving(false)
    if (error) {
      setLeftoverError(error.message)
      return
    }
    setLeftoverForm({ product_id: '', quantity: '', leftover_date: today(), notes: '' })
    loadAll()
  }

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold">Kitchen</h1>
          <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
            Recipes define the cost formula per dish. Daily Meals logs what was actually made each day — using that
            cost automatically when a recipe exists for it.
          </p>
        </div>
        {tab === 'recipes' && (
          <button
            onClick={openNewRecipe}
            className="flex items-center gap-1.5 rounded-md bg-[var(--color-ink)] px-3.5 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            <Plus size={16} />
            New recipe
          </button>
        )}
        {tab === 'ingredients' && (
          <div className="flex gap-2">
            <button
              onClick={handleDownloadIngredientProductTemplate}
              className="flex items-center gap-1.5 rounded-md border border-[var(--color-line)] px-3.5 py-2 text-sm font-medium hover:bg-[var(--color-paper)]"
            >
              <FileDown size={16} />
              Template
            </button>
            <button
              onClick={handleIngredientProductImportClick}
              className="flex items-center gap-1.5 rounded-md border border-[var(--color-line)] px-3.5 py-2 text-sm font-medium hover:bg-[var(--color-paper)]"
            >
              <Upload size={16} />
              Import CSV
            </button>
            <input
              ref={ingredientProductFileInputRef}
              type="file" accept=".csv"
              onChange={handleIngredientProductFileChange}
              className="hidden"
            />
            <button
              onClick={openNewIngredientProduct}
              className="flex items-center gap-1.5 rounded-md bg-[var(--color-ink)] px-3.5 py-2 text-sm font-medium text-white hover:opacity-90"
            >
              <Plus size={16} />
              New ingredient
            </button>
          </div>
        )}
      </div>

      <div className="mb-4 flex gap-1 border-b border-[var(--color-line)]">
        {[
          ['recipes', 'Recipes'],
          ['ingredients', 'Ingredients'],
          ['dailyMeals', 'Daily Meals'],
          ['leftovers', 'Leftovers'],
        ].map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm font-medium ${
              tab === t
                ? 'border-b-2 border-[var(--color-ink)] text-[var(--color-ink)]'
                : 'text-[var(--color-ink-soft)]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {errorMsg && !recipePanelOpen && (
        <div className="mb-4 rounded-md bg-[var(--color-rust-soft)] px-3.5 py-2.5 text-sm text-[var(--color-rust)]">
          {errorMsg}
        </div>
      )}

      {tab === 'recipes' ? (
        <div className="overflow-hidden rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)]">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[var(--color-line)] text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
              <tr>
                <SortableTh label="Finished product" sortKey="name" activeKey={recipeSortKey} activeDir={recipeSortDir} onSort={toggleRecipeSort} />
                <SortableTh label="Yield" sortKey="yield" activeKey={recipeSortKey} activeDir={recipeSortDir} onSort={toggleRecipeSort} />
                <SortableTh label="Ingredients" sortKey="ingredients" activeKey={recipeSortKey} activeDir={recipeSortDir} onSort={toggleRecipeSort} />
                <SortableTh label="Cost / unit" sortKey="cost" activeKey={recipeSortKey} activeDir={recipeSortDir} onSort={toggleRecipeSort} />
                <SortableTh label="Margin" sortKey="margin" activeKey={recipeSortKey} activeDir={recipeSortDir} onSort={toggleRecipeSort} />
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-[var(--color-ink-soft)]">Loading recipes…</td></tr>
              )}
              {!loading && sortedRecipes.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-[var(--color-ink-soft)]">No recipes yet — create one to start producing finished goods.</td></tr>
              )}
              {sortedRecipes.map((r) => {
                return (
                  <tr key={r.id} className="border-b border-[var(--color-line)] last:border-0">
                    <td className="px-4 py-3 font-medium">{r.product?.name}</td>
                    <td className="px-4 py-3">{r.yield_quantity} {r.product?.unit}</td>
                    <td className="px-4 py-3 text-[var(--color-ink-soft)]">{r.recipe_ingredients.length} items</td>
                    <td className="px-4 py-3">{r.perUnit.toFixed(2)}</td>
                    <td className="px-4 py-3">
                      {r.margin === null ? (
                        <StatusChip tone="neutral">no selling price set</StatusChip>
                      ) : (
                        <StatusChip tone={r.margin < 0 ? 'critical' : r.margin < 20 ? 'attention' : 'ok'}>
                          {r.margin.toFixed(0)}%
                        </StatusChip>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        <button
                          onClick={() => openEditRecipe(r)}
                          aria-label="Edit recipe"
                          className="rounded-md p-1 text-[var(--color-ink-soft)] hover:bg-[var(--color-line)]"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          onClick={() => deleteRecipe(r)}
                          aria-label="Delete recipe"
                          className="rounded-md p-1 text-[var(--color-ink-soft)] hover:bg-[var(--color-line)]"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : tab === 'ingredients' ? (
        <div className="overflow-hidden rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)]">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[var(--color-line)] text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Code</th>
                <th className="px-4 py-3">Unit</th>
                <th className="px-4 py-3">Cost</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-[var(--color-ink-soft)]">Loading ingredients…</td></tr>
              )}
              {!loading && ingredientProducts.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-[var(--color-ink-soft)]">No ingredients yet — add one to start building recipe ingredient lists.</td></tr>
              )}
              {ingredientProducts.map((p) => (
                <tr key={p.id} className="border-b border-[var(--color-line)] last:border-0">
                  <td className="px-4 py-3 font-medium">{p.name}</td>
                  <td className="font-mono px-4 py-3 text-xs text-[var(--color-ink-soft)]">{p.barcode}</td>
                  <td className="px-4 py-3">{p.unit || '—'}</td>
                  <td className="px-4 py-3">{Number(p.current_cost).toFixed(2)}</td>
                  <td className="px-4 py-3">
                    <StatusChip tone={p.status === 'active' ? 'ok' : 'neutral'}>{p.status}</StatusChip>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      <button
                        onClick={() => openEditIngredientProduct(p)}
                        aria-label="Edit"
                        className="rounded-md p-1 text-[var(--color-ink-soft)] hover:bg-[var(--color-line)]"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        onClick={() => toggleArchiveIngredientProduct(p)}
                        aria-label={p.status === 'active' ? 'Archive' : 'Restore'}
                        className="rounded-md p-1 text-[var(--color-ink-soft)] hover:bg-[var(--color-line)]"
                      >
                        <Archive size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : tab === 'dailyMeals' ? (
        <div>
          <div className="mb-4 rounded-md border border-dashed border-[var(--color-line)] p-4">
            <div className="mb-3 text-xs text-[var(--color-ink-soft)]">
              Quick entry straight off the daily kitchen report — quantity and cost only, no ingredient deduction.
              Creates a real batch, so FIFO and stock checks in Sales work against it like anything else.
            </div>
            {dailyMealsError && (
              <div className="mb-3 rounded-md bg-[var(--color-rust-soft)] px-2.5 py-1.5 text-xs text-[var(--color-rust)]">
                {dailyMealsError}
              </div>
            )}

            <Field label="Date" required>
              <input
                type="date" required max={today()}
                value={dailyMealsDate}
                onChange={(e) => setDailyMealsDate(e.target.value)}
                className="input mb-3 max-w-[200px]"
              />
            </Field>

            <div className="mb-3 overflow-hidden rounded-md border border-[var(--color-line)]">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-[var(--color-line)] text-xs text-[var(--color-ink-soft)]">
                  <tr>
                    <th className="px-3 py-2">Meal</th>
                    <th className="px-3 py-2">Qty</th>
                    <th className="px-3 py-2">Cost</th>
                    <th className="px-3 py-2">Expiry</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {dailyMealLines.length === 0 && (
                    <tr><td colSpan={5} className="px-3 py-4 text-center text-[var(--color-ink-soft)]">No meals added yet.</td></tr>
                  )}
                  {dailyMealLines.map((l) => (
                    <tr key={l.tempId} className="border-b border-[var(--color-line)] last:border-0">
                      <td className="px-3 py-2">{l.product_name}</td>
                      <td className="px-3 py-2">{l.quantity} {l.unit}</td>
                      <td className="px-3 py-2">{l.unit_cost.toFixed(2)}</td>
                      <td className="px-3 py-2 text-[var(--color-ink-soft)]">{l.expiration_date || '—'}</td>
                      <td className="px-3 py-2">
                        <button
                          onClick={() => removeDailyMealLine(l.tempId)}
                          aria-label="Remove"
                          className="rounded-md p-1 text-[var(--color-ink-soft)] hover:bg-[var(--color-line)]"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <form onSubmit={addDailyMealLine} className="grid grid-cols-4 gap-3">
              <Field label="Meal" required>
                <ProductPicker
                  products={kitchenProducts}
                  value={dailyMealForm.product_id}
                  onChange={onDailyMealProductPick}
                />
              </Field>
              <Field label="Quantity" required>
                <input
                  type="number" step="0.001" min="0" required
                  value={dailyMealForm.quantity}
                  onChange={(e) => setDailyMealForm({ ...dailyMealForm, quantity: e.target.value })}
                  className="input"
                />
              </Field>
              <Field label="Cost per unit" required>
                <input
                  type="number" step="0.01" min="0" required
                  value={dailyMealForm.unit_cost}
                  onChange={(e) => setDailyMealForm({ ...dailyMealForm, unit_cost: e.target.value })}
                  className="input"
                />
                {recipes.some((r) => r.product_id === dailyMealForm.product_id) && (
                  <span className="mt-1 block text-[10px] text-[var(--color-herb)]">from recipe — editable</span>
                )}
              </Field>
              <Field label="Expiry (optional)">
                <input
                  type="date"
                  value={dailyMealForm.expiration_date}
                  onChange={(e) => setDailyMealForm({ ...dailyMealForm, expiration_date: e.target.value })}
                  className="input"
                />
              </Field>
              <button
                type="submit"
                className="col-span-4 flex items-center justify-center gap-1.5 rounded-md border border-[var(--color-ink)] py-2 text-sm font-medium"
              >
                <Plus size={15} />
                Add meal
              </button>
            </form>
          </div>

          <button
            onClick={handleSaveDailyMeals}
            disabled={dailyMealsSaving || dailyMealLines.length === 0}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--color-herb)] py-2.5 text-sm font-medium text-white disabled:opacity-60"
          >
            <Check size={15} />
            {dailyMealsSaving ? 'Saving…' : `Save ${dailyMealLines.length} meal${dailyMealLines.length === 1 ? '' : 's'} for ${dailyMealsDate}`}
          </button>
        </div>
      ) : (
        <div>
          <form
            onSubmit={handleSaveLeftover}
            className="mb-5 rounded-md border border-dashed border-[var(--color-line)] p-4"
          >
            <div className="mb-3 text-xs text-[var(--color-ink-soft)]">
              Tracks how much of a kitchen item goes unsold each day — helps spot whether the daily serving count
              needs adjusting. This is informational only; it doesn't move inventory.
            </div>
            {leftoverError && (
              <div className="mb-3 rounded-md bg-[var(--color-rust-soft)] px-2.5 py-1.5 text-xs text-[var(--color-rust)]">
                {leftoverError}
              </div>
            )}
            <div className="grid grid-cols-4 gap-3">
              <Field label="Date" required>
                <input
                  type="date" required max={today()}
                  value={leftoverForm.leftover_date}
                  onChange={(e) => setLeftoverForm({ ...leftoverForm, leftover_date: e.target.value })}
                  className="input"
                />
              </Field>
              <Field label="Kitchen product" required>
                <ProductPicker
                  products={kitchenProducts}
                  value={leftoverForm.product_id}
                  onChange={(id) => setLeftoverForm({ ...leftoverForm, product_id: id })}
                />
              </Field>
              <Field label="Leftover qty" required>
                <input
                  type="number" step="0.001" min="0" required
                  value={leftoverForm.quantity}
                  onChange={(e) => setLeftoverForm({ ...leftoverForm, quantity: e.target.value })}
                  className="input"
                />
              </Field>
              <Field label="Notes">
                <input
                  value={leftoverForm.notes}
                  onChange={(e) => setLeftoverForm({ ...leftoverForm, notes: e.target.value })}
                  className="input"
                />
              </Field>
            </div>
            <button
              type="submit"
              disabled={leftoverSaving}
              className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--color-ink)] py-2 text-sm font-medium text-white disabled:opacity-60"
            >
              <Plus size={15} />
              {leftoverSaving ? 'Saving…' : 'Record leftover'}
            </button>
          </form>

          <div className="overflow-hidden rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)]">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-[var(--color-line)] text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
                <tr>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Product</th>
                  <th className="px-4 py-3">Leftover qty</th>
                  <th className="px-4 py-3">Notes</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={4} className="px-4 py-8 text-center text-[var(--color-ink-soft)]">Loading…</td></tr>
                )}
                {!loading && leftovers.length === 0 && (
                  <tr><td colSpan={4} className="px-4 py-10 text-center text-[var(--color-ink-soft)]">No leftovers recorded yet.</td></tr>
                )}
                {leftovers.map((w) => (
                  <tr key={w.id} className="border-b border-[var(--color-line)] last:border-0">
                    <td className="px-4 py-3">{w.waste_date}</td>
                    <td className="px-4 py-3 font-medium">{w.product?.name}</td>
                    <td className="px-4 py-3">{w.quantity} {w.product?.unit}</td>
                    <td className="px-4 py-3 text-[var(--color-ink-soft)]">{w.remarks || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recipe builder panel */}
      <SlidePanel open={recipePanelOpen} title={editingRecipeId ? 'Edit recipe' : 'New recipe'} onClose={() => setRecipePanelOpen(false)}>
        {errorMsg && (
          <div className="mb-4 rounded-md bg-[var(--color-rust-soft)] px-3.5 py-2.5 text-sm text-[var(--color-rust)]">
            {errorMsg}
          </div>
        )}
        <form onSubmit={saveRecipe} className="space-y-4">
          <Field label="Finished product" required>
            <ProductPicker
              products={kitchenProducts}
              value={recipeForm.product_id}
              onChange={(id) => setRecipeForm({ ...recipeForm, product_id: id })}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Yield quantity" required>
              <input
                type="number" step="0.01" min="0.01" required
                value={recipeForm.yield_quantity}
                onChange={(e) => setRecipeForm({ ...recipeForm, yield_quantity: e.target.value })}
                className="input"
              />
            </Field>
            <Field label="Prep loss %">
              <input
                type="number" step="0.1" min="0" max="99"
                value={recipeForm.prep_loss_pct}
                onChange={(e) => setRecipeForm({ ...recipeForm, prep_loss_pct: e.target.value })}
                className="input"
              />
            </Field>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Field label="Packaging cost">
              <input type="number" step="0.01" min="0" value={recipeForm.packaging_cost}
                onChange={(e) => setRecipeForm({ ...recipeForm, packaging_cost: e.target.value })} className="input" />
            </Field>
            <Field label="Labor cost">
              <input type="number" step="0.01" min="0" value={recipeForm.labor_cost}
                onChange={(e) => setRecipeForm({ ...recipeForm, labor_cost: e.target.value })} className="input" />
            </Field>
            <Field label="Overhead cost">
              <input type="number" step="0.01" min="0" value={recipeForm.overhead_cost}
                onChange={(e) => setRecipeForm({ ...recipeForm, overhead_cost: e.target.value })} className="input" />
            </Field>
          </div>

          <div className="text-xs font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">Ingredients</div>

          <div className="overflow-hidden rounded-md border border-[var(--color-line)]">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-[var(--color-line)] text-xs text-[var(--color-ink-soft)]">
                <tr>
                  <th className="px-3 py-2">Ingredient</th>
                  <th className="px-3 py-2">Qty / yield</th>
                  <th className="px-3 py-2">Cost</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {recipeIngredients.length === 0 && (
                  <tr><td colSpan={4} className="px-3 py-4 text-center text-[var(--color-ink-soft)]">No ingredients yet.</td></tr>
                )}
                {recipeIngredients.map((i) => {
                  const needsConversion = i.unit && i.product_unit && i.unit !== i.product_unit
                  const converted = convertQuantity(i.quantity_per_yield, i.unit, i.product_unit)
                  const canConvert = !needsConversion || converted !== null
                  const effectiveQty = converted !== null ? converted : i.quantity_per_yield
                  const lineCost = effectiveQty * i.current_cost
                  return (
                    <tr key={i.tempId} className="border-b border-[var(--color-line)] last:border-0">
                      <td className="px-3 py-2">{i.name}</td>
                      <td className="px-3 py-2">
                        {i.quantity_per_yield} {i.unit}
                        {needsConversion && !canConvert && (
                          <span
                            title={`Costed per ${i.product_unit} — can't auto-convert from ${i.unit}, so this line's cost may be off`}
                            className="ml-1.5 inline-flex items-center rounded-full bg-[var(--color-amber-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-amber)]"
                          >
                            check unit
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-[var(--color-ink-soft)]">
                        {lineCost.toFixed(2)}
                        {needsConversion && canConvert && (
                          <span className="ml-1 text-[10px]">({effectiveQty.toFixed(2)} {i.product_unit})</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <button onClick={() => removeIngredientFromRecipe(i.tempId)} aria-label="Remove ingredient"
                          className="rounded-md p-1 text-[var(--color-ink-soft)] hover:bg-[var(--color-line)]">
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="space-y-3 rounded-md border border-dashed border-[var(--color-line)] p-3">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleDownloadIngredientTemplate}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-[var(--color-line)] py-2 text-xs font-medium hover:bg-[var(--color-paper)]"
              >
                <FileDown size={13} />
                Template
              </button>
              <button
                type="button"
                onClick={() => ingredientFileInputRef.current?.click()}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-[var(--color-line)] py-2 text-xs font-medium hover:bg-[var(--color-paper)]"
              >
                <Upload size={13} />
                Import ingredients CSV
              </button>
              <input
                ref={ingredientFileInputRef}
                type="file"
                accept=".csv"
                onChange={handleIngredientFileChange}
                className="hidden"
              />
            </div>

            <Field label="Add ingredient">
              <ProductPicker
                products={products}
                value={ingredientForm.ingredient_product_id}
                onChange={(id) =>
                  setIngredientForm({
                    ...ingredientForm,
                    ingredient_product_id: id,
                    unit: products.find((p) => p.id === id)?.unit ?? '',
                  })
                }
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Quantity per yield">
                <input
                  type="number" step="0.001" min="0"
                  value={ingredientForm.quantity_per_yield}
                  onChange={(e) => setIngredientForm({ ...ingredientForm, quantity_per_yield: e.target.value })}
                  className="input"
                />
              </Field>
              <Field label="Unit">
                <select
                  value={ingredientForm.unit}
                  onChange={(e) => setIngredientForm({ ...ingredientForm, unit: e.target.value })}
                  className="input"
                >
                  {ingredientForm.unit && !RECIPE_UNITS.includes(ingredientForm.unit) && (
                    <option value={ingredientForm.unit}>{ingredientForm.unit} (product's unit)</option>
                  )}
                  {RECIPE_UNITS.map((u) => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                </select>
              </Field>
            </div>
            <button onClick={addIngredientToRecipe}
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--color-ink)] py-2 text-sm font-medium">
              <Plus size={15} /> Add ingredient
            </button>
          </div>

          <div className="rounded-md bg-[var(--color-paper)] p-3 text-sm">
            <div className="flex justify-between"><span className="text-[var(--color-ink-soft)]">Recipe cost</span><span>{livePreview.total.toFixed(2)}</span></div>
            <div className="mt-1 flex justify-between font-medium"><span>Cost per unit</span><span>{livePreview.perUnit.toFixed(2)}</span></div>
          </div>

          <button type="submit" disabled={savingRecipe}
            className="w-full rounded-md bg-[var(--color-ink)] py-2.5 text-sm font-medium text-white disabled:opacity-60">
            {savingRecipe ? 'Saving…' : editingRecipeId ? 'Save changes' : 'Save recipe'}
          </button>
        </form>
      </SlidePanel>

      <SlidePanel
        open={ingredientImportPanelOpen}
        title="Import ingredients"
        onClose={() => setIngredientImportPanelOpen(false)}
      >
        <div className="mb-4 grid grid-cols-2 gap-3">
          <div className="rounded-md border border-[var(--color-line)] bg-[var(--color-paper)] p-3 text-center">
            <div className="font-display text-xl font-semibold text-[var(--color-herb)]">{ingredientImportValid.length}</div>
            <div className="text-xs text-[var(--color-ink-soft)]">ready to add</div>
          </div>
          <div className="rounded-md border border-[var(--color-line)] bg-[var(--color-paper)] p-3 text-center">
            <div className="font-display text-xl font-semibold text-[var(--color-rust)]">{ingredientImportSkipped.length}</div>
            <div className="text-xs text-[var(--color-ink-soft)]">skipped</div>
          </div>
        </div>

        {ingredientImportSkipped.length > 0 && (
          <div className="mb-4">
            <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">Skipped rows</div>
            <div className="max-h-48 space-y-1 overflow-y-auto">
              {ingredientImportSkipped.map((s, i) => (
                <div key={i} className="rounded-md bg-[var(--color-rust-soft)] px-2.5 py-1.5 text-xs text-[var(--color-rust)]">
                  Row {s.rowNum}: {s.reason}
                </div>
              ))}
            </div>
          </div>
        )}

        {ingredientImportValid.length > 0 && (
          <div className="mb-4">
            <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">Preview (first 5)</div>
            <div className="space-y-1">
              {ingredientImportValid.slice(0, 5).map((i) => (
                <div key={i.tempId} className="rounded-md border border-[var(--color-line)] px-2.5 py-1.5 text-xs">
                  <span className="font-medium">{i.name}</span> — {i.quantity_per_yield} {i.unit}
                </div>
              ))}
              {ingredientImportValid.length > 5 && (
                <div className="text-xs text-[var(--color-ink-soft)]">…and {ingredientImportValid.length - 5} more</div>
              )}
            </div>
          </div>
        )}

        <button
          onClick={handleConfirmIngredientImport}
          disabled={ingredientImportValid.length === 0}
          className="w-full rounded-md bg-[var(--color-ink)] py-2.5 text-sm font-medium text-white disabled:opacity-60"
        >
          Add {ingredientImportValid.length} ingredient{ingredientImportValid.length === 1 ? '' : 's'} to this recipe
        </button>
      </SlidePanel>

      <SlidePanel
        open={ingredientProductPanelOpen}
        title={editingIngredientId ? 'Edit ingredient' : 'New ingredient'}
        onClose={() => setIngredientProductPanelOpen(false)}
      >
        {ingredientProductError && (
          <div className="mb-4 rounded-md bg-[var(--color-rust-soft)] px-3.5 py-2.5 text-sm text-[var(--color-rust)]">
            {ingredientProductError}
          </div>
        )}
        <form onSubmit={handleSaveIngredientProduct} className="space-y-4">
          <Field label="Name" required>
            <input
              required
              value={ingredientProductForm.name}
              onChange={(e) => setIngredientProductForm({ ...ingredientProductForm, name: e.target.value })}
              className="input"
              placeholder="e.g. Pork"
            />
          </Field>
          <Field label="Internal code (optional)">
            <input
              value={ingredientProductForm.barcode}
              onChange={(e) => setIngredientProductForm({ ...ingredientProductForm, barcode: e.target.value })}
              className="input"
              placeholder="Leave blank to auto-generate — no real barcode needed"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Unit">
              <select
                value={ingredientProductForm.unit}
                onChange={(e) => setIngredientProductForm({ ...ingredientProductForm, unit: e.target.value })}
                className="input"
              >
                <option value="">Select…</option>
                {RECIPE_UNITS.map((u) => (
                  <option key={u} value={u}>{u}</option>
                ))}
              </select>
            </Field>
            <Field label="Cost per unit" required>
              <input
                type="number" step="0.01" min="0" required
                value={ingredientProductForm.current_cost}
                onChange={(e) => setIngredientProductForm({ ...ingredientProductForm, current_cost: e.target.value })}
                className="input"
                placeholder="e.g. 97.50"
              />
            </Field>
          </div>
          <button
            type="submit"
            disabled={savingIngredientProduct}
            className="w-full rounded-md bg-[var(--color-ink)] py-2.5 text-sm font-medium text-white disabled:opacity-60"
          >
            {savingIngredientProduct ? 'Saving…' : editingIngredientId ? 'Save changes' : 'Add ingredient'}
          </button>
        </form>
      </SlidePanel>

      <SlidePanel
        open={ingredientProductImportOpen}
        title="Import ingredients"
        onClose={() => setIngredientProductImportOpen(false)}
      >
        <div className="mb-4 grid grid-cols-2 gap-3">
          <div className="rounded-md border border-[var(--color-line)] bg-[var(--color-paper)] p-3 text-center">
            <div className="font-display text-xl font-semibold text-[var(--color-herb)]">{ingredientProductImportValid.length}</div>
            <div className="text-xs text-[var(--color-ink-soft)]">ready to import</div>
          </div>
          <div className="rounded-md border border-[var(--color-line)] bg-[var(--color-paper)] p-3 text-center">
            <div className="font-display text-xl font-semibold text-[var(--color-rust)]">{ingredientProductImportSkipped.length}</div>
            <div className="text-xs text-[var(--color-ink-soft)]">skipped</div>
          </div>
        </div>

        {ingredientProductImportSkipped.length > 0 && (
          <div className="mb-4">
            <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">Skipped rows</div>
            <div className="max-h-48 space-y-1 overflow-y-auto">
              {ingredientProductImportSkipped.map((s, i) => (
                <div key={i} className="rounded-md bg-[var(--color-rust-soft)] px-2.5 py-1.5 text-xs text-[var(--color-rust)]">
                  Row {s.rowNum}: {s.reason}
                </div>
              ))}
            </div>
          </div>
        )}

        {ingredientProductImportValid.length > 0 && (
          <div className="mb-4">
            <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">Preview (first 5)</div>
            <div className="space-y-1">
              {ingredientProductImportValid.slice(0, 5).map((r) => (
                <div key={r.tempId} className="rounded-md border border-[var(--color-line)] px-2.5 py-1.5 text-xs">
                  <span className="font-medium">{r.name}</span> — {r.current_cost.toFixed(2)} / {r.unit || 'unit'}
                </div>
              ))}
              {ingredientProductImportValid.length > 5 && (
                <div className="text-xs text-[var(--color-ink-soft)]">…and {ingredientProductImportValid.length - 5} more</div>
              )}
            </div>
          </div>
        )}

        <button
          onClick={handleConfirmIngredientProductImport}
          disabled={ingredientProductImporting || ingredientProductImportValid.length === 0}
          className="w-full rounded-md bg-[var(--color-ink)] py-2.5 text-sm font-medium text-white disabled:opacity-60"
        >
          {ingredientProductImporting ? 'Importing…' : `Import ${ingredientProductImportValid.length} ingredient${ingredientProductImportValid.length === 1 ? '' : 's'}`}
        </button>
      </SlidePanel>
    </div>
  )
}

function Field({ label, required, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[var(--color-ink-soft)]">
        {label} {required && <span className="text-[var(--color-rust)]">*</span>}
      </span>
      {children}
    </label>
  )
}
