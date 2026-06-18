# Deploy runbook — copy-paste (Railway + Vercel)

Run these from the repo root: `/Users/dapietrocola/Developer/misc/personal/torontomonitor`
Railway CLI is already logged in. Order matters: **ML -> Backend -> Frontend.**

Helper at the top of each step assumes you're in the repo dir:
```bash
cd /Users/dapietrocola/Developer/misc/personal/torontomonitor
```

---

## 0. Create the Railway project (once)

```bash
railway init --name cityflow        # creates + links a project to this dir
```

---

## 1. CityFlow ML service (Railway)

Create the service, tell Railway to use the ML Dockerfile, deploy, expose it.

```bash
# create service + point it at the ML Dockerfile
railway add --service cityflow-ml \
  --variables "RAILWAY_DOCKERFILE_PATH=deploy/ml.Dockerfile"

# deploy this directory to that service (streams build logs)
railway up -y --service cityflow-ml

# give it a public URL
railway domain --service cityflow-ml
```

Copy the printed domain, e.g. `https://cityflow-ml-production.up.railway.app`.

Verify (models present = good):
```bash
curl https://cityflow-ml-production.up.railway.app/health
# {"ok":true,"models":["cafe","restaurant"], ...}
```

---

## 2. Backend API service (Railway)

```bash
# create service, point at the backend Dockerfile, set ML_URL + CORS
# (replace the ML URL with YOUR domain from step 1)
railway add --service cityflow-api \
  --variables "RAILWAY_DOCKERFILE_PATH=deploy/backend.Dockerfile" \
  --variables "ML_URL=https://cityflow-ml-production.up.railway.app" \
  --variables "CORS_ORIGIN=*"

# >>> set your Anthropic key (NOT committed). Pipe via stdin so it stays out of
#     your shell history:
read -rs ANTHROPIC_KEY   # paste the sk-ant-... key, press Enter (input hidden)
printf '%s' "$ANTHROPIC_KEY" | railway variables set --service cityflow-api --stdin ANTHROPIC_API_KEY
unset ANTHROPIC_KEY
#     ...or just set ANTHROPIC_API_KEY in the Railway dashboard (Variables tab).

# persist the SQLite business store across restarts
railway volume add --service cityflow-api --mount-path /app/data

# deploy
railway up -y --service cityflow-api

# public URL
railway domain --service cityflow-api
```

Copy the printed domain, e.g. `https://cityflow-api-production.up.railway.app`.

Verify (provider must say anthropic):
```bash
curl https://cityflow-api-production.up.railway.app/api/health
# {"ok":true,"provider":"anthropic", ...}
```

---

## 3. Frontend (Vercel)

Install + log in (vercel isn't on PATH yet):
```bash
npm i -g vercel
vercel login
```

Link the project and set the API base to YOUR backend URL from step 2:
```bash
vercel link --yes                     # creates .vercel/, links a project

# backend URL the frontend will call (from step 2)
vercel env add VITE_API_BASE production
#   when prompted, paste: https://cityflow-api-production.up.railway.app

vercel --prod
```

Vercel prints your public URL, e.g. `https://cityflow.vercel.app`. **That's the link.**

---

## 4. (Recommended) Lock CORS to the Vercel URL

```bash
railway variables set --service cityflow-api \
  CORS_ORIGIN=https://cityflow.vercel.app
railway up -y --service cityflow-api      # redeploy backend
```

---

## Updating later

```bash
git push
railway up -y --service cityflow-ml      # if ML changed
railway up -y --service cityflow-api     # if backend changed
vercel --prod                            # if frontend changed
```
Changing `VITE_API_BASE` requires a frontend redeploy (it's compiled in).

## If something's off
- agent shows `mock`/DEMO -> `ANTHROPIC_API_KEY` missing on cityflow-api.
- forecast says "heuristic" not "· ML" -> `ML_URL` wrong, or ML `/health` has no models.
- frontend loads but no data / CORS error -> `VITE_API_BASE` not set at build (redeploy on Vercel), or `CORS_ORIGIN` doesn't include the Vercel origin.
- businesses vanish after redeploy -> the `/app/data` volume isn't attached.
