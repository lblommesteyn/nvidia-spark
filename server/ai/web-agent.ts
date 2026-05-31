/**
 * Street-intelligence web agent: gathers City of Toronto live/open data around a
 * business, optionally synthesizes a briefing via Ollama, and caches it for the
 * Nemotron Q&A agent.
 *
 * Env (optional — rule-based briefing works with no LLM):
 *   OLLAMA_WEB_AGENT_HOST   default http://localhost:11434
 *   OLLAMA_WEB_AGENT_MODEL  e.g. llama3.2:3b (fast). If unset, uses structured briefing only.
 */
import { buildContext, scopeFromBusiness, type LocationContext } from "./context.ts";
import { weekForecastForBusiness } from "./forecast.ts";
import { businessResearch } from "../db.ts";
import { distanceM } from "../geo.ts";
import { getTraffic, type TrafficFeature } from "../sources/traffic.ts";
import { fetchJson } from "../cache.ts";
import type { BusinessProfile } from "../types.ts";

export interface BusinessResearch {
  businessId: string;
  status: "pending" | "ready" | "error";
  briefing: string;
  sources: string[];
  generatedAt: string;
  error?: string;
}

interface ResearchBundle {
  business: BusinessProfile;
  ctx: LocationContext;
  trafficNear: { road: string; congestion: string; distanceM: number }[];
  weekHeadline: string;
  weekDays: { day: string; peak: string; level: string; events: number }[];
}

function trafficNearPoint(
  features: TrafficFeature[],
  point: { lon: number; lat: number },
  maxM = 1200,
  limit = 8,
): ResearchBundle["trafficNear"] {
  return features
    .map((f) => {
      const coords = f.geometry.coordinates;
      const mid = coords[Math.floor(coords.length / 2)] ?? coords[0];
      if (!mid) return null;
      const dist = distanceM(point, { lon: mid[0], lat: mid[1] });
      return {
        road: f.properties.road,
        congestion: f.properties.congestion,
        distanceM: dist,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x != null && x.distanceM <= maxM)
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, limit);
}

async function gatherBundle(business: BusinessProfile, radiusM = 750): Promise<ResearchBundle> {
  const [ctx, traffic, week] = await Promise.all([
    buildContext(scopeFromBusiness(business, radiusM)),
    getTraffic(),
    weekForecastForBusiness(business.id, radiusM),
  ]);

  const trafficNear = trafficNearPoint(traffic.features, { lon: business.lon, lat: business.lat });

  return {
    business,
    ctx,
    trafficNear,
    weekHeadline: week.headline,
    weekDays: week.days.slice(0, 7).map((d) => ({
      day: d.dayName,
      peak: d.peakWindow,
      level: d.peakLevel,
      events: d.events,
    })),
  };
}

function structuredBriefing(bundle: ResearchBundle): { text: string; sources: string[] } {
  const { business, ctx, trafficNear, weekHeadline, weekDays } = bundle;
  const sources = new Set<string>(["City of Toronto Open Data (CKAN)", "Open-Meteo weather/AQ"]);

  for (const g of ctx.civic) {
    if (g.attribution) sources.add(g.attribution);
    else if (g.status === "live") sources.add(g.label);
  }
  if (trafficNear.length) sources.add("TomTom / traffic model");

  const civicLines = ctx.civic
    .filter((g) => g.nearby.length > 0)
    .map((g) => {
      const top = g.nearby.slice(0, 5).map((r) => {
        const d = r.distanceM != null ? ` ~${r.distanceM}m` : "";
        return `    • ${r.title}${d}${r.detail ? ` — ${r.detail}` : ""}`;
      });
      return `  ${g.label} [${g.status}]:\n${top.join("\n")}`;
    });

  const trafficLines = trafficNear.map(
    (t) => `    • ${t.road}: ${t.congestion} congestion (~${t.distanceM}m from storefront)`,
  );

  const weekLines = weekDays.map(
    (d) => `    • ${d.day}: peak ${d.peak} (${d.level})${d.events ? `, ${d.events} nearby events` : ""}`,
  );

  const w = ctx.weather.data as { temperatureC?: number; description?: string };
  const weatherLine = w
    ? `Current weather: ${w.temperatureC}°C, ${w.description}.`
    : "";

  const text = [
    `LOCATION BRIEFING — ${business.name} (${business.businessType})`,
    `Address: ${business.address}${business.neighbourhood ? ` · ${business.neighbourhood}` : ""}`,
    `Staff baseline: ${business.headcount}`,
    business.notes ? `Owner notes: ${business.notes}` : "",
    "",
    weatherLine,
    "",
    "STREET & TRAFFIC (live/nearby):",
    trafficLines.length ? trafficLines.join("\n") : "    • No major congestion segments within 1.2km.",
    "",
    "CITY OF TORONTO & CIVIC SIGNALS (within search radius):",
    civicLines.length ? civicLines.join("\n\n") : "    • No nearby civic records in radius.",
    "",
    "7-DAY DEMAND OUTLOOK (structural + weather):",
    `  ${weekHeadline}`,
    weekLines.join("\n"),
    "",
    "KEY SIGNALS:",
    ...ctx.highlights.map((h) => `  • ${h}`),
  ]
    .filter(Boolean)
    .join("\n");

  return { text, sources: [...sources] };
}

async function ollamaWebSynthesis(bundle: ResearchBundle, structured: string): Promise<string | null> {
  const host = (process.env.OLLAMA_WEB_AGENT_HOST ?? process.env.OLLAMA_HOST ?? "http://localhost:11434").replace(
    /\/$/,
    "",
  );
  const model = process.env.OLLAMA_WEB_AGENT_MODEL;
  if (!model) return null;

  const system = [
    "You are a Toronto street-intelligence research agent for small businesses.",
    "Using ONLY the structured live data below, write a concise briefing (400–700 words) covering:",
    "  1. Foot-traffic patterns for this street/neighbourhood and business type",
    "  2. Nearby construction, transit, events, and road impacts",
    "  3. Traffic/access implications for customers and deliveries",
    "  4. Week-ahead demand peaks relevant to staffing and inventory",
    "Do not invent facts. If data is [demo], say estimates may be synthetic.",
    "Write in plain language for a business owner.",
  ].join("\n");

  try {
    const res = await fetchJson<{ message?: { content?: string } }>(`${host}/api/chat`, {
      method: "POST",
      timeoutMs: 180_000,
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: `Business profile:\n${JSON.stringify(
              {
                name: bundle.business.name,
                type: bundle.business.businessType,
                address: bundle.business.address,
                neighbourhood: bundle.business.neighbourhood,
                headcount: bundle.business.headcount,
                notes: bundle.business.notes,
              },
              null,
              2,
            )}\n\nStructured live data:\n${structured}`,
          },
        ],
      }),
    });
    return res.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

/** Build and persist street research for a business (idempotent refresh). */
export async function runBusinessResearch(business: BusinessProfile, radiusM = 750): Promise<BusinessResearch> {
  businessResearch.setPending(business.id);
  try {
    const bundle = await gatherBundle(business, radiusM);
    const { text: structured, sources } = structuredBriefing(bundle);
    const llmBrief = await ollamaWebSynthesis(bundle, structured);
    const briefing = llmBrief
      ? `${llmBrief}\n\n---\nStructured source digest:\n${structured}`
      : structured;

    businessResearch.save(business.id, briefing, sources);
    return {
      businessId: business.id,
      status: "ready",
      briefing,
      sources,
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "research failed";
    businessResearch.setError(business.id, msg);
    return {
      businessId: business.id,
      status: "error",
      briefing: "",
      sources: [],
      generatedAt: new Date().toISOString(),
      error: msg,
    };
  }
}

export function getResearchBlock(businessId: string): string {
  const row = businessResearch.get(businessId);
  if (!row || row.status !== "ready" || !row.briefing) return "";
  return `<STREET_RESEARCH generated="${row.generated_at}">\n${row.briefing}\n</STREET_RESEARCH>`;
}

export function researchStatus(businessId: string): BusinessResearch | null {
  const row = businessResearch.get(businessId);
  if (!row) return null;
  return {
    businessId,
    status: row.status as BusinessResearch["status"],
    briefing: row.briefing,
    sources: row.sources,
    generatedAt: row.generated_at,
    error: row.error ?? undefined,
  };
}

/** Fire-and-forget background research after business create. */
export function enqueueBusinessResearch(business: BusinessProfile): void {
  void runBusinessResearch(business).catch((err) => {
    console.error(`[web-agent] research failed for ${business.id}:`, err);
  });
}
