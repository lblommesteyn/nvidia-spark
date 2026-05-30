# CityFlow / Toronto Monitor — Architecture & User Flows

Small reference for how the system fits together. All diagrams are
[Mermaid](https://mermaid.js.org) and render directly on GitHub/GitLab.

---

## 1. Infrastructure / system architecture

```mermaid
flowchart TB
    subgraph Browser["🖥️  Browser (Preact + Vite, :3100)"]
        LP["Landing page<br/>main.ts · GSAP/Lenis · particle hero<br/>route: /"]
        APP["Dashboard<br/>main.tsx → App.tsx<br/>route: /app"]
        subgraph Tiles["Dashboard tiles"]
            MAP["TorontoMap<br/>(MapLibre GL)"]
            FC["Demand Forecast<br/>(12h + 7-day)"]
            AG["Agent chat"]
            TV["Live Toronto TV<br/>(CBC Toronto)"]
        end
        APP --> Tiles
        LP -- "Open Terminal → /app" --> APP
    end

    subgraph Backend["⚙️  Backend — Node + Hono (:8787)"]
        API["REST API<br/>/api/*"]
        CTX["buildContext()<br/>signal aggregation"]
        FORE["forecast.ts<br/>LLM + heuristic fallback"]
        AGENT["agent.ts"]
        PROV["provider.ts<br/>(LLM abstraction)"]
        CACHE["cache.ts<br/>(in-memory TTL)"]
        DB["(SQLite<br/>businesses)"]
        API --> CTX --> FORE --> PROV
        API --> AGENT --> PROV
        API --> DB
        CTX --> CACHE
    end

    subgraph LLM["🧠  LLM providers (priority order)"]
        NIM["Nemotron NIM<br/>(ASUS GX10 / GB10)<br/>NEMOTRON_BASE_URL"]
        OAI["OpenAI"]
        ANT["Anthropic"]
        OLL["Ollama"]
        MOCK["mock / heuristic<br/>(default, no key)"]
    end

    subgraph Ext["🌐  External data sources"]
        TOD["Toronto Open Data (CKAN)<br/>roads · 311 · permits · licences · parking"]
        TTC["TTC<br/>umoiq vehicles · alerts.ttc.ca"]
        BIKE["Bike Share GBFS<br/>tor.publicbikesystem.net"]
        EVT["Events<br/>Ticketmaster · PredictHQ · ESPN"]
        FLT["Flights<br/>AviationStack · OpenSky"]
        WX["Weather/AQ<br/>Open-Meteo"]
        TT["Traffic<br/>TomTom"]
        YT["YouTube<br/>live TV embeds"]
    end

    Browser -- "/api proxy" --> API
    PROV --> NIM & OAI & ANT & OLL & MOCK
    CTX --> Ext
    TV --> YT
```

---

## 2. Offline training loop (the GX10 "Toronto City Brain")

How real Toronto data becomes a fine-tuned forecaster that plugs back into the
app with zero code changes (see `docs/GX10-NEMOTRON.md`).

```mermaid
flowchart LR
    subgraph Sources["Real Toronto data"]
        GBFS["GBFS roster<br/>1,035 stations"]
        RIDE["Bike Share 2024<br/>ridership (~7M trips)"]
        GP["Google Places (New) v1<br/>area profiles"]
        OM["Open-Meteo archive<br/>historical weather"]
        VEN["Venues + concerts<br/>(synthetic, tagged)"]
    end

    subgraph Pipe["Python pipeline (scripts/)"]
        F1["fetch_stations.py"]
        F2["enrich_places.py"]
        F3["venues_concerts.py"]
        F4["backfill_location.py<br/>(join → JSONL)"]
        VAL["validate_dataset.py"]
    end

    JSONL["data/forecast-loc-*.jsonl<br/>183,873 train / 20,204 val"]

    subgraph GX10["ASUS GX10 (GB10, 128GB)"]
        TRAIN["train_lora.py<br/>(PEFT/TRL LoRA)"]
        ADAPTER["LoRA adapter<br/>toronto-forecaster"]
        SERVE["Nemotron-Nano-8B NIM<br/>:8001 (OpenAI-compatible)"]
        EVAL["eval_forecast.py"]
    end

    GBFS --> F1
    GP --> F2
    VEN --> F3
    RIDE --> F4
    OM --> F4
    F1 & F2 & F3 --> F4 --> JSONL --> VAL
    VAL --> TRAIN --> ADAPTER --> SERVE
    SERVE --> EVAL
    SERVE -. "NEMOTRON_BASE_URL" .-> APP2["App forecast tile"]
```

---

## 3. User flow — business owner using the dashboard

```mermaid
flowchart TD
    A["Visit /"] --> B["Landing page<br/>(particle story, scroll)"]
    B --> C["Click 'Open Terminal'"]
    C --> D["Navigate to /app<br/>dashboard mounts"]
    D --> E{First visit?}
    E -- "yes" --> F["BusinessSetup<br/>name · address · type"]
    F --> G["Geocode address<br/>/api/geocode"]
    E -- "no" --> H
    G --> H["Dashboard renders<br/>map + tiles"]
    H --> I["Map shows live<br/>civic signals & demand flow"]
    H --> J["Demand Forecast tile<br/>12h + 7-day"]
    H --> K["Ask the Agent<br/>'Should I add staff Friday?'"]
    H --> L["Watch CBC Toronto<br/>live stream"]
    J --> M["Operating decisions:<br/>staffing · prep · promos"]
    K --> M
```

---

## 4. Sequence — a demand forecast request

```mermaid
sequenceDiagram
    participant U as Browser (forecast tile)
    participant V as Vite proxy :3100
    participant API as Hono API :8787
    participant CTX as buildContext()
    participant SRC as External sources
    participant P as provider.ts
    participant N as Nemotron NIM (GX10)

    U->>V: GET /api/forecast?lat&lon
    V->>API: proxy
    API->>CTX: aggregate signals for point
    CTX->>SRC: fetch (cached) events, weather, TTC, roads…
    SRC-->>CTX: civic records
    CTX-->>API: signal digest
    API->>P: chat(signals → forecast JSON)
    alt LLM provider set
        P->>N: POST /v1/chat/completions
        N-->>P: forecast JSON
    else no key (mock)
        P-->>API: heuristic forecast
    end
    P-->>API: {score, level, drivers, windows, actions}
    API-->>U: forecast (LIVE/DEMO badge)
    Note over U: invalid JSON → safe heuristic fallback
```

---

## 5. Sequence — agent Q&A

```mermaid
sequenceDiagram
    participant U as Agent chat
    participant API as Hono API :8787
    participant CTX as buildContext()
    participant P as provider.ts
    participant L as LLM (Nemotron/OpenAI/…/mock)

    U->>API: POST /api/agent {question, business}
    API->>CTX: gather highlights for business radius
    CTX-->>API: <HIGHLIGHTS> + <BUSINESS> context
    API->>P: chat(system+context, question)
    P->>L: completion
    L-->>P: grounded answer
    P-->>API: {text, provider, model}
    API-->>U: answer + provider badge
```

---

## Provider selection (priority)

`activeProvider()` in `server/ai/provider.ts` picks the first env var present:

```
NEMOTRON_BASE_URL → OPENAI_API_KEY → ANTHROPIC_API_KEY → OLLAMA_HOST → mock
```

Everything works on **mock/heuristic** with no keys, so the app is always
demoable; pointing `NEMOTRON_BASE_URL` at the GX10 NIM upgrades the agent and
forecasts to on-device Nemotron with zero code changes.
