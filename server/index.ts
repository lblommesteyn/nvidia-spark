import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { businesses, snapshots, type BusinessInput } from "./db.ts";
import { geocode } from "./geo.ts";
import { CIVIC_SOURCES, getCivicSource, loadCivicSource } from "./sources/civic.ts";
import { getAirQuality, getWeather } from "./sources/environment.ts";
import { LIVE_CHANNELS, resolveChannel } from "./sources/livetv.ts";
import { computeFlow } from "./sources/neighbourhoods.ts";
import { getTraffic } from "./sources/traffic.ts";
import { getTransitRoutes } from "./sources/transit-routes.ts";
import { getGoTrains } from "./sources/go-transit.ts";
import { buildContext, scopeFromBusiness } from "./ai/context.ts";
import {
  forecastForBusiness,
  forecastForPoint,
  weekForecastForBusiness,
  weekForecastForPoint,
} from "./ai/forecast.ts";
import { SAMPLE_LOCATIONS, exampleForPoint, toJsonl } from "./ai/dataset.ts";
import { askForBusiness, askForPoint } from "./ai/agent.ts";
import { findSimilarMoments } from "./ai/patterns.ts";
import { startSnapshotService } from "./ai/snapshot.ts";
import { startMonitor } from "./ai/monitor.ts";
import {
  recentAlerts,
  registerSseClient,
  unregisterSseClient,
  sseClientCount,
} from "./ai/alerts.ts";
import { activeProvider } from "./ai/provider.ts";
import { aiManifest } from "./manifest.ts";
import type { CivicRecord, GeoPoint } from "./types.ts";

// Load .env (Node ≥20.6 / 24). No-op if the file is absent — keys stay optional.
try {
  process.loadEnvFile();
} catch {
  // no .env present; sources fall back to keyless/demo modes
}

const app = new Hono();
app.use("/api/*", cors());

const TORONTO: GeoPoint = { lon: -79.3839, lat: 43.6535 };

/** Load + flatten every geolocated civic record across all sources. */
async function loadAllRecords(): Promise<CivicRecord[]> {
  const results = await Promise.all(CIVIC_SOURCES.map((def) => loadCivicSource(def)));
  return results.flatMap((r) => r.data.filter((rec) => rec.lon != null && rec.lat != null));
}

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    provider: activeProvider(),
    sources: CIVIC_SOURCES.map((s) => s.key),
    sseClients: sseClientCount(),
    patternRows: snapshots.count(),
  }),
);

// ---- AI-friendly manifest (tools + endpoints) ----
app.get("/api/manifest", (c) => c.json(aiManifest()));
app.get("/.well-known/ai-plugin.json", (c) => c.json(aiManifest()));

// ---- Geocoding ----
app.get("/api/geocode", async (c) => {
  const q = c.req.query("q");
  if (!q) return c.json({ error: "q required" }, 400);
  const result = await geocode(q);
  return result ? c.json(result) : c.json({ error: "not found in Toronto" }, 404);
});

// ---- Environment ----
app.get("/api/environment", async (c) => {
  const p = pointFromQuery(c.req.query("lon"), c.req.query("lat"));
  const [weather, airQuality] = await Promise.all([getWeather(p), getAirQuality(p)]);
  return c.json({ weather, airQuality });
});

// ---- Live TV (Toronto news channels) ----
app.get("/api/livetv", (c) =>
  c.json(
    LIVE_CHANNELS.map((ch) => ({
      id: ch.id,
      name: ch.name,
      description: ch.description,
    })),
  ),
);

app.get("/api/livetv/:id", async (c) => {
  const result = await resolveChannel(c.req.param("id"));
  return result ? c.json(result) : c.json({ error: "unknown channel" }, 404);
});

// ---- Civic data sources ----
app.get("/api/data/sources", (c) =>
  c.json(CIVIC_SOURCES.map((s) => ({ key: s.key, label: s.label, category: s.category }))),
);

app.get("/api/data/source/:key", async (c) => {
  const def = getCivicSource(c.req.param("key"));
  if (!def) return c.json({ error: "unknown source" }, 404);
  return c.json(await loadCivicSource(def));
});

/** All civic records flattened — used to render map markers. */
app.get("/api/data/map", async (c) => {
  const records = await loadAllRecords();
  return c.json({ count: records.length, records });
});

/** GeoJSON FeatureCollection of all geolocated records (for native map layers). */
app.get("/api/map/geo", async (c) => {
  const records = await loadAllRecords();
  return c.json({
    type: "FeatureCollection",
    features: records.map((r) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [r.lon, r.lat] },
      properties: {
        id: r.id,
        category: r.category,
        title: r.title,
        detail: r.detail ?? "",
        severity: (r.meta?.severity as string) ?? null,
        pressure: (r.meta?.pressure as string) ?? null,
        route: (r.meta?.route as string) ?? null,
      },
    })),
  });
});

/** Neighbourhood "flow" choropleth — aggregated demand/activity per area. */
app.get("/api/flow", async (c) => {
  const records = await loadAllRecords();
  return c.json(await computeFlow(records));
});

/** Live traffic congestion (red/amber/green road traces). */
app.get("/api/traffic", async (c) => {
  return c.json(await getTraffic());
});

/** TTC subway/streetcar + GO Transit route line shapes (curated GeoJSON). */
app.get("/api/transit/routes", (c) => {
  return c.json(getTransitRoutes());
});

/** GO Train positions (synthetic until a Metrolinx key is wired). */
app.get("/api/transit/go", (c) => {
  return c.json(getGoTrains());
});

// ---- Location context (the AI-friendly digest) ----
app.get("/api/context", async (c) => {
  const businessId = c.req.query("businessId");
  const radiusM = Number(c.req.query("radius") ?? 750);
  if (businessId) {
    const b = businesses.get(businessId);
    if (!b) return c.json({ error: "business not found" }, 404);
    return c.json(await buildContext(scopeFromBusiness(b, radiusM)));
  }
  const p = pointFromQuery(c.req.query("lon"), c.req.query("lat"));
  return c.json(
    await buildContext({ point: p, radiusM, businessType: c.req.query("type") ?? undefined }),
  );
});

// ---- Demand forecast (heuristic baseline + LLM/Nemotron reasoning) ----
app.get("/api/forecast", async (c) => {
  const businessId = c.req.query("businessId");
  const radiusM = Number(c.req.query("radius") ?? 750);
  try {
    if (businessId) {
      return c.json(await forecastForBusiness(businessId, radiusM));
    }
    const lon = Number(c.req.query("lon"));
    const lat = Number(c.req.query("lat"));
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      return c.json({ error: "provide businessId or lon+lat" }, 400);
    }
    return c.json(
      await forecastForPoint(lon, lat, { radiusM, businessType: c.req.query("type") ?? undefined }),
    );
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "forecast error" }, 500);
  }
});

// ---- Week-ahead demand forecast (7 days / 168h, structural heuristic) ----
app.get("/api/forecast/week", async (c) => {
  const businessId = c.req.query("businessId");
  const radiusM = Number(c.req.query("radius") ?? 750);
  try {
    if (businessId) {
      return c.json(await weekForecastForBusiness(businessId, radiusM));
    }
    const lon = Number(c.req.query("lon"));
    const lat = Number(c.req.query("lat"));
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      return c.json({ error: "provide businessId or lon+lat" }, 400);
    }
    return c.json(
      await weekForecastForPoint(lon, lat, { radiusM, businessType: c.req.query("type") ?? undefined }),
    );
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "week forecast error" }, 500);
  }
});

// ---- Fine-tuning dataset preview (context snapshots → JSONL training rows) ----
// Generates a small sample of training examples on the fly so the fine-tuning
// pipeline is demoable from the API. The full dataset is built via
// `npm run gen:dataset` (scripts/gen-forecast-dataset.ts).
app.get("/api/forecast/dataset", async (c) => {
  const n = Math.min(Number(c.req.query("n") ?? 3), SAMPLE_LOCATIONS.length);
  const format = (c.req.query("format") === "prompt" ? "prompt" : "messages") as "messages" | "prompt";
  const radiusM = Number(c.req.query("radius") ?? 750);
  const picks = SAMPLE_LOCATIONS.slice(0, n);
  const examples = await Promise.all(
    picks.map((loc) => exampleForPoint(loc.point, { radiusM, businessType: loc.businessType })),
  );
  if (c.req.query("jsonl") === "1") {
    return c.text(toJsonl(examples, format) + "\n", 200, { "content-type": "application/jsonl" });
  }
  return c.json({
    provider: activeProvider(),
    count: examples.length,
    format,
    labelledBy: examples[0]?.meta.label ?? "heuristic",
    examples,
  });
});

// ---- Businesses CRUD ----
app.get("/api/businesses", (c) => c.json(businesses.list()));

app.get("/api/businesses/:id", (c) => {
  const b = businesses.get(c.req.param("id"));
  return b ? c.json(b) : c.json({ error: "not found" }, 404);
});

app.post("/api/businesses", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.name || !body?.businessType || !body?.address) {
    return c.json({ error: "name, businessType and address are required" }, 400);
  }
  // Geocode the address unless explicit coords are supplied.
  let lon = Number(body.lon);
  let lat = Number(body.lat);
  let neighbourhood = body.neighbourhood as string | undefined;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    const geo = await geocode(body.address);
    if (!geo) return c.json({ error: "could not geocode address within Toronto" }, 422);
    lon = geo.lon;
    lat = geo.lat;
    neighbourhood = neighbourhood ?? geo.neighbourhood;
  }
  const input: BusinessInput = {
    name: body.name,
    businessType: body.businessType,
    address: body.address,
    lon,
    lat,
    ward: body.ward,
    neighbourhood,
    headcount: Number(body.headcount) || 1,
    notes: body.notes,
  };
  return c.json(businesses.create(input), 201);
});

app.delete("/api/businesses/:id", (c) =>
  c.json({ deleted: businesses.remove(c.req.param("id")) }),
);

// ---- Agent ----
app.post("/api/agent", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.question) return c.json({ error: "question required" }, 400);
  const radiusM = Number(body.radiusM) || 750;
  try {
    if (body.businessId) {
      return c.json(await askForBusiness(body.businessId, body.question, radiusM));
    }
    const lon = Number(body.lon);
    const lat = Number(body.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      return c.json({ error: "provide businessId or lon+lat" }, 400);
    }
    return c.json(await askForPoint(lon, lat, body.question, { radiusM, businessType: body.businessType }));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "agent error" }, 500);
  }
});

function pointFromQuery(lon?: string, lat?: string): GeoPoint {
  const x = Number(lon);
  const y = Number(lat);
  return Number.isFinite(x) && Number.isFinite(y) ? { lon: x, lat: y } : TORONTO;
}

// ---- Proactive alerts ----
app.get("/api/alerts", (c) => {
  const n = Math.min(Number(c.req.query("n") ?? 20), 100);
  return c.json(recentAlerts(n));
});

// Server-Sent Events stream — browser clients connect here to receive alerts in real time.
app.get("/api/alerts/stream", (c) => {
  const stream = new ReadableStream<string>({
    start(controller) {
      const clientId = registerSseClient(controller);
      // Send a connected confirmation and recent history immediately.
      try {
        controller.enqueue(`: connected\n\n`);
        for (const alert of recentAlerts(10).reverse()) {
          controller.enqueue(`data: ${JSON.stringify(alert)}\n\n`);
        }
      } catch { /* ignore — client may have disconnected */ }

      // Clean up when the browser tab closes or navigates away.
      c.req.raw.signal?.addEventListener("abort", () => {
        unregisterSseClient(clientId);
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    },
  });
});

// ---- Historical patterns API ----
app.get("/api/patterns", async (c) => {
  const p = pointFromQuery(c.req.query("lon"), c.req.query("lat"));
  const n = Math.min(Number(c.req.query("n") ?? 12), 50);
  const businessId = c.req.query("businessId");
  const radiusM = Number(c.req.query("radius") ?? 750);
  const ctx = businessId
    ? await buildContext(scopeFromBusiness(businesses.get(businessId)!, radiusM))
    : await buildContext({ point: p, radiusM });
  return c.json({
    total: snapshots.count(),
    moments: findSimilarMoments(ctx, n),
  });
});

app.get("/api/patterns/stats", (c) =>
  c.json({ total: snapshots.count(), locations: 0 }),
);

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`[toronto-monitor] API on http://localhost:${port} (LLM provider: ${activeProvider()})`);

// Start background snapshot capture — builds the historical pattern library over time.
startSnapshotService(15 * 60_000);

// Start proactive alert monitor — diffs signals every 5 min and broadcasts alerts via SSE.
startMonitor(5 * 60_000);
