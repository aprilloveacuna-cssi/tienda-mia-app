import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2, AlertTriangle, Check } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import SlidePanel from '../components/SlidePanel'
import StatusChip from '../components/StatusChip'
import SortableTh from '../components/SortableTh'
import { useSort, sortRows } from '../lib/sort'

const EMPTY_RECIPE_FORM = {
  product_id: '',
  yield_quantity: '1',
  prep_loss_pct: '0',
  packaging_cost: '0',
  labor_cost: '0',
  overhead_cost: '0',
}
const EMPTY_INGREDIENT_FORM = { ingredient_product_id: '', quantity_per_yield: '', unit: '' }

function recipeCost(recipe, ingredients) {
  const rawCost = ingredients.reduce((sum, i) => sum + i.quantity_per_yield * i.current_cost, 0)
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
  const [productions, setProductions] = useState([])
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

  const { sortKey: prodSortKey, sortDir: prodSortDir, toggleSort: toggleProdSort } = useSort('production_date', 'desc')
  function prodSortAccessor(row, key) {
    if (key === 'product') return row.recipe?.product?.name
    if (key === 'quantity_produced' || key === 'cost_per_unit' || key === 'total_cost') return Number(row[key] ?? 0)
    return row[key]
  }
  const sortedProductions = sortRows(productions, prodSortKey, prodSortDir, prodSortAccessor)

  // Recipe builder panel
  const [recipePanelOpen, setRecipePanelOpen] = useState(false)
  const [recipeForm, setRecipeForm] = useState(EMPTY_RECIPE_FORM)
  const [recipeIngredients, setRecipeIngredients] = useState([])
  const [ingredientForm, setIngredientForm] = useState(EMPTY_INGREDIENT_FORM)
  const [savingRecipe, setSavingRecipe] = useState(false)

  // Production panel
  const [prodPanelOpen, setProdPanelOpen] = useState(false)
  const [selectedRecipeId, setSelectedRecipeId] = useState('')
  const [quantityToProduce, setQuantityToProduce] = useState('')
  const [prodPreview, setProdPreview] = useState(null) // { perIngredient: [...], shortages: [...] }
  const [savingProduction, setSavingProduction] = useState(false)

  async function loadAll() {
    setLoading(true)
    setErrorMsg('')
    const [productsRes, recipesRes, productionsRes] = await Promise.all([
      supabase.from('products').select('id, sku, name, unit, current_cost, selling_price').eq('status', 'active').order('name'),
      supabase
        .from('recipes')
        .select('*, product:products(name, sku, unit, selling_price), recipe_ingredients(*, ingredient:products(name, sku, unit, current_cost))')
        .eq('status', 'active')
        .order('created_at', { ascending: false }),
      supabase
        .from('kitchen_production')
        .select('*, recipe:recipes(product:products(name, sku, unit))')
        .order('created_at', { ascending: false }),
    ])

    if (productsRes.error || recipesRes.error || productionsRes.error) {
      setErrorMsg('Could not reach Supabase. Check your .env values and that migrations have run.')
      setLoading(false)
      return
    }
    setProducts(productsRes.data ?? [])
    setRecipes(recipesRes.data ?? [])
    setProductions(productionsRes.data ?? [])
    setLoading(false)
  }

  useEffect(() => {
    loadAll()
  }, [])

  // ---------- Recipe builder ----------
  function openNewRecipe() {
    setRecipeForm(EMPTY_RECIPE_FORM)
    setRecipeIngredients([])
    setIngredientForm(EMPTY_INGREDIENT_FORM)
    setErrorMsg('')
    setRecipePanelOpen(true)
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
      },
    ])
    setIngredientForm(EMPTY_INGREDIENT_FORM)
  }

  function removeIngredientFromRecipe(tempId) {
    setRecipeIngredients(recipeIngredients.filter((i) => i.tempId !== tempId))
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

    const { data: recipe, error: recipeErr } = await supabase
      .from('recipes')
      .insert({
        product_id: recipeForm.product_id,
        yield_quantity: Number(recipeForm.yield_quantity),
        prep_loss_pct: Number(recipeForm.prep_loss_pct),
        packaging_cost: Number(recipeForm.packaging_cost),
        labor_cost: Number(recipeForm.labor_cost),
        overhead_cost: Number(recipeForm.overhead_cost),
      })
      .select()
      .single()

    if (recipeErr) {
      setErrorMsg(recipeErr.message)
      setSavingRecipe(false)
      return
    }

    const ingredientRows = recipeIngredients.map((i) => ({
      recipe_id: recipe.id,
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

  // ---------- Production ----------
  function openNewProduction() {
    setSelectedRecipeId('')
    setQuantityToProduce('')
    setProdPreview(null)
    setErrorMsg('')
    setProdPanelOpen(true)
  }

  async function computePreview(recipeId, qty) {
    const recipe = recipes.find((r) => r.id === recipeId)
    if (!recipe || !qty || Number(qty) <= 0) {
      setProdPreview(null)
      return
    }
    const scale = Number(qty) / Number(recipe.yield_quantity)
    const lossFactor = 1 - Number(recipe.prep_loss_pct || 0) / 100

    const perIngredient = []
    for (const ri of recipe.recipe_ingredients) {
      const needed = (ri.quantity_per_yield * scale) / (lossFactor > 0 ? lossFactor : 1)

      const { data: batches } = await supabase
        .from('batch_cache')
        .select('*')
        .eq('product_id', ri.ingredient_product_id)
        .gt('remaining_quantity', 0)
        .order('fifo_sequence')

      let remaining = needed
      const consumption = []
      for (const b of batches ?? []) {
        if (remaining <= 0) break
        const take = Math.min(Number(b.remaining_quantity), remaining)
        if (take > 0) {
          consumption.push({ batch_id: b.batch_id, qty: take, unit_cost: Number(b.unit_cost) })
          remaining -= take
        }
      }
      const totalAvailable = (batches ?? []).reduce((s, b) => s + Number(b.remaining_quantity), 0)

      perIngredient.push({
        ingredient_product_id: ri.ingredient_product_id,
        name: ri.ingredient.name,
        unit: ri.ingredient.unit,
        needed,
        totalAvailable,
        satisfied: remaining <= 0,
        consumption,
      })
    }

    setProdPreview({ perIngredient, scale })
  }

  function onRecipePick(recipeId) {
    setSelectedRecipeId(recipeId)
    computePreview(recipeId, quantityToProduce)
  }

  function onQuantityChange(qty) {
    setQuantityToProduce(qty)
    computePreview(selectedRecipeId, qty)
  }

  const shortages = useMemo(
    () => (prodPreview ? prodPreview.perIngredient.filter((i) => !i.satisfied) : []),
    [prodPreview]
  )

  async function completeProduction() {
    if (!prodPreview || shortages.length > 0 || !quantityToProduce) return
    setSavingProduction(true)
    setErrorMsg('')

    const recipe = recipes.find((r) => r.id === selectedRecipeId)
    const qty = Number(quantityToProduce)
    const scale = prodPreview.scale

    const actualIngredientCost = prodPreview.perIngredient.reduce(
      (sum, i) => sum + i.consumption.reduce((s, c) => s + c.qty * c.unit_cost, 0),
      0
    )
    const overheadScaled =
      (Number(recipe.packaging_cost) + Number(recipe.labor_cost) + Number(recipe.overhead_cost)) * scale
    const totalCost = actualIngredientCost + overheadScaled
    const costPerUnit = totalCost / qty

    // 1. Create the finished-good batch
    const { data: batch, error: batchErr } = await supabase
      .from('batches')
      .insert({
        product_id: recipe.product_id,
        source_type: 'KitchenProduction',
        received_quantity: qty,
        unit_cost: costPerUnit,
        received_date: new Date().toISOString().slice(0, 10),
      })
      .select()
      .single()

    if (batchErr) {
      setErrorMsg(batchErr.message)
      setSavingProduction(false)
      return
    }

    // 2. Create the production record
    const { data: production, error: prodErr } = await supabase
      .from('kitchen_production')
      .insert({
        recipe_id: recipe.id,
        quantity_produced: qty,
        finished_batch_id: batch.id,
        total_cost: totalCost,
        cost_per_unit: costPerUnit,
      })
      .select()
      .single()

    if (prodErr) {
      setErrorMsg(prodErr.message)
      setSavingProduction(false)
      return
    }

    // 3. Ledger: production (stock in) + ingredient consumption (stock out, one row per batch drawn from)
    const ledgerRows = [
      {
        product_id: recipe.product_id,
        batch_id: batch.id,
        transaction_type: 'KitchenProduction',
        quantity_change: qty,
        unit_cost_at_transaction: costPerUnit,
        source_module: 'Kitchen',
        source_reference_id: production.id,
      },
      ...prodPreview.perIngredient.flatMap((i) =>
        i.consumption.map((c) => ({
          product_id: i.ingredient_product_id,
          batch_id: c.batch_id,
          transaction_type: 'KitchenConsumption',
          quantity_change: -c.qty,
          unit_cost_at_transaction: c.unit_cost,
          source_module: 'Kitchen',
          source_reference_id: production.id,
        }))
      ),
    ]
    const { error: ledgerErr } = await supabase.from('inventory_ledger').insert(ledgerRows)
    if (ledgerErr) {
      setErrorMsg(`Production recorded but inventory wasn't fully updated: ${ledgerErr.message}`)
      setSavingProduction(false)
      loadAll()
      return
    }

    // 4. Finished good's current cost reflects this production run
    await supabase.from('products').update({ current_cost: costPerUnit }).eq('id', recipe.product_id)

    setSavingProduction(false)
    setProdPanelOpen(false)
    loadAll()
  }

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold">Kitchen</h1>
          <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
            Recipes define the cost formula. Production runs actually consume ingredients and create finished-good stock.
          </p>
        </div>
        <button
          onClick={tab === 'recipes' ? openNewRecipe : openNewProduction}
          className="flex items-center gap-1.5 rounded-md bg-[var(--color-ink)] px-3.5 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          <Plus size={16} />
          {tab === 'recipes' ? 'New recipe' : 'New production'}
        </button>
      </div>

      <div className="mb-4 flex gap-1 border-b border-[var(--color-line)]">
        {['recipes', 'production'].map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm font-medium capitalize ${
              tab === t
                ? 'border-b-2 border-[var(--color-ink)] text-[var(--color-ink)]'
                : 'text-[var(--color-ink-soft)]'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {errorMsg && !recipePanelOpen && !prodPanelOpen && (
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
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-[var(--color-ink-soft)]">Loading recipes…</td></tr>
              )}
              {!loading && sortedRecipes.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-10 text-center text-[var(--color-ink-soft)]">No recipes yet — create one to start producing finished goods.</td></tr>
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
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)]">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[var(--color-line)] text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
              <tr>
                <SortableTh label="Production #" sortKey="production_number" activeKey={prodSortKey} activeDir={prodSortDir} onSort={toggleProdSort} />
                <SortableTh label="Date" sortKey="production_date" activeKey={prodSortKey} activeDir={prodSortDir} onSort={toggleProdSort} />
                <SortableTh label="Product" sortKey="product" activeKey={prodSortKey} activeDir={prodSortDir} onSort={toggleProdSort} />
                <SortableTh label="Qty produced" sortKey="quantity_produced" activeKey={prodSortKey} activeDir={prodSortDir} onSort={toggleProdSort} />
                <SortableTh label="Cost / unit" sortKey="cost_per_unit" activeKey={prodSortKey} activeDir={prodSortDir} onSort={toggleProdSort} />
                <SortableTh label="Total cost" sortKey="total_cost" activeKey={prodSortKey} activeDir={prodSortDir} onSort={toggleProdSort} />
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-[var(--color-ink-soft)]">Loading production runs…</td></tr>
              )}
              {!loading && sortedProductions.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-[var(--color-ink-soft)]">No production runs yet.</td></tr>
              )}
              {sortedProductions.map((p) => (
                <tr key={p.id} className="border-b border-[var(--color-line)] last:border-0">
                  <td className="font-mono px-4 py-3 text-xs text-[var(--color-ink-soft)]">{p.production_number}</td>
                  <td className="px-4 py-3">{p.production_date}</td>
                  <td className="px-4 py-3 font-medium">{p.recipe?.product?.name}</td>
                  <td className="px-4 py-3">{p.quantity_produced} {p.recipe?.product?.unit}</td>
                  <td className="px-4 py-3">{Number(p.cost_per_unit).toFixed(2)}</td>
                  <td className="px-4 py-3">{Number(p.total_cost).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Recipe builder panel */}
      <SlidePanel open={recipePanelOpen} title="New recipe" onClose={() => setRecipePanelOpen(false)}>
        {errorMsg && (
          <div className="mb-4 rounded-md bg-[var(--color-rust-soft)] px-3.5 py-2.5 text-sm text-[var(--color-rust)]">
            {errorMsg}
          </div>
        )}
        <form onSubmit={saveRecipe} className="space-y-4">
          <Field label="Finished product" required>
            <select
              required
              value={recipeForm.product_id}
              onChange={(e) => setRecipeForm({ ...recipeForm, product_id: e.target.value })}
              className="input"
            >
              <option value="">Select a product…</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>
              ))}
            </select>
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
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {recipeIngredients.length === 0 && (
                  <tr><td colSpan={3} className="px-3 py-4 text-center text-[var(--color-ink-soft)]">No ingredients yet.</td></tr>
                )}
                {recipeIngredients.map((i) => (
                  <tr key={i.tempId} className="border-b border-[var(--color-line)] last:border-0">
                    <td className="px-3 py-2">{i.name}</td>
                    <td className="px-3 py-2">{i.quantity_per_yield} {i.unit}</td>
                    <td className="px-3 py-2">
                      <button onClick={() => removeIngredientFromRecipe(i.tempId)} aria-label="Remove ingredient"
                        className="rounded-md p-1 text-[var(--color-ink-soft)] hover:bg-[var(--color-line)]">
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="space-y-3 rounded-md border border-dashed border-[var(--color-line)] p-3">
            <Field label="Add ingredient">
              <select
                value={ingredientForm.ingredient_product_id}
                onChange={(e) => setIngredientForm({ ...ingredientForm, ingredient_product_id: e.target.value, unit: products.find(p=>p.id===e.target.value)?.unit ?? '' })}
                className="input"
              >
                <option value="">Select a product…</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Quantity per yield">
              <input
                type="number" step="0.001" min="0"
                value={ingredientForm.quantity_per_yield}
                onChange={(e) => setIngredientForm({ ...ingredientForm, quantity_per_yield: e.target.value })}
                className="input"
              />
            </Field>
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
            {savingRecipe ? 'Saving…' : 'Save recipe'}
          </button>
        </form>
      </SlidePanel>

      {/* Production panel */}
      <SlidePanel open={prodPanelOpen} title="New production run" onClose={() => setProdPanelOpen(false)}>
        {errorMsg && (
          <div className="mb-4 rounded-md bg-[var(--color-rust-soft)] px-3.5 py-2.5 text-sm text-[var(--color-rust)]">
            {errorMsg}
          </div>
        )}
        <div className="space-y-4">
          <Field label="Recipe" required>
            <select value={selectedRecipeId} onChange={(e) => onRecipePick(e.target.value)} className="input">
              <option value="">Select a recipe…</option>
              {recipes.map((r) => (
                <option key={r.id} value={r.id}>{r.product?.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Quantity to produce" required>
            <input
              type="number" step="0.01" min="0"
              value={quantityToProduce}
              onChange={(e) => onQuantityChange(e.target.value)}
              className="input"
            />
          </Field>

          {prodPreview && (
            <div>
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">
                Ingredients this will consume
              </div>
              <div className="space-y-2">
                {prodPreview.perIngredient.map((i) => (
                  <div key={i.ingredient_product_id} className="rounded-md border border-[var(--color-line)] p-2.5 text-sm">
                    <div className="flex justify-between">
                      <span>{i.name}</span>
                      <span>{i.needed.toFixed(2)} {i.unit} needed</span>
                    </div>
                    {!i.satisfied && (
                      <div className="mt-1 flex items-center gap-1.5 text-xs text-[var(--color-rust)]">
                        <AlertTriangle size={13} />
                        Only {i.totalAvailable.toFixed(2)} {i.unit} available
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <button
            onClick={completeProduction}
            disabled={savingProduction || !prodPreview || shortages.length > 0}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--color-herb)] py-2.5 text-sm font-medium text-white disabled:opacity-60"
          >
            <Check size={15} />
            {savingProduction ? 'Producing…' : 'Complete production'}
          </button>
        </div>
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
