import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { businesses, sessions, snapshots, businessHistory, businessSchedule, type BusinessInput, type SessionRecord } from "./db.ts";
import { geocode } from "./geo.ts";
import { clientIp, isValidEmail, newToken, sessionFromRequest, SESSION_HEADER } from "./auth.ts";
import { acquireModelSlot, hit, LIMITS } from "./ratelimit.ts";
import { CIVIC_SOURCES, getCivicSource, loadCivicSource, sourceUrl } from "./sources/civic.ts";
import { getAirQuality, getWeather } from "./sources/environment.ts";
import { LIVE_CHANNELS, resolveChannel } from "./sources/livetv.ts";
import { computeFlow } from "./sources/neighbourhoods.ts";
import { getTraffic } from "./sources/traffic.ts";
import { getTransitRoutes } from "./sources/transit-routes.ts";
import { transitContext } from "./sources/transit-nearby.ts";
import { getGoTrains } from "./sources/go-transit.ts";
import { holidaysSource } from "./sources/holidays.ts";
import { buildContext, scopeFromBusiness } from "./ai/context.ts";
import {
  forecastForBusiness,
  forecastForPoint,
  weekForecastForBusiness,
  weekForecastForPoint,
} from "./ai/forecast.ts";
import { SAMPLE_LOCATIONS, exampleForPoint, toJsonl } from "./ai/dataset.ts";
import { askForBusiness, askForPoint, buildBusinessAgentRequest } from "./ai/agent.ts";
import { enqueueBusinessResearch, researchStatus, runBusinessResearch } from "./ai/web-agent.ts";
import { findSimilarMoments } from "./ai/patterns.ts";
import { startSnapshotService } from "./ai/snapshot.ts";
import { startMonitor } from "./ai/monitor.ts";
import {
  recentAlerts,
  registerSseClient,
  unregisterSseClient,
  sseClientCount,
} from "./ai/alerts.ts";
import { activeProvider, chat, chatStream, describeChain, resolveProvider } from "./ai/provider.ts";
import { mlWeeklyProfile, mlAvailable, resetMlAvailability } from "./ai/mlforecast.ts";
import { parakeetHealth, parakeetTranscribe, PARAKEET_BASE } from "./ai/parakeet.ts";
import { nearestCameras, cameraImageUrl } from "./sources/cameras.ts";
import { rlOptimizer } from "./ai/rloptimizer.ts";
import { aiManifest } from "./manifest.ts";
import type { CivicRecord, GeoPoint } from "./types.ts";

// Load .env (Node ≥20.6 / 24). No-op if the file is absent — keys stay optional.
try {
  process.loadEnvFile();
} catch {
  // no .env present; sources fall back to keyless/demo modes
}

// Session is attached to the request context by the guardrail middleware so
// downstream handlers can read the authenticated operator/business.
type AppEnv = { Variables: { session: SessionRecord | null } };
const app = new Hono<AppEnv>();
// Allow the (separately-hosted) frontend to call this API cross-origin. Defaults
// to "*" for the public demo; set CORS_ORIGIN=https://your-app.vercel.app to lock
// it down. No credentials/cookies are used, so "*" is safe here. The custom
// session header must be allow-listed so browsers send it cross-origin.
const corsOrigin = process.env.CORS_ORIGIN ?? "*";
app.use("/api/*", cors({
  origin: corsOrigin,
  allowHeaders: ["Content-Type", "Authorization", SESSION_HEADER],
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
}));

// ---- Guardrails: per-IP rate limit + session gate on protected endpoints ----
// Public endpoints don't need a session (health, onboarding, AI manifest); every
// other /api route requires a valid session token so a public deployment can't
// be scraped or used to hammer the model anonymously.
const PUBLIC_API = new Set(["/api/health", "/api/manifest"]);
function isPublicApiPath(path: string): boolean {
  return PUBLIC_API.has(path) || path.startsWith("/api/auth/");
}

app.use("/api/*", async (c, next) => {
  if (c.req.method === "OPTIONS") return next();
  const path = new URL(c.req.url).pathname;
  const ip = clientIp(c);

  // 1. Coarse per-IP rate limit across the whole API.
  const ipLimit = hit(`ip:${ip}`, LIMITS.ipPerMin(), 60_000);
  if (!ipLimit.allowed) {
    return c.json({ error: "rate_limited", scope: "ip", retryAfter: ipLimit.retryAfter }, 429, {
      "Retry-After": String(ipLimit.retryAfter),
    });
  }

  // 2. Public endpoints skip the session requirement.
  if (isPublicApiPath(path)) {
    c.set("session", null);
    return next();
  }

  // 3. Everything else requires a valid session token.
  const session = sessionFromRequest(c);
  if (!session) {
    return c.json({ error: "unauthorized", message: "Complete onboarding to use CityFlow." }, 401);
  }
  c.set("session", session);

  // 4. Expensive model endpoints get a tighter per-session budget.
  if (path === "/api/agent" || path === "/api/agent/stream") {
    const agentLimit = hit(`agent:${session.token}`, LIMITS.agentPerMin(), 60_000);
    if (!agentLimit.allowed) {
      return c.json({ error: "rate_limited", scope: "agent", retryAfter: agentLimit.retryAfter }, 429, {
        "Retry-After": String(agentLimit.retryAfter),
      });
    }
  }
  return next();
});

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
    llm: describeChain(),
    sources: CIVIC_SOURCES.map((s) => s.key),
    sseClients: sseClientCount(),
    patternRows: snapshots.count(),
    rl: {
      episodes: rlOptimizer.episodeCount,
      policySteps: rlOptimizer.policySteps,
      avgReward: Number(rlOptimizer.avgReward.toFixed(3)),
    },
  }),
);

// ---- AI-friendly manifest (tools + endpoints) ----
app.get("/api/manifest", (c) => c.json(aiManifest()));
app.get("/.well-known/ai-plugin.json", (c) => c.json(aiManifest()));

// ---- Auth / onboarding (public deployment guardrail) ----
/**
 * Create (or geocode → persist) a business from a request body. Shared by the
 * onboarding flow and the in-app "+ Business" action. Throws an Error whose
 * `.status` carries the HTTP code for the caller to surface.
 */
async function createBusinessFromInput(
  body: Record<string, unknown>,
  owner?: { email?: string; name?: string },
): Promise<ReturnType<typeof businesses.create>> {
  if (!body?.name || !body?.businessType || !body?.address) {
    const err = new Error("name, businessType and address are required") as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  let lon = Number(body.lon);
  let lat = Number(body.lat);
  let neighbourhood = body.neighbourhood as string | undefined;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    const geo = await geocode(String(body.address));
    if (!geo) {
      const err = new Error("could not geocode address within Toronto") as Error & { status?: number };
      err.status = 422;
      throw err;
    }
    lon = geo.lon;
    lat = geo.lat;
    neighbourhood = neighbourhood ?? geo.neighbourhood;
  }
  const transit = transitContext({ lon, lat });
  const input: BusinessInput = {
    name: String(body.name),
    businessType: String(body.businessType),
    address: String(body.address),
    lon,
    lat,
    ward: body.ward as string | undefined,
    neighbourhood,
    headcount: Number(body.headcount) || 1,
    notes: body.notes as string | undefined,
    opensAt: clampHour(body.opensAt),
    closesAt: clampHour(body.closesAt),
    eventRadiusKm: posNum(body.eventRadiusKm),
    customersPerWorkerHour: posNum(body.customersPerWorkerHour),
    hourlyWage: posNum(body.hourlyWage),
    minStaff: posInt(body.minStaff),
    maxStaffPerHour: posInt(body.maxStaffPerHour),
    allowedShiftLengths: cleanShiftLengths(body.allowedShiftLengths),
    transitRelevance: transit.relevance,
    nearbyRoutes: transit.routes.map((r) => r.name),
  };
  const created = businesses.create(input, owner);
  enqueueBusinessResearch(created);
  return created;
}

function getOwnedBusiness(c: Parameters<typeof sessionFromRequest>[0], id: string) {
  const session = sessionFromRequest(c);
  if (!session) return null;
  const b = businesses.get(id);
  if (!b) return null;
  return businesses.owns(b.id, session.operatorEmail) ? b : null;
}

/**
 * Onboarding: the multi-step form posts operator identity + business details +
 * acceptance of the acceptable-use terms. We validate, throttle by IP and email,
 * create the business, and mint a session token that gates the rest of the API.
 */
app.post("/api/auth/register", async (c) => {
  const ip = clientIp(c);
  const reg = hit(`register:${ip}`, LIMITS.registerPerHour(), 3_600_000);
  if (!reg.allowed) {
    return c.json({ error: "rate_limited", scope: "register", retryAfter: reg.retryAfter }, 429, {
      "Retry-After": String(reg.retryAfter),
    });
  }

  const body = await c.req.json().catch(() => null);
  const operatorName = typeof body?.operatorName === "string" ? body.operatorName.trim() : "";
  const operatorEmail = typeof body?.operatorEmail === "string" ? body.operatorEmail.trim().toLowerCase() : "";
  const acceptedTerms = body?.acceptedTerms === true;
  const business = body?.business as Record<string, unknown> | undefined;

  if (!operatorName || operatorName.length > 120) return c.json({ error: "operator name is required" }, 400);
  if (!isValidEmail(operatorEmail)) return c.json({ error: "a valid email is required" }, 400);
  if (!acceptedTerms) return c.json({ error: "you must accept the acceptable-use terms" }, 400);
  if (!business) return c.json({ error: "business details are required" }, 400);

  // Throttle repeat signups from the same email (abuse guard).
  const sinceHour = new Date(Date.now() - 3_600_000).toISOString();
  if (sessions.countByEmailSince(operatorEmail, sinceHour) >= 5) {
    return c.json({ error: "rate_limited", scope: "email", retryAfter: 3600 }, 429, { "Retry-After": "3600" });
  }

  let created;
  try {
    created = await createBusinessFromInput(business, { email: operatorEmail, name: operatorName });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return c.json({ error: err instanceof Error ? err.message : "could not create business" }, status as 400);
  }

  const token = newToken();
  sessions.create({
    token,
    businessId: created.id,
    operatorName,
    operatorEmail,
    company: (business.name as string) ?? undefined,
  });
  return c.json({ token, business: created, operator: { name: operatorName, email: operatorEmail } }, 201);
});

/** Validate an existing token (used on app load to resume a session). */
app.get("/api/auth/session", (c) => {
  const session = sessionFromRequest(c);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  const business = session.businessId && businesses.owns(session.businessId, session.operatorEmail)
    ? businesses.get(session.businessId) ?? null
    : null;
  return c.json({
    operator: { name: session.operatorName, email: session.operatorEmail },
    business,
    createdAt: session.createdAt,
  });
});

/** Sign out — invalidate the token. */
app.post("/api/auth/logout", (c) => {
  const session = sessionFromRequest(c);
  if (session) sessions.remove(session.token);
  return c.json({ ok: true });
});

// ---- Geocoding ----
app.get("/api/geocode", async (c) => {
  const q = c.req.query("q");
  if (!q) return c.json({ error: "q required" }, 400);
  const result = await geocode(q);
  return result ? c.json(result) : c.json({ error: "not found in Toronto" }, 404);
});

// Derive transit relevance + nearby TTC/GO routes for a point (by address or coords).
// Powers the live "transit" preview on the business setup form.
app.get("/api/transit/nearby", async (c) => {
  let lon = Number(c.req.query("lon"));
  let lat = Number(c.req.query("lat"));
  let address = c.req.query("address") ?? undefined;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    if (!address) return c.json({ error: "address or lon/lat required" }, 400);
    const geo = await geocode(address);
    if (!geo) return c.json({ error: "could not geocode address within Toronto" }, 422);
    lon = geo.lon;
    lat = geo.lat;
    address = geo.displayName ?? address;
  }
  const ctx = transitContext({ lon, lat });
  return c.json({ lon, lat, address, ...ctx });
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
  c.json(CIVIC_SOURCES.map((s) => ({ key: s.key, label: s.label, category: s.category, attribution: s.attribution, url: sourceUrl(s) }))),
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
  try {
    const records = await loadAllRecords();
    return c.json(await computeFlow(records));
  } catch (err) {
    // The flow model depends on the neighbourhood-boundary dataset (CKAN), which
    // can hiccup. Never 500 the choropleth — return an empty collection so the
    // map + tile degrade gracefully instead of breaking the dashboard.
    console.warn("[flow] degraded to empty:", err instanceof Error ? err.message : err);
    return c.json({
      type: "FeatureCollection",
      generatedAt: new Date().toISOString(),
      features: [],
    });
  }
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

// ---- Statutory holidays (Ontario) ----
app.get("/api/holidays", (c) => {
  const n = Math.min(Math.max(Number(c.req.query("n") ?? 6), 1), 24);
  return c.json(holidaysSource(n));
});

// ---- Location context (the AI-friendly digest) ----
app.get("/api/context", async (c) => {
  const businessId = c.req.query("businessId");
  const radiusM = Number(c.req.query("radius") ?? 750);
  if (businessId) {
    const b = getOwnedBusiness(c, businessId);
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
      const b = getOwnedBusiness(c, businessId);
      if (!b) return c.json({ error: "business not found" }, 404);
      return c.json(await forecastForBusiness(b.id, radiusM));
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
      const b = getOwnedBusiness(c, businessId);
      if (!b) return c.json({ error: "business not found" }, 404);
      return c.json(await weekForecastForBusiness(b.id, radiusM));
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
app.get("/api/businesses", (c) => {
  const session = sessionFromRequest(c);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  return c.json(businesses.list(session.operatorEmail));
});

app.get("/api/businesses/:id", (c) => {
  const b = getOwnedBusiness(c, c.req.param("id"));
  return b ? c.json(b) : c.json({ error: "not found" }, 404);
});

app.post("/api/businesses", async (c) => {
  const session = sessionFromRequest(c);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json().catch(() => null);
  try {
    const created = await createBusinessFromInput(body ?? {}, {
      email: session.operatorEmail,
      name: session.operatorName,
    });
    return c.json(created, 201);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return c.json({ error: err instanceof Error ? err.message : "could not create business" }, status as 400);
  }
});

app.get("/api/businesses/:id/research", (c) => {
  const b = getOwnedBusiness(c, c.req.param("id"));
  if (!b) return c.json({ error: "not found" }, 404);
  const research = researchStatus(b.id);
  return c.json(research ?? { businessId: b.id, status: "pending", briefing: "", sources: [], generatedAt: null });
});

app.post("/api/businesses/:id/research", async (c) => {
  const b = getOwnedBusiness(c, c.req.param("id"));
  if (!b) return c.json({ error: "not found" }, 404);
  const radiusM = Number(c.req.query("radius") ?? 750);
  return c.json(await runBusinessResearch(b, radiusM));
});

app.delete("/api/businesses/:id", (c) => {
  const b = getOwnedBusiness(c, c.req.param("id"));
  if (!b) return c.json({ error: "not found" }, 404);
  if (b.isPublic) return c.json({ error: "forbidden", message: "demo business cannot be deleted" }, 403);
  return c.json({ deleted: businesses.remove(b.id) });
});

// ---- Generate business demand baseline on demand ----
app.post("/api/businesses/:id/generate", async (c) => {
  const b = getOwnedBusiness(c, c.req.param("id"));
  if (!b) return c.json({ error: "not found" }, 404);
  const days = Math.min(Number(c.req.query("days") ?? 90), 365);
  // Dynamically import so the generator only loads when called.
  const { generateBusinessData } = await import("./ai/bizdata.ts");
  const { history, schedule } = generateBusinessData(b.id, b.businessType, b.headcount || 4, days);
  businessHistory.upsertMany(history);
  businessSchedule.upsertMany(schedule);
  return c.json({ historyRows: history.length, scheduleRows: schedule.length });
});

// ---- Business history (revenue + customer counts) ----
app.get("/api/businesses/:id/history", (c) => {
  const b = getOwnedBusiness(c, c.req.param("id"));
  if (!b) return c.json({ error: "not found" }, 404);
  const days = Math.min(Number(c.req.query("days") ?? 90), 365);
  const rows = businessHistory.forBusiness(b.id, days);
  const summary = businessHistory.summary(b.id);
  return c.json({ businessId: b.id, days, summary, rows });
});

app.post("/api/businesses/:id/history", async (c) => {
  const b = getOwnedBusiness(c, c.req.param("id"));
  if (!b) return c.json({ error: "not found" }, 404);
  const body = await c.req.json().catch(() => null);
  if (!Array.isArray(body?.rows)) return c.json({ error: "rows array required" }, 400);
  const rows = (body.rows as Array<Record<string, unknown>>).map((r) => ({
    business_id: b.id,
    date: String(r.date ?? ""),
    hour: Number(r.hour ?? 0),
    revenue: r.revenue != null ? Number(r.revenue) : null,
    customer_count: r.customer_count != null ? Number(r.customer_count) : null,
    notes: r.notes ? String(r.notes) : null,
  }));
  businessHistory.upsertMany(rows);
  return c.json({ inserted: rows.length });
});

// ---- Business schedule (staff hours) ----
app.get("/api/businesses/:id/schedule", (c) => {
  const b = getOwnedBusiness(c, c.req.param("id"));
  if (!b) return c.json({ error: "not found" }, 404);
  const upcoming = businessSchedule.upcoming(b.id, 7);
  const recent   = businessSchedule.forBusiness(b.id, 14);
  return c.json({ businessId: b.id, upcoming, recent });
});

app.post("/api/businesses/:id/schedule", async (c) => {
  const b = getOwnedBusiness(c, c.req.param("id"));
  if (!b) return c.json({ error: "not found" }, 404);
  const body = await c.req.json().catch(() => null);
  if (!Array.isArray(body?.rows)) return c.json({ error: "rows array required" }, 400);
  const rows = (body.rows as Array<Record<string, unknown>>).map((r) => ({
    business_id: b.id,
    date: String(r.date ?? ""),
    hour: Number(r.hour ?? 0),
    staff_count: Number(r.staff_count ?? 1),
    role: r.role ? String(r.role) : null,
  }));
  businessSchedule.upsertMany(rows);
  return c.json({ inserted: rows.length });
});

// ---- Parakeet ASR (speech → text for agent input) ----
app.get("/api/asr/health", async (c) => {
  const h = await parakeetHealth();
  return c.json({
    available: h.available,
    loaded: h.loaded,
    url: h.url,
    error: h.error,
    hint: !h.available
      ? `Parakeet not reachable at ${PARAKEET_BASE} — set PARAKEET_URL in .env (e.g. http://10.10.25.20:8789)`
      : undefined,
  });
});

app.post("/api/asr/transcribe", async (c) => {
  const body = await c.req.parseBody();
  const file = body.audio;
  if (!file || typeof file === "string") return c.json({ error: "audio file required" }, 400);
  const buf = Buffer.from(await file.arrayBuffer());
  try {
    const text = await parakeetTranscribe(buf, file.name || "audio.webm");
    if (text === null) return c.json({ error: "ASR service unavailable" }, 503);
    if (!text) return c.json({ error: "empty transcript — speak longer or check the mic" }, 422);
    return c.json({ text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "transcription failed";
    return c.json({ error: msg }, 503);
  }
});

// ---- Traffic cameras (nearest CCTV to a business) ----
app.get("/api/cameras/nearest", async (c) => {
  const lon = Number(c.req.query("lon"));
  const lat = Number(c.req.query("lat"));
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    return c.json({ error: "lon and lat query params required" }, 400);
  }
  const n = Math.min(Math.max(Number(c.req.query("n") ?? 1), 1), 5);
  try {
    const cams = await nearestCameras({ lon, lat }, n);
    // Hand back our same-origin image proxy, not the upstream URL.
    return c.json(
      cams.map((cam) => ({
        recId: cam.recId,
        name: cam.name,
        mainRoad: cam.mainRoad,
        crossRoad: cam.crossRoad,
        lon: cam.lon,
        lat: cam.lat,
        distanceM: Math.round(cam.distanceM),
        imageUrl: `/api/cameras/${cam.recId}/image`,
        // Direct upstream https snapshot — lets the browser load the frame itself
        // if our same-origin proxy can't egress (e.g. locked-down GPU host).
        directUrl: cam.imageUrl,
      })),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "camera list unavailable";
    return c.json({ error: msg }, 503);
  }
});

// Same-origin proxy for a known camera's latest snapshot (fresh https frame).
app.get("/api/cameras/:recId/image", async (c) => {
  const recId = Number(c.req.param("recId"));
  if (!Number.isFinite(recId)) return c.json({ error: "bad camera id" }, 400);
  const url = await cameraImageUrl(recId);
  if (!url) return c.json({ error: "unknown camera" }, 404);
  try {
    const upstream = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!upstream.ok) {
      return c.json({ error: `camera image HTTP ${upstream.status}` }, 502);
    }
    const bytes = await upstream.arrayBuffer();
    return c.body(bytes, 200, {
      "content-type": upstream.headers.get("content-type") ?? "image/jpeg",
      "cache-control": "public, max-age=20",
    });
  } catch {
    return c.json({ error: "camera image unreachable" }, 502);
  }
});

// ---- ML microservice proxy ----
app.get("/api/ml/health", async (c) => {
  const available = await mlAvailable();
  return c.json({ available });
});

app.get("/api/ml/profile", async (c) => {
  const type = c.req.query("type") ?? "cafe";
  const weather = c.req.query("weather") ?? "clear";
  const event = c.req.query("event") === "true";
  const disruption = c.req.query("disruption") === "true";
  const profile = await mlWeeklyProfile(type, { weather, event, disruption });
  if (!profile) return c.json({ error: "ML service unavailable" }, 503);
  return c.json(profile);
});

app.post("/api/ml/train", async (c) => {
  const body = await c.req.json().catch(() => null);
  const type = body?.type ?? "cafe";
  resetMlAvailability();
  try {
    const res = await fetch("http://localhost:8788/train", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type, days: body?.days ?? 730 }),
    });
    if (!res.ok) return c.json({ error: "train failed" }, 502);
    return c.json(await res.json());
  } catch {
    return c.json({ error: "ML service unavailable" }, 503);
  }
});

// ---- Agent ----
app.post("/api/agent", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.question) return c.json({ error: "question required" }, 400);
  if (typeof body.question === "string" && body.question.length > 2000) {
    return c.json({ error: "question too long (max 2000 chars)" }, 400);
  }
  const radiusM = Number(body.radiusM) || 750;
  // Global concurrency cap so a burst of users can't overload the model host.
  const release = acquireModelSlot();
  if (!release) {
    return c.json({ error: "model_busy", message: "The model is at capacity — try again shortly." }, 503, {
      "Retry-After": "5",
    });
  }
  try {
    if (body.businessId) {
      const b = getOwnedBusiness(c, String(body.businessId));
      if (!b) return c.json({ error: "business not found" }, 404);
      return c.json(await askForBusiness(b.id, body.question, radiusM));
    }
    const lon = Number(body.lon);
    const lat = Number(body.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      return c.json({ error: "provide businessId or lon+lat" }, 400);
    }
    return c.json(await askForPoint(lon, lat, body.question, { radiusM, businessType: body.businessType }));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "agent error" }, 500);
  } finally {
    release();
  }
});

// Streaming agent — emits SSE frames with `delta` tokens as the model generates
// them, so the chat UI renders the answer live instead of waiting for the full
// response. Falls back to the non-streaming /api/agent for point-only queries.
app.post("/api/agent/stream", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.question) return c.json({ error: "question required" }, 400);
  if (typeof body.question === "string" && body.question.length > 2000) {
    return c.json({ error: "question too long (max 2000 chars)" }, 400);
  }
  if (!body.businessId) return c.json({ error: "businessId required for streaming" }, 400);
  const b = getOwnedBusiness(c, String(body.businessId));
  if (!b) return c.json({ error: "business not found" }, 404);
  const radiusM = Number(body.radiusM) || 750;
  const useGradient = body.useGradient !== false;

  // Global concurrency cap so a burst of users can't overload the model host.
  const release = acquireModelSlot();
  if (!release) {
    return c.json({ error: "model_busy", message: "The model is at capacity — try again shortly." }, 503, {
      "Retry-After": "5",
    });
  }

  const stream = new ReadableStream<string>({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(`data: ${JSON.stringify(obj)}\n\n`);
        } catch {
          /* client disconnected */
        }
      };

      // Build the prompt/context once (may throw → report and close).
      let req;
      try {
        req = await buildBusinessAgentRequest(b.id, body.question, radiusM, { useGradient });
      } catch (err) {
        send({ error: err instanceof Error ? err.message : "agent error" });
        try { controller.close(); } catch { /* already closed */ }
        release();
        return;
      }

      const { provider, model, fallbacks } = await resolveProvider();
      send({ meta: true, provider, model, fallbacks, gradientUsed: req.gradientUsed, contextUsed: req.contextUsed });

      // Stream tokens. If streaming yields nothing visible (e.g. a provider whose
      // delta shape we don't recognise, or output that was entirely a stripped
      // <think> trace) or throws mid-stream, fall back to a single non-streaming
      // call so the answer ALWAYS comes through.
      let emitted = 0;
      let streamErr: unknown = null;
      try {
        for await (const delta of chatStream(req.messages, req.opts)) {
          if (delta) {
            emitted += delta.length;
            send({ delta });
          }
        }
      } catch (err) {
        streamErr = err;
      }
      console.log(`[agent/stream] provider=${provider} model=${model} streamedChars=${emitted}${streamErr ? ` streamErr=${streamErr instanceof Error ? streamErr.message : String(streamErr)}` : ""}`);

      if (emitted === 0) {
        try {
          const result = await chat(req.messages, req.opts);
          console.log(`[agent/stream] fallback chat() chars=${result.text.length} preview=${JSON.stringify(result.text.slice(0, 120))}`);
          send({ delta: result.text || "(No response from the model.)" });
        } catch (err) {
          console.error(`[agent/stream] fallback chat() failed: ${err instanceof Error ? err.message : String(err)}`);
          send({ error: err instanceof Error ? err.message : "agent error" });
        }
      }

      send({ done: true });
      try { controller.close(); } catch { /* already closed */ }
      release();
    },
  });

  return new Response(stream as unknown as ReadableStream<Uint8Array>, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

function pointFromQuery(lon?: string, lat?: string): GeoPoint {
  const x = Number(lon);
  const y = Number(lat);
  return Number.isFinite(x) && Number.isFinite(y) ? { lon: x, lat: y } : TORONTO;
}

// ---- Demand-model input sanitizers (business setup form) ----
function clampHour(v: unknown): number | undefined {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : undefined;
}
function posNum(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
function posInt(v: unknown): number | undefined {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
function cleanShiftLengths(v: unknown): number[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const cleaned = [...new Set(v.map((x) => Math.round(Number(x))).filter((n) => n > 0 && n <= 24))].sort(
    (a, b) => a - b,
  );
  return cleaned.length ? cleaned : undefined;
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

  // The SSE pipeline enqueues strings (see alerts.ts); valid at runtime for
  // text/event-stream but BodyInit's types only model ReadableStream<Uint8Array>.
  return new Response(stream as unknown as ReadableStream<Uint8Array>, {
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
  let ctx;
  if (businessId) {
    const b = businesses.get(businessId);
    if (!b) return c.json({ error: "business not found" }, 404);
    ctx = await buildContext(scopeFromBusiness(b, radiusM));
  } else {
    ctx = await buildContext({ point: p, radiusM });
  }
  return c.json({
    total: snapshots.count(),
    moments: findSimilarMoments(ctx, n),
  });
});

app.get("/api/patterns/stats", (c) =>
  c.json({ total: snapshots.count(), locations: 0 }),
);

// ---- Static frontend (production single-port mode) ----
// With SERVE_STATIC=1 (set by `npm run start`), serve the built SPA from ./dist
// so the whole app runs on ONE port — no Vite dev server, no proxy. The frontend
// uses relative /api paths, which now hit this same server directly. Registered
// AFTER all /api routes so it never shadows them; the final catch-all returns
// index.html for client-side routes (SPA fallback).
if (process.env.SERVE_STATIC === "1") {
  app.use("/*", serveStatic({ root: "./dist" }));
  app.get("*", serveStatic({ path: "./dist/index.html" }));
  console.log("[toronto-monitor] serving built frontend from ./dist (single-port mode)");
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`[toronto-monitor] API on http://localhost:${port} (LLM provider: ${activeProvider()})`);

// Start background snapshot capture — builds the historical pattern library over time.
startSnapshotService(15 * 60_000);

// Start proactive alert monitor — diffs signals every 5 min and broadcasts alerts via SSE.
startMonitor(5 * 60_000);
