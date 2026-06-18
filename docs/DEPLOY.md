# Deploying CityFlow (no GPU / no DGX)

This hosts the app entirely in the cloud, with a **hosted Anthropic** LLM
(instead of a local Nemotron) and your teammate's **CityFlow ML** model running
as its own service.

```
  Vercel                Railway                       Railway
┌──────────┐  /api    ┌──────────────────┐  ML_URL  ┌────────────────────┐
│ Frontend │ ───────► │ Backend (Hono)   │ ───────► │ CityFlow ML (Flask)│
│ (Preact) │          │ + SQLite + agent │          │ gradient model     │
└──────────┘          └──────────────────┘          └────────────────────┘
                            │ Anthropic API
                            ▼
                       api.anthropic.com
```

Three services, deployed in this order: **ML → Backend → Frontend** (each needs
the previous one's URL).

> Prereqs: `railway` CLI + `vercel` CLI installed and logged in
> (`railway login`, `vercel login`). An **Anthropic API key** (`sk-ant-...`).

---

## 1. CityFlow ML service → Railway

Builds the demand models at image-build time (so it starts model-backed) and
serves on `$PORT`.

```bash
railway init               # create/select a project (e.g. "cityflow")
railway up \
  --dockerfile deploy/ml.Dockerfile \
  --service cityflow-ml
```

Then in the Railway dashboard for **cityflow-ml** → Settings → Networking →
**Generate Domain**. Copy the URL, e.g. `https://cityflow-ml.up.railway.app`.

Sanity check:
```bash
curl https://cityflow-ml.up.railway.app/health
# {"ok":true,"models":["cafe","restaurant"], ...}   ← models present = good
```

---

## 2. Backend (Hono API) → Railway

API-only (the frontend is on Vercel). Needs the ML URL + Anthropic key, and a
volume so the SQLite business store persists across restarts.

```bash
railway up \
  --dockerfile deploy/backend.Dockerfile \
  --service cityflow-api
```

In the Railway dashboard for **cityflow-api**:

1. **Variables** → add:
   | Key | Value |
   |---|---|
   | `ANTHROPIC_API_KEY` | `sk-ant-...` |
   | `ANTHROPIC_MODEL` | `claude-3-5-sonnet-latest` (optional) |
   | `ML_URL` | `https://cityflow-ml.up.railway.app` (from step 1) |
   | `CORS_ORIGIN` | `*` for now (lock to the Vercel URL after step 3) |
2. **Settings → Networking → Generate Domain** → copy it, e.g.
   `https://cityflow-api.up.railway.app`.
3. **Settings → Volumes → Add Volume**, mount path **`/app/data`** (persists the
   SQLite DB).

Sanity check:
```bash
curl https://cityflow-api.up.railway.app/api/health
# {"ok":true,"provider":"anthropic", ...}   ← provider:anthropic = key picked up
```

---

## 3. Frontend (Preact) → Vercel

The frontend reads `VITE_API_BASE` **at build time** to know where the backend
is. Set it, then deploy.

```bash
# point the build at the backend from step 2
vercel env add VITE_API_BASE production
#   → paste: https://cityflow-api.up.railway.app

vercel --prod
```

`vercel.json` already configures the build (`npm run build` → `dist/`) and SPA
routing. Vercel prints the public URL, e.g. `https://cityflow.vercel.app`.

**Then lock CORS** (optional but recommended): set `CORS_ORIGIN` on the backend
(step 2) to the Vercel URL and redeploy the backend.

---

## Done — what runs where

| Service | Host | URL | Notes |
|---|---|---|---|
| Frontend | Vercel | `https://…vercel.app` | static SPA, `VITE_API_BASE` baked in |
| Backend API | Railway | `https://…api.up.railway.app` | Hono + SQLite (volume) + Anthropic |
| CityFlow ML | Railway | `https://…ml.up.railway.app` | gradient demand model |

## Updating after code changes

```bash
git push                                   # push to main
railway up --dockerfile deploy/ml.Dockerfile      --service cityflow-ml    # if ML changed
railway up --dockerfile deploy/backend.Dockerfile --service cityflow-api   # if backend changed
vercel --prod                                                              # if frontend changed
```
(If you change `VITE_API_BASE`, you must redeploy the frontend — it's compiled in.)

## Troubleshooting

- **Agent says provider `mock` / DEMO** → `ANTHROPIC_API_KEY` not set on the
  backend service. Add it and redeploy.
- **Forecast tile shows "heuristic" not "· ML"** → backend can't reach the ML
  service. Check `ML_URL` on the backend and that `…/health` lists models.
- **Frontend loads but no data / CORS errors in console** → `VITE_API_BASE`
  wasn't set at build time (rebuild on Vercel), or `CORS_ORIGIN` on the backend
  doesn't include the Vercel origin.
- **Businesses disappear after a redeploy** → the Railway volume isn't mounted at
  `/app/data`.
- **Voice input** (Parakeet) needs a GPU and is **not deployed** in this setup;
  the agent chat still works by text.

## Local development is unchanged

`npm run dev:all` still works (frontend `:3100` proxies `/api` → `:8787`).
`VITE_API_BASE` is empty locally, so the app uses same-origin relative paths.
