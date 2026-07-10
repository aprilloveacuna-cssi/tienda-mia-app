# Tienda Mia — Inventory & Retail Ops

Phase 1 scaffold: Products module fully wired to Supabase, shell navigation for
every other module, and the full database schema (Phases 1–3) ready to run.

## 1. Create the Supabase project

1. Go to [supabase.com](https://supabase.com) and create a new project (free tier is fine to start).
2. In the SQL Editor, run the files in `supabase/migrations/` **in order** (0001 → 0008).
   Each one is commented — read `0008_security.sql` before running it, it explains a
   deliberate temporary tradeoff around access control.
3. In **Settings → API**, copy the **Project URL** and **anon public key**.

## 2. Configure the app

```bash
cp .env.example .env
# then paste your Project URL and anon key into .env
```

## 3. Run it locally

```bash
npm install
npm run dev
```

Opens at `http://localhost:5173`. The Products page is fully functional —
add a product, search, edit, archive/restore. Every other module (Purchases,
Inventory, Sales, Kitchen, Settings) shows what it needs before it can go live.

## 4. Deploy

Push this to a GitHub repo, then import it in [Vercel](https://vercel.com):

1. New Project → import the repo
2. Framework preset: Vite (auto-detected)
3. Add the same two environment variables from your `.env` in the Vercel project settings
4. Deploy

Vercel gives you a URL your team can use immediately — no server to manage.

## What's actually built vs. scaffolded

| Module | Status |
|---|---|
| Products | Fully working CRUD against Supabase |
| Database schema | All tables from the full design doc exist and are migrated |
| Purchases → creates batches → posts to ledger | Database logic done (triggers); no UI yet |
| Dashboard | Real counts for Products; honest empty states for everything that needs Purchases/Sales history |
| Inventory, Sales, Kitchen, Settings | Nav + page shell only |
| Analytics, Forecasting, EOQ | Table structure only — logic comes once real sales history exists to test against |

## Why inventory isn't a table you edit

Every stock change — purchase, sale, kitchen production, adjustment, waste,
return — writes one row to `inventory_ledger` and is never edited or deleted
afterward. `inventory_cache` and `batch_cache` are kept in sync automatically
by a database trigger so the app can read current stock instantly instead of
summing the whole ledger on every page load. This is what makes "every unit
traceable to a batch" (the spec's core requirement) actually hold up at
100,000+ transactions instead of just being a nice idea.

## Security note

`0008_security.sql` turns on Row Level Security but currently allows all
requests through — there's no login screen yet for it to check against. This
is fine for local development and demoing to your team, but **must** be
tightened once Supabase Auth is wired in, so cashiers can log sales without
being able to edit Products or Settings. Don't point this at real transaction
data across an open network until that's done.
