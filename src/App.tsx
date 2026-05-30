import { useEffect, useState } from "preact/hooks";
import { TorontoMap } from "./components/TorontoMap";
import { MapLegend } from "./components/MapLegend";
import { LiveTV } from "./components/LiveTV";
import { BusinessSetup } from "./components/BusinessSetup";
import { AgentChat } from "./components/AgentChat";
import { Panel } from "./components/Panel";
import { DashboardGrid, resetDashboardLayout, type GridTile } from "./components/DashboardGrid";
import { api, type Business, type CivicRecord, type DemandForecast, type DemandLevel, type FlowCollection, type LocationContext } from "./services/api";

const FORECAST_COLOR: Record<DemandLevel, string> = {
  low: "#5a8dd6",
  moderate: "#3fb950",
  elevated: "#d29922",
  surge: "#f85149",
};

const LS_KEY = "tomon-business-id";

const CATEGORY_LABEL: Record<CivicRecord["category"], string> = {
  mobility: "Mobility",
  construction: "Construction",
  transit: "Transit",
  bikeshare: "Bike Share",
  safety: "Safety / 311",
  business: "Business",
  permit: "Permits",
  event: "Events",
  environment: "Environment",
  alert: "Service Alerts",
  parking: "Parking",
  aviation: "Air Traffic",
};

const CATEGORY_DESC: Record<CivicRecord["category"], string> = {
  mobility: "Road incidents and restrictions affecting access and foot traffic.",
  construction: "Active construction & closures (watermain, paving, utilities) near you.",
  transit: "Live TTC vehicles moving through the area — a read on transit flow.",
  bikeshare: "Bike Share stations with real-time bikes/docks — local supply & demand.",
  safety: "311 service requests and neighbourhood safety signals near you.",
  business: "Active municipal business licences and permits in the area.",
  permit: "Building, development and road-occupancy permits issued nearby.",
  event: "Festivals and events that drive local crowds.",
  environment: "Environmental readings around your location.",
  alert: "Live TTC disruptions & diversions that reroute crowds onto nearby streets.",
  parking: "Green P municipal lots & garages — local parking supply.",
  aviation: "Inbound flights to Toronto — a visitor / tourism inflow signal.",
};

const SIGNAL_LABEL: Record<string, string> = {
  bikeDemand: "bike demand",
  transit: "transit",
  construction: "construction",
  issues: "311 issues",
  development: "development",
  events: "events",
};

export function App() {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(localStorage.getItem(LS_KEY));
  const [context, setContext] = useState<LocationContext | null>(null);
  const [forecast, setForecast] = useState<DemandForecast | null>(null);
  const [flow, setFlow] = useState<FlowCollection | null>(null);
  const [provider, setProvider] = useState<string>("…");
  const [showSetup, setShowSetup] = useState(false);

  const selected = businesses.find((b) => b.id === selectedId) ?? null;

  useEffect(() => {
    api.health().then((h) => setProvider(h.provider)).catch(() => setProvider("offline"));
    api.listBusinesses().then(setBusinesses).catch(() => {});
    api.flow().then(setFlow).catch(() => {});
  }, []);

  useEffect(() => {
    if (businesses.length && !businesses.some((b) => b.id === selectedId)) {
      setSelectedId(businesses[0].id);
    }
  }, [businesses]);

  useEffect(() => {
    if (selectedId) localStorage.setItem(LS_KEY, selectedId);
    setContext(null);
    setForecast(null);
    api
      .context(selectedId ? { businessId: selectedId } : { radius: 1000 })
      .then(setContext)
      .catch(() => {});
    api
      .forecast(selectedId ? { businessId: selectedId } : { radius: 1000 })
      .then(setForecast)
      .catch(() => {});
  }, [selectedId]);

  // Background polling so tiles refresh on their own (no flicker — we don't clear).
  useEffect(() => {
    const pull = () => {
      api
        .context(selectedId ? { businessId: selectedId } : { radius: 1000 })
        .then(setContext)
        .catch(() => {});
      api
        .forecast(selectedId ? { businessId: selectedId } : { radius: 1000 })
        .then(setForecast)
        .catch(() => {});
      api.flow().then(setFlow).catch(() => {});
    };
    const t = setInterval(pull, 90_000);
    return () => clearInterval(t);
  }, [selectedId]);

  const topFlow = (flow?.features ?? [])
    .slice()
    .sort((a, b) => b.properties.score - a.properties.score)
    .slice(0, 6);

  const eventGroup = context?.civic.find((g) => g.category === "event") ?? null;
  const otherCivic = context?.civic.filter((g) => g.category !== "event") ?? [];

  function onCreated(b: Business) {
    setBusinesses((prev) => [b, ...prev]);
    setSelectedId(b.id);
    setShowSetup(false);
  }

  const totalSources = (context?.civic.length ?? 0) + 2; // + weather + air quality

  const tiles: GridTile[] = [
    {
      id: "agent",
      x: 0,
      y: 0,
      w: 12,
      h: 5,
      content: selected ? (
        <AgentChat business={selected} />
      ) : (
        <Panel
          title="Your Toronto Agent"
          status="demo"
          description="Add your business to unlock a location-tailored agent and scoped civic data."
        >
          <p class="muted">
            Tell us where you are and what you do — we'll wire up an agent grounded in
            live Toronto conditions around your storefront.
          </p>
          <button class="btn-primary" onClick={() => setShowSetup(true)}>+ Add business</button>
        </Panel>
      ),
    },
    {
      id: "forecast",
      x: 0,
      y: 5,
      w: 12,
      h: 4,
      content: (
        <Panel
          title="Demand Forecast"
          status={forecast ? "live" : "loading"}
          description="Next ~12h customer-demand outlook fusing events, flights, weather, transit, construction and time-of-day. Runs on the active model — point NEMOTRON_BASE_URL at a Nemotron NIM (GX10) for on-device reasoning."
          updatedAt={forecast?.generatedAt}
          note={forecast ? `${forecast.method === "llm" ? "model-reasoned" : "heuristic"} · ${forecast.provider}/${forecast.model}` : undefined}
        >
          {!forecast ? (
            <div class="muted">Computing forecast…</div>
          ) : (
            <div class="forecast">
              <div class="forecast-head">
                <span
                  class="forecast-pill"
                  style={{ background: FORECAST_COLOR[forecast.level], color: "#0b0f17" }}
                >
                  {forecast.level.toUpperCase()}
                </span>
                <div class="forecast-gauge">
                  <div
                    class="forecast-gauge-fill"
                    style={{ width: `${Math.round(forecast.score * 100)}%`, background: FORECAST_COLOR[forecast.level] }}
                  />
                </div>
                <span class="muted">{Math.round(forecast.score * 100)}% pressure</span>
              </div>
              <p class="forecast-headline">{forecast.headline}</p>
              <div class="forecast-cols">
                <div>
                  <div class="forecast-sub">Drivers</div>
                  <ul class="list">
                    {forecast.drivers.slice(0, 5).map((d, i) => (
                      <li key={i}>
                        <span style={{ color: d.impact === "up" ? "#3fb950" : "#f85149" }}>
                          {d.impact === "up" ? "▲" : "▼"}
                        </span>{" "}
                        <strong>{d.signal}</strong>
                        <span class="muted"> — {d.detail}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <div class="forecast-sub">Windows</div>
                  <ul class="list">
                    {forecast.windows.map((w, i) => (
                      <li key={i}>
                        <span class="flow-dot" style={{ background: FORECAST_COLOR[w.level] }} />
                        <strong>{w.label}</strong>
                        <span class="muted"> — {w.note}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <div class="forecast-sub">Recommended actions</div>
                  <ul class="list">
                    {forecast.actions.map((a, i) => (
                      <li key={i}><span class="muted">{a}</span></li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}
        </Panel>
      ),
    },
    {
      id: "livetv",
      x: 0,
      y: 9,
      w: 7,
      h: 6,
      content: (
        <Panel
          title="Live Toronto TV"
          status="live"
          description="Live news streams — CP24, CityNews, Global & CBC — resolved in real time."
        >
          <LiveTV />
        </Panel>
      ),
    },
    {
      id: "flow",
      x: 7,
      y: 9,
      w: 5,
      h: 6,
      content: (
        <Panel
          title="City Flow — Hotspots"
          status={flow ? "live" : "loading"}
          description="Where Toronto is busiest right now: a live demand/activity score aggregated per neighbourhood (bike demand, transit, construction, 311, development, events)."
          count={flow?.features.length}
          updatedAt={flow?.generatedAt}
        >
          {flow ? (
            <ul class="list">
              {topFlow.map((f) => (
                <li key={f.properties.id}>
                  <span class={`flow-dot flow-${f.properties.level}`} />
                  <strong>{f.properties.name}</strong>
                  <span class="muted"> {SIGNAL_LABEL[f.properties.topSignal] ?? f.properties.topSignal}</span>
                  <span class="dist">{f.properties.score.toFixed(2)}</span>
                </li>
              ))}
            </ul>
          ) : <div class="muted">Computing flow…</div>}
        </Panel>
      ),
    },
    {
      id: "events",
      x: 0,
      y: 15,
      w: 6,
      h: 5,
      content: (
        <Panel
          title="Upcoming Events, Games & Concerts"
          status={eventGroup?.status ?? "loading"}
          description="Stadium games, concerts and big events that pull crowds nearby — pro sports (ESPN, live), plus Ticketmaster & PredictHQ when keys are set."
          count={eventGroup?.nearby.length}
          updatedAt={eventGroup?.fetchedAt}
          note={eventGroup?.note}
        >
          {!eventGroup ? (
            <div class="muted">Loading…</div>
          ) : eventGroup.nearby.length === 0 ? (
            <div class="muted">No events found nearby right now.</div>
          ) : (
            <ul class="list">
              {eventGroup.nearby.slice(0, 12).map((r) => (
                <li key={r.id}>
                  <strong>{r.title}</strong>
                  {r.detail && <span class="muted"> — {r.detail}</span>}
                  {r.distanceM != null && <span class="dist">{r.distanceM}m</span>}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      ),
    },
    {
      id: "sources",
      x: 6,
      y: 15,
      w: 6,
      h: 5,
      content: (
        <Panel
          title="Data Sources"
          status={context ? "live" : "loading"}
          description="Provenance of every feed powering this dashboard. LIVE = real city/open data."
          count={totalSources}
        >
          {context ? (
            <ul class="list">
              <li><strong>Weather</strong><span class={`badge badge-${context.weather.status}`}><i class="badge-dot" />{context.weather.status.toUpperCase()}</span></li>
              <li><strong>Air Quality</strong><span class={`badge badge-${context.airQuality.status}`}><i class="badge-dot" />{context.airQuality.status.toUpperCase()}</span></li>
              {context.civic.map((g) => (
                <li key={g.source}>
                  <strong>{CATEGORY_LABEL[g.category]}</strong>
                  <span class="muted"> {g.label}</span>
                  <span class={`badge badge-${g.status}`} style={{ marginLeft: "auto" }}><i class="badge-dot" />{g.status.toUpperCase()}</span>
                </li>
              ))}
            </ul>
          ) : <div class="muted">Loading…</div>}
        </Panel>
      ),
    },
    {
      id: "weather",
      x: 0,
      y: 20,
      w: 3,
      h: 3,
      content: (
        <Panel
          title="Weather"
          status={context?.weather.status ?? "loading"}
          description="Current conditions at your location from Open-Meteo."
          updatedAt={context?.weather.fetchedAt}
        >
          {context ? (
            <div class="metric-row">
              <div class="metric-big">{context.weather.data.temperatureC}°C</div>
              <div class="metric-side">
                <div>{context.weather.data.description}</div>
                <div class="muted">Feels {context.weather.data.feelsLikeC}° · Wind {context.weather.data.windKph} km/h · {context.weather.data.humidity}% RH</div>
              </div>
            </div>
          ) : <div class="muted">Loading…</div>}
        </Panel>
      ),
    },
    {
      id: "airquality",
      x: 3,
      y: 20,
      w: 3,
      h: 3,
      content: (
        <Panel
          title="Air Quality"
          status={context?.airQuality.status ?? "loading"}
          description="US AQI and particulate levels around your business."
          updatedAt={context?.airQuality.fetchedAt}
        >
          {context ? (
            <div class="metric-row">
              <div class="metric-big">{context.airQuality.data.usAqi}</div>
              <div class="metric-side">
                <div>{context.airQuality.data.category}</div>
                <div class="muted">PM2.5 {context.airQuality.data.pm25} · PM10 {context.airQuality.data.pm10}</div>
              </div>
            </div>
          ) : <div class="muted">Loading…</div>}
        </Panel>
      ),
    },
    ...otherCivic.map<GridTile>((g, i) => ({
      id: `civic-${g.source}`,
      x: (i % 3) * 4,
      y: 23 + Math.floor(i / 3) * 4,
      w: 4,
      h: 4,
      content: (
        <Panel
          title={`${CATEGORY_LABEL[g.category]} · ${g.label}`}
          status={g.status}
          description={CATEGORY_DESC[g.category]}
          count={g.areaWide ? undefined : g.nearby.length}
          updatedAt={g.fetchedAt}
          note={g.note ?? (g.areaWide ? "City-wide sample (dataset has no coordinates)" : `${g.nearby.length} within ${context!.scope.radiusM}m`)}
        >
          {g.nearby.length === 0 ? (
            <div class="muted">Nothing nearby.</div>
          ) : (
            <ul class="list">
              {g.nearby.slice(0, 6).map((r) => (
                <li key={r.id}>
                  <strong>{r.title}</strong>
                  {r.detail && <span class="muted"> — {r.detail}</span>}
                  {r.distanceM != null && <span class="dist">{r.distanceM}m</span>}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      ),
    })),
  ];

  return (
    <div class="app">
      <header class="topbar">
        <div class="brand">
          <span class="brand-mark">TO</span>
          <div>
            <h1>Toronto Monitor</h1>
            <p>Civic intelligence + a tailored agent for your business</p>
          </div>
        </div>

        <div class="topbar-controls">
          <span class={`provider-badge provider-${provider}`} title="Active LLM provider">
            agent: {provider}
          </span>
          {businesses.length > 0 && (
            <select
              class="biz-select"
              value={selectedId ?? ""}
              onChange={(e) => setSelectedId((e.target as HTMLSelectElement).value)}
            >
              {businesses.map((b) => (
                <option key={b.id} value={b.id}>{b.name} — {b.businessType}</option>
              ))}
            </select>
          )}
          <button class="btn-ghost" title="Reset tile layout" onClick={() => resetDashboardLayout()}>⟲ Layout</button>
          <button class="btn-primary" onClick={() => setShowSetup(true)}>+ Business</button>
        </div>
      </header>

      <div class="main-content">
        {/* ---- Map ---- */}
        <div class="map-section">
          <TorontoMap
            home={selected ? { lon: selected.lon, lat: selected.lat, label: selected.name } : null}
          />
          {context && context.highlights.length > 0 && (
            <div class="map-overlay">
              <div class="overlay-title">Today's briefing</div>
              {context.highlights.slice(0, 4).map((h, i) => (
                <div key={i} class="overlay-line">{h}</div>
              ))}
            </div>
          )}
          <MapLegend />
        </div>

        {/* ---- Panels (drag to reorder, resize from edges) ---- */}
        <div class="grid-hint">Drag tiles by their header · resize from the edges · <button class="linklike" onClick={() => resetDashboardLayout()}>reset</button></div>
        <DashboardGrid tiles={tiles} />
      </div>

      {showSetup && <BusinessSetup onCreated={onCreated} onCancel={() => setShowSetup(false)} />}
    </div>
  );
}
