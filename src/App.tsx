import { useEffect, useState } from "preact/hooks";
import { TorontoMap } from "./components/TorontoMap";
import { MapLegend } from "./components/MapLegend";
import { MapCamera } from "./components/MapCamera";
import { LiveTV } from "./components/LiveTV";
import { BusinessSetup } from "./components/BusinessSetup";
import { AgentChat } from "./components/AgentChat";
import { AlertFeed } from "./components/AlertFeed";
import { Panel } from "./components/Panel";
import { DashboardGrid, resetDashboardLayout, type GridTile } from "./components/DashboardGrid";
import { api, type Business, type CivicRecord, type DemandForecast, type DemandLevel, type FlowCollection, type Holiday, type LocationContext, type WeeklyForecast } from "./services/api";

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
  aviation: "Inbound flights in the air over Toronto right now — a live visitor / tourism inflow signal.",
};

const SIGNAL_LABEL: Record<string, string> = {
  bikeDemand: "bike demand",
  transit: "transit",
  construction: "construction",
  issues: "311 issues",
  development: "development",
  events: "events",
};

/**
 * Honest, branded label for the active intelligence stack. The CityFlow
 * gradient-boosting demand model is always part of the stack; the LLM half
 * varies by provider, so the local-GPU path proudly names Nemotron while the
 * no-key path stays truthful ("Demo mode").
 */
function engineLabel(provider: string): string {
  switch (provider) {
    case "nemotron":
    case "ollama":
      return "Nemotron + CityFlow gradient-boosting demand model";
    case "openai":
      return "OpenAI + CityFlow gradient-boosting demand model";
    case "anthropic":
      return "Claude + CityFlow gradient-boosting demand model";
    case "offline":
      return "offline";
    case "…":
      return "connecting…";
    default: // mock / no key wired
      return "Demo mode + CityFlow gradient-boosting demand model";
  }
}

export function App() {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(localStorage.getItem(LS_KEY));
  const [context, setContext] = useState<LocationContext | null>(null);
  const [forecast, setForecast] = useState<DemandForecast | null>(null);
  const [week, setWeek] = useState<WeeklyForecast | null>(null);
  const [flow, setFlow] = useState<FlowCollection | null>(null);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [provider, setProvider] = useState<string>("…");
  const [showSetup, setShowSetup] = useState(false);
  const [liveTvStatus, setLiveTvStatus] = useState<"live" | "demo" | "loading">("loading");

  const selected = businesses.find((b) => b.id === selectedId) ?? null;

  // Query string mirroring what the tiles fetch — used so each status badge can
  // deep-link to the exact raw JSON feed behind that tile.
  const ctxQuery = selectedId ? `businessId=${selectedId}` : "radius=1000";

  useEffect(() => {
    api.health().then((h) => setProvider(h.provider)).catch(() => setProvider("offline"));
    api.listBusinesses().then(setBusinesses).catch(() => {});
    api.flow().then(setFlow).catch(() => {});
    api.holidays(4).then((h) => setHolidays(h.data)).catch(() => {});
  }, []);

  useEffect(() => {
    if (businesses.length && !businesses.some((b) => b.id === selectedId)) {
      setSelectedId(businesses[0].id);
    }
  }, [businesses]);

  useEffect(() => {
    if (selectedId) localStorage.setItem(LS_KEY, selectedId);
    // Note: we intentionally do NOT clear context/forecast/week here. Clearing
    // them unmounts the tiles' content, which makes GridStack reflow and the
    // whole dashboard "jump" on every business switch. Instead we keep the
    // last-good data on screen and swap it in place once the new fetch resolves.
    api
      .context(selectedId ? { businessId: selectedId } : { radius: 1000 })
      .then(setContext)
      .catch(() => {});
    api
      .forecast(selectedId ? { businessId: selectedId } : { radius: 1000 })
      .then(setForecast)
      .catch(() => {});
    api
      .forecastWeek(selectedId ? { businessId: selectedId } : { radius: 1000 })
      .then(setWeek)
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
      api
        .forecastWeek(selectedId ? { businessId: selectedId } : { radius: 1000 })
        .then(setWeek)
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
      x: 4,
      y: 0,
      w: 8,
      h: 8,
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
      id: "alerts",
      x: 0,
      y: 0,
      w: 4,
      h: 8,
      content: <AlertFeed />,
    },
    {
      id: "forecast",
      x: 0,
      y: 8,
      w: 12,
      h: 6,
      content: (
        <Panel
          title="Demand Forecast"
          status={forecast ? (forecast.method === "llm" ? "live" : "demo") : "loading"}
          description="Next ~12h demand outlook plus a 7-day structural projection (forecasted weather, Ontario calendar/holidays, scheduled events, persistent transit/construction). Runs on the active model — point NEMOTRON_BASE_URL at a Nemotron NIM (GX10) for on-device reasoning."
          updatedAt={forecast?.generatedAt}
          dataHref={`/api/forecast?${ctxQuery}`}
          note={forecast ? `${forecast.method === "llm" ? "model-reasoned" : "heuristic"}${forecast.mlPowered ? " · ML" : ""} · ${forecast.provider}/${forecast.model}` : undefined}
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
              {forecast.mlPowered && (
                <span class="ml-badge" title="Blended with CityFlow gradient-boosting ML model">ML-powered</span>
              )}
              <p class="forecast-headline">{forecast.headline}</p>
              {week && week.days.length > 0 && (
                <div class="forecast-week">
                  <div class="forecast-week-head">
                    <span class="forecast-sub">7-day outlook</span>
                    <span class="muted">
                      {week.headline} · weather {week.weatherStatus}
                    </span>
                  </div>
                  <div class="forecast-week-strip">
                    {week.days.map((d) => (
                      <div
                        key={d.date}
                        class={`forecast-day${d.isWeekend ? " is-weekend" : ""}`}
                        title={`${d.dayName} ${d.date}\nPeak ${d.peakWindow} (${d.peakLevel})\n${d.note}`}
                      >
                        <div class="forecast-day-name">
                          {d.dayName}
                          {d.isHoliday && <span class="forecast-day-holiday" title={d.holidayName}>★</span>}
                        </div>
                        <span
                          class="forecast-pill forecast-day-pill"
                          style={{ background: FORECAST_COLOR[d.peakLevel], color: "#0b0f17" }}
                        >
                          {d.peakLevel}
                        </span>
                        <div class="forecast-day-peak">{d.peakWindow}</div>
                        <div class="forecast-day-meta muted">
                          {d.highTempC != null ? `${d.highTempC}°/${d.lowTempC}°` : "—"}
                          {d.events > 0 && ` · ${d.events}ev`}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
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
      y: 14,
      w: 8,
      h: 5,
      content: (
        <Panel
          title="Live Toronto TV"
          status={liveTvStatus}
          description="Live news streams — CP24, CityNews, Global & CBC — resolved in real time."
          dataHref="/api/livetv"
        >
          <LiveTV onStatus={setLiveTvStatus} />
        </Panel>
      ),
    },
    {
      id: "flow",
      x: 8,
      y: 14,
      w: 4,
      h: 5,
      content: (
        <Panel
          title="City Flow — Hotspots"
          status={flow ? "live" : "loading"}
          description="Where Toronto is busiest right now: a live demand/activity score aggregated per neighbourhood (bike demand, transit, construction, 311, development, events)."
          count={flow?.features.length}
          updatedAt={flow?.generatedAt}
          dataHref="/api/flow"
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
      y: 19,
      w: 6,
      h: 5,
      content: (
        <Panel
          title="Upcoming Events, Games & Concerts"
          status={eventGroup?.status ?? "loading"}
          description="Soonest first: stadium games, concerts & big events that pull crowds nearby — pro sports + FIFA World Cup 2026 (ESPN, live), plus Ticketmaster & PredictHQ when keys are set. Upcoming Ontario stat holidays shown too."
          count={eventGroup?.nearby.length}
          updatedAt={eventGroup?.fetchedAt}
          note={eventGroup?.note}
          dataHref={`/api/context?${ctxQuery}`}
        >
          {!eventGroup ? (
            <div class="muted">Loading…</div>
          ) : eventGroup.nearby.length === 0 ? (
            <div class="muted">No events found nearby right now.</div>
          ) : (
            <>
              {holidays.length > 0 && (
                <div class="holiday-strip" title="Ontario statutory holidays affect demand & hours">
                  <span class="holiday-strip-label">Stat holidays</span>
                  {holidays.slice(0, 3).map((h) => (
                    <span key={h.date} class="holiday-chip">
                      <strong>{h.name}</strong>
                      <span class="muted">
                        {" "}
                        {h.inDays === 0 ? "today" : h.inDays === 1 ? "tomorrow" : `in ${h.inDays}d`}
                      </span>
                    </span>
                  ))}
                </div>
              )}
              <ul class="list">
                {eventGroup.nearby.slice(0, 12).map((r) => (
                  <li key={r.id}>
                    <strong>{r.title}</strong>
                    {r.detail && <span class="muted"> — {r.detail}</span>}
                    {r.distanceM != null && <span class="dist">{r.distanceM}m</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Panel>
      ),
    },
    {
      id: "sources",
      x: 6,
      y: 19,
      w: 6,
      h: 5,
      content: (
        <Panel
          title="Data Sources"
          status={context ? "live" : "loading"}
          description="Provenance of every feed powering this dashboard. LIVE = real city/open data. Each row links to its source."
          count={totalSources}
          dataHref={`/api/context?${ctxQuery}`}
        >
          {context ? (
            <ul class="list">
              <li>
                <strong>Weather</strong>
                <a class="src-link" href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">Open-Meteo ↗</a>
                <span class={`badge badge-${context.weather.status}`} style={{ marginLeft: "auto" }}><i class="badge-dot" />{context.weather.status.toUpperCase()}</span>
              </li>
              <li>
                <strong>Air Quality</strong>
                <a class="src-link" href="https://open-meteo.com/en/docs/air-quality-api" target="_blank" rel="noopener noreferrer">Open-Meteo Air Quality ↗</a>
                <span class={`badge badge-${context.airQuality.status}`} style={{ marginLeft: "auto" }}><i class="badge-dot" />{context.airQuality.status.toUpperCase()}</span>
              </li>
              {context.civic.map((g) => (
                <li key={g.source}>
                  <strong>{CATEGORY_LABEL[g.category]}</strong>
                  {g.url ? (
                    <a class="src-link" href={g.url} target="_blank" rel="noopener noreferrer" title={g.attribution ?? g.label}>{g.label} ↗</a>
                  ) : (
                    <span class="muted"> {g.label}</span>
                  )}
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
      y: 24,
      w: 3,
      h: 3,
      content: (
        <Panel
          title="Weather"
          status={context?.weather.status ?? "loading"}
          description="Current conditions at your location from Open-Meteo."
          updatedAt={context?.weather.fetchedAt}
          dataHref={`/api/context?${ctxQuery}`}
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
      y: 24,
      w: 3,
      h: 3,
      content: (
        <Panel
          title="Air Quality"
          status={context?.airQuality.status ?? "loading"}
          description="US AQI and particulate levels around your business."
          updatedAt={context?.airQuality.fetchedAt}
          dataHref={`/api/context?${ctxQuery}`}
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
      x: ((i + 2) % 4) * 3,
      y: 24 + Math.floor((i + 2) / 4) * 3,
      w: 3,
      h: 3,
      content: (
        <Panel
          title={`${CATEGORY_LABEL[g.category]} · ${g.label}`}
          status={g.status}
          description={CATEGORY_DESC[g.category]}
          count={g.areaWide ? undefined : g.nearby.length}
          updatedAt={g.fetchedAt}
          note={g.note ?? (g.areaWide ? "City-wide sample (dataset has no coordinates)" : `${g.nearby.length} within ${context!.scope.radiusM}m`)}
          dataHref={`/api/context?${ctxQuery}`}
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
          <span class={`provider-badge provider-${provider}`} title={`Active intelligence stack — LLM provider: ${provider}`}>
            <i class="provider-dot" />
            {engineLabel(provider)}
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
          <button class="btn-ghost" title="Close terminal" data-close-terminal onClick={() => {
            document.getElementById("terminal-app")?.setAttribute("aria-hidden", "true");
            document.body.classList.remove("terminal-open");
          }}>✕ Close</button>
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
          <MapCamera business={selected} />
        </div>

        {/* ---- Panels (drag to reorder, resize from edges) ---- */}
        <div class="grid-hint">Drag tiles by their header · resize from the edges · <button class="linklike" onClick={() => resetDashboardLayout()}>reset</button></div>
        <DashboardGrid tiles={tiles} />
      </div>

      {showSetup && <BusinessSetup onCreated={onCreated} onCancel={() => setShowSetup(false)} />}
    </div>
  );
}
