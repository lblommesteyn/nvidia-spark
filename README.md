# CityFlow — Toronto Monitor

**A real-time City of Toronto civic-intelligence dashboard with a per-business AI agent.**
A business owner enters their address, type, and team size, and gets a live map,
fresh civic data feeds scoped to their block, an ML demand forecast, and a
conversational agent that reasons over all of it — with **NVIDIA Nemotron running
on-device on the DGX / GX10 GPU**.

> **Live demo:** https://armband-ravioli-crayfish.ngrok-free.dev
> **Repo:** https://github.com/lblommesteyn/nvidia-spark

---

## 1. Quick start

```bash
npm install
npm run dev:all       # starts everything (see ports below)
```

Open **http://localhost:3100** and click **+ Business**.

| Process | Port | What it is |
|---|---|---|
| web | 3100 | Vite + Preact frontend (proxies `/api` → api) |
| api | 8787 | Hono backend (data gateway + AI endpoints) |
| ml  | 8788 | CityFlow gradient demand model (Flask) |
| asr | 8789 | Parakeet voice input (Flask, optional) |

**No API key is required to demo** — with no LLM key set, the agent falls back to a
grounded, rule-based responder, and every live feed that has a no-key source stays live.

Other handy commands:

```bash
npm run dev          # frontend only
npm run dev:server   # backend only
npm run typecheck    # frontend + server typecheck
bash scripts/tunnel.sh   # publish :3100 to the public ngrok URL (run on the GPU host)
```

---

## 2. Tech stack & architecture

**Stack:** Vite 6 + Preact 10 (TypeScript, strict) · MapLibre GL · Hono (Node) ·
SQLite (better-sqlite3) · Python/Flask ML + ASR microservices · provider-agnostic
LLM layer (NVIDIA Nemotron / OpenAI / Anthropic / Ollama / built-in mock).

```
                         Browser  (Preact + MapLibre)
                                │   http://localhost:3100
                                │   relative /api calls
                                ▼
              ┌─────────────────────────────────────────┐
              │   Hono API  (Node, :8787)                │
              │   cache + TTL + single-flight            │
              └───┬───────────────┬───────────────┬──────┘
                  │               │               │
        ┌─────────▼──────┐  ┌─────▼───────┐  ┌────▼─────────────┐
        │ SQLite          │  │ LLM layer   │  │ Live civic feeds │
        │ business store  │  │ provider-   │  │ Toronto Open Data│
        └─────────────────┘  │ agnostic    │  │ Open-Meteo, GBFS │
                             └─────┬───────┘  │ TTC, ESPN, OpenSky│
                                   │          └──────────────────┘
                     ┌─────────────▼───────────────┐
                     │  NVIDIA Nemotron NIM         │
                     │  on DGX / GX10 GPU (on-device)│
                     └──────────────────────────────┘

        ┌──────────────────────────┐     ┌──────────────────────────┐
        │ CityFlow ML (Flask :8788)│     │ Parakeet ASR (Flask :8789)│
        │ gradient demand model    │     │ voice → text (GPU)        │
        └──────────────────────────┘     └──────────────────────────┘

   Public URL:  ngrok tunnel  ──►  :3100   (scripts/tunnel.sh)
```

**How per-business tailoring works:**
1. Owner enters name/type/address/staff → geocoded to coords + neighbourhood (OpenStreetMap Nominatim), stored in SQLite.
2. `buildContext()` pulls every data source, filters geolocated records to a radius around the business, and assembles a compact, model-friendly digest.
3. The agent prompt embeds that digest + the business profile (and, when the **Demand model** toggle is on, the CityFlow ML prediction), so answers are specific to *that* business's location and type.

More detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · Nemotron runbook: [`docs/GX10-NEMOTRON.md`](docs/GX10-NEMOTRON.md).

---

## 3. Reproduce the demo (env vars & API keys)

Everything runs with **zero keys**. To enable the full experience, copy the sample
and set what you need — **no code changes required**:

```bash
cp .env.example .env
```

Provider priority for the LLM: **Nemotron → OpenAI → Anthropic → Ollama → mock**.

### Minimal `.env` for the GPU demo (Nemotron on the DGX/GX10 via Ollama)

```bash
# LLM — Nemotron served locally on the GPU box (on-device, no cloud)
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=nemotron-3-nano:30b        # your exact `ollama list` tag
# (leave NEMOTRON_BASE_URL blank so the ollama provider is selected)

# Voice input (optional) — Parakeet ASR on the same GPU box
PARAKEET_URL=http://127.0.0.1:8789
```

Alternative LLM wiring (pick one) — all documented inline in `.env.example`:

| Provider | Key / vars |
|---|---|
| Nemotron NIM (local) | `NEMOTRON_BASE_URL=http://localhost:8000/v1`, `NEMOTRON_MODEL=...` |
| Nemotron (NVIDIA hosted / NGC) | `NEMOTRON_BASE_URL=https://integrate.api.nvidia.com/v1`, `NEMOTRON_MODEL=...`, `NEMOTRON_API_KEY=nvapi-...` |
| OpenAI | `OPENAI_API_KEY`, `OPENAI_MODEL` |
| Anthropic | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` |
| Ollama (generic) | `OLLAMA_HOST`, `OLLAMA_MODEL` |

### Optional data-enrichment keys (all have a no-key fallback)

| Key | Enriches | Without it |
|---|---|---|
| `TICKETMASTER_API_KEY` (free) | venue-precise concerts/festivals | ESPN sports only |
| `PREDICTHQ_TOKEN` | demand-ranked events w/ predicted attendance | disabled |
| `TOMTOM_API_KEY` | live road-segment congestion | synthetic congestion model on real arteries |
| `AVIATIONSTACK_KEY` | scheduled YYZ arrivals (airline/terminal) | live aircraft count via OpenSky |
| `GOOGLE_PLACES_API_KEY` | nearby business density / ratings | Toronto business-licences open data |
| `METROLINX_API_KEY` | true GO GTFS-RT positions | schedule-accurate GO simulation |

### Publishing the URL (demo)

The public URL is an **ngrok tunnel from the GPU host** to the web server on `:3100`
(only the frontend is exposed; the API + Nemotron stay on localhost). On the GPU box:

```bash
npm run dev:all              # in one terminal
bash scripts/tunnel.sh       # in another → prints the public URL
```

---

## 4. Datasets & synthetic data (provenance)

### Live data (fetched at runtime, cached with TTL)

| Source | Provider | Key? |
|---|---|---|
| Weather + Air Quality | Open-Meteo | no |
| Road Restrictions & Construction | City of Toronto Open Data (real-time) | no |
| Bike Share supply/demand | Bike Share Toronto (GBFS) | no |
| TTC live vehicles + service alerts | TTC / Umo IQ | no |
| Business Licences, Building Permits, Green P Parking | Toronto Open Data (CKAN) | no |
| Concerts / Games / Events | ESPN (sports) · Ticketmaster · PredictHQ | ESPN free |
| Flights into YYZ | OpenSky (aircraft count) · aviationstack | OpenSky free |
| GO Train lines + trains | bundled GTFS extract (`server/data/go-gtfs.json`) | no |
| Geocoding | OpenStreetMap Nominatim (Toronto-bounded) | no |

Every tile is badged **LIVE / DEMO / ERR** and shows **"updated X ago"** so freshness
is always visible and honest.

### Synthetic / simulated data

- **CityFlow demand model (`cityflow_ML_model/`, served on :8788).** A
  gradient-boosting model that predicts hourly customer demand per business
  archetype (cafe / restaurant). It is trained on a **transparent Toronto demand
  simulation** whose ground truth lives in
  [`cityflow_ML_model/cityflow/sim/ground_truth.py`](cityflow_ML_model/cityflow/sim/ground_truth.py).
  Every effect (base hourly demand, day-of-week multipliers, weather/event modifiers)
  is **injected explicitly**, then the model is checked for whether it *recovered*
  those values from noisy data — *"we injected a −30% rain effect; the model learned
  −28%."* Provenance is the file itself: we defined the numbers, openly, and proved
  recovery. Training data: `data/demand-2024.jsonl`, `data/demand-loc-2024.jsonl`.
- **GO Train positions** are a **schedule-accurate simulation** from the bundled GTFS
  timetable — trains run only during real service hours at real frequency (until a
  `METROLINX_API_KEY` swaps in live GTFS-RT).
- **Road congestion** without a TomTom key is a **time-of-day-weighted synthetic model
  drawn on real Toronto arteries**.
- **Forecast fine-tuning data** (`data/forecast-*.jsonl`) is distilled from logged
  real Toronto context snapshots (`data/snapshots.jsonl`) via `npm run gen:dataset`
  (teacher = Nemotron Super-49B when a NIM is up, deterministic heuristic otherwise).

---

## 5. Known limitations & next steps

**Known limitations**
- Some Toronto open datasets ship **without coordinates** (licences, permits, 311),
  so they're shown as a city-wide sample rather than radius-filtered.
- **311** and a few permit feeds are **file-only / demo** (no live datastore API yet).
- The CityFlow demand model covers **two archetypes** (cafe, restaurant); other
  business types map to the nearest archetype.
- The public demo runs the **Vite dev server** behind ngrok; the free ngrok tier shows
  a one-time "Visit Site" interstitial.
- Single-tenant: business profiles live in a local SQLite file, no auth yet.

**Next steps**
- Ward-polygon scoping for coordless datasets (permits / licences / 311).
- Parse file-only feeds (road restrictions, 311, events) into live geo records.
- Wire the new business-setup demand inputs (hours, staffing, transit relevance)
  directly into the ML feature vector.
- Tool-calling agent loop (let the LLM query sources on demand) + MCP bridge.
- More demand archetypes; real GTFS-RT relay; auth + multi-tenant accounts.

---

## API (self-describing, AI-friendly)

- `GET /api/manifest` · `GET /.well-known/ai-plugin.json` — tools + endpoints
- `GET /api/context?businessId=…` — location-scoped digest
- `GET /api/forecast?businessId=…` — next-~12h demand forecast
- `POST /api/agent` · `POST /api/agent/stream` `{ question, businessId, radiusM, useGradient }`
- `GET /api/cameras/nearest?lon=&lat=` — nearest live traffic camera
- `GET /api/data/map` · `GET /api/data/source/:key` — civic records
- `GET /api/businesses` · `POST /api/businesses` · `DELETE /api/businesses/:id`
