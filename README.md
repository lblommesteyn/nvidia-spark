# Toronto Monitor

A real-time **City of Toronto** civic-intelligence dashboard with a **per-business
AI agent**. Business owners set up their location, type, and team size, and get a
map + data feeds + a conversational agent grounded in live Toronto data scoped to
their address.

Inspired by [WorldMonitor](../worldmonitor)'s architecture (map + panel grid +
cached service layer), extended with a real backend, SQLite persistence, and a
provider-agnostic LLM agent.

## Stack

- **Frontend:** Vite 6 + Preact 10 (TypeScript, strict), MapLibre GL (locked to Toronto)
- **Backend:** Hono (Node) — data gateway, AI endpoints, business store
- **DB:** SQLite (better-sqlite3) for business profiles
- **Geocoding:** OpenStreetMap Nominatim (free, no key, Toronto-bounded)
- **Data:** City of Toronto Open Data (CKAN) + Open-Meteo (weather/air quality)
- **LLM:** provider-agnostic (NVIDIA Nemotron / OpenAI / Anthropic / Ollama / built-in mock)

## Toronto City Brain — on-device Nemotron (GX10)

The dashboard's agent **and** its **Demand Forecast** tile run against a
provider-agnostic LLM layer that prefers a local **NVIDIA Nemotron NIM**
(OpenAI-compatible). Point it at a Nemotron model served on an **ASUS GX10**
(GB10 Grace-Blackwell, 128 GB) and all reasoning happens on-device, no cloud
round-trip:

```bash
# .env
NEMOTRON_BASE_URL=http://localhost:8000/v1
NEMOTRON_MODEL=nvidia/llama-3.3-nemotron-super-49b-v1
```

- **Demand Forecast** (`GET /api/forecast`) — a next-~12h customer-demand outlook
  fusing events, YYZ flights, weather, transit, construction and time-of-day. It
  always works: a deterministic heuristic supplies a grounded baseline, and when
  a Nemotron NIM is active the model reasons over the same signals and returns
  strict JSON (heuristic fallback on any parse failure).
- **LoRA fine-tuning** — `npm run gen:dataset` distills Toronto context snapshots
  into JSONL training rows (teacher = Super-49B when a NIM is up, heuristic
  otherwise). Full deploy + fine-tune runbook in **[docs/GX10-NEMOTRON.md](docs/GX10-NEMOTRON.md)**.

## Run

```bash
npm install
npm run dev:all      # web on :3100, api on :8787 (Vite proxies /api → api)
```

Then open http://localhost:3100 and click **+ Business**.

Individually:

```bash
npm run dev          # frontend only (:3100)
npm run dev:server   # backend only (:8787)
npm run typecheck    # frontend + server
```

## Enabling a real agent

No key needed to demo — the agent falls back to a grounded, rule-based responder.
To enable a conversational LLM, copy `.env.example` to `.env` and set ONE provider
(`NEMOTRON_BASE_URL`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `OLLAMA_HOST`).
Provider priority: **Nemotron → OpenAI → Anthropic → Ollama → mock**. No code changes.

## Data sources

| Source | Dataset | Status |
|---|---|---|
| Weather | Open-Meteo | **Live** |
| Air Quality | Open-Meteo | **Live** |
| Road Restrictions & Construction | Toronto Open Data (real-time) | **Live** |
| Bike Share (supply/demand) | Bike Share Toronto (GBFS) | **Live** |
| TTC Live Vehicles | TTC via Umo IQ | **Live** |
| Business Licences | Toronto Open Data (CKAN) | **Live** (city-wide; no coords in dataset) |
| Building Permits | Toronto Open Data (CKAN) | **Live** (city-wide; no coords in dataset) |
| 311 Requests | Toronto Open Data | Demo (no datastore API; file-only) |
| Concerts, Games & Events | ESPN · Ticketmaster · PredictHQ | **Live** (ESPN sports, no key) |
| Road Congestion (traffic) | TomTom Flow / synthetic model | **Live** with `TOMTOM_API_KEY`, else demo |
| Flights (YYZ inflow) | OpenSky · aviationstack | **Live** (OpenSky aircraft count, no key) |
| TTC / GO Service Alerts | TTC live-alerts API | **Live** |
| Parking (Green P) | Toronto Open Data (Green P) | **Live** (locations & capacity; not real-time spaces) |
| Film & Road-Occupancy Permits | — | Demo (no live City API yet) |

Each source is badged **LIVE / DEMO / ERR** in the UI, and every tile shows
**"updated X ago"** so you can see exactly how fresh each feed is.

### Events providers (concerts, games, festivals)

The events feed aggregates multiple providers and is honest about which are live:

| Provider | Coverage | Key | Without key |
|---|---|---|---|
| **ESPN** (public schedule API) | Toronto pro sports (Blue Jays, TFC, Leafs, Raptors, Argos) | none | **Live** |
| **Ticketmaster** Discovery | Concerts, arts, festivals (venue-precise coords) | `TICKETMASTER_API_KEY` (free) | disabled |
| **PredictHQ** | Demand-ranked events w/ predicted attendance | `PREDICTHQ_TOKEN` | disabled |

ESPN gives a venue name but no coordinates, so home games are placed on the map
via a known-venue lookup (Rogers Centre, Scotiabank Arena, BMO Field, …); away
games are still listed. PredictHQ's `rank` / `phq_attendance` feed the
neighbourhood demand-flow model. Add keys in `.env` to enable the gated
providers — no code changes required.

## API (AI-friendly)

The backend self-describes for external agents / MCP bridges:

- `GET /api/manifest` and `GET /.well-known/ai-plugin.json` — tools + endpoints
- `GET /api/context?businessId=…` (or `?lon=&lat=&radius=`) — location-scoped digest
- `GET /api/forecast?businessId=…` (or `?lon=&lat=&radius=`) — next-~12h demand forecast
- `GET /api/forecast/dataset?n=…` — sample LoRA training rows (add `&jsonl=1` for raw JSONL)
- `POST /api/agent` `{ question, businessId | lon+lat, radiusM }` — grounded answer
- `GET /api/data/map` — all geolocated civic records
- `GET /api/data/source/:key` — one source (live/demo envelope)
- `GET /api/geocode?q=…` — Toronto address → coords
- `GET /api/businesses`, `POST /api/businesses`, `DELETE /api/businesses/:id`

## Architecture

```
server/
  index.ts            # Hono app + routes
  cache.ts            # fetchJson + TTL cache + single-flight
  db.ts               # SQLite businesses store
  geo.ts              # Nominatim geocode + Haversine + Toronto bounds
  ckan.ts             # Toronto Open Data client + lat/lon extraction
  manifest.ts         # AI tool/endpoint manifest
  sources/
    civic.ts          # CKAN-backed registry (per-source mapper + demo fallback)
    environment.ts    # Open-Meteo weather + air quality
  ai/
    context.ts        # buildContext() — scoped, machine-readable digest
    provider.ts       # provider-agnostic chat (nemotron/openai/anthropic/ollama/mock)
    agent.ts          # grounds the LLM in location context
    forecast.ts       # demand forecast (heuristic baseline + LLM/Nemotron reasoning)
    dataset.ts        # context snapshots → LoRA fine-tuning JSONL (distillation)
scripts/
  gen-forecast-dataset.ts  # `npm run gen:dataset` — writes training JSONL
docs/
  GX10-NEMOTRON.md    # serve Nemotron NIM + LoRA fine-tune runbook
src/
  services/api.ts     # typed backend client
  components/
    TorontoMap.tsx    # MapLibre, Toronto-locked, category markers + home pin
    BusinessSetup.tsx # onboarding form (geocodes on submit)
    AgentChat.tsx     # chat with the tailored agent
    Panel.tsx         # panel shell w/ status badge
  App.tsx             # orchestration
```

## How the per-business tailoring works

1. Owner enters name, type, address, staff, notes → geocoded to coords + neighbourhood, stored in SQLite.
2. `buildContext()` pulls every data source, filters geolocated records to a radius
   around the business, and assembles a compact, model-friendly digest.
3. The agent system prompt embeds that digest + the business profile, so answers
   are specific to *that* business's location and type.

### Roadmap

- Ward-polygon scoping for coordless datasets (permits/licences/311)
- Parse file-only datasets (road restrictions, 311, events) into live geo records
- Demographics (neighbourhood profiles) + transit (TTC GTFS-RT via relay)
- Tool-calling agent loop (let the LLM query sources on demand)
- Auth + multi-tenant business accounts
