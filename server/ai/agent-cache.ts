/**
 * Short-lived cache for agent context assembly. Reuses civic/forecast/ML blocks
 * for follow-up questions from the same business without re-fetching every feed.
 */
import { buildContext, scopeFromBusiness, type LocationContext } from "./context.ts";
import { weekForecastForBusiness } from "./forecast.ts";
import { mlWeeklyProfile } from "./mlforecast.ts";
import { businessHistory, businessSchedule } from "../db.ts";
import { businessHistoryBlock } from "./bizdata.ts";
import { getResearchBlock } from "./web-agent.ts";
import type { BusinessProfile } from "../types.ts";

const TTL_MS = Number(process.env.AGENT_CONTEXT_TTL_MS ?? 90_000);

export interface AgentContextBundle {
  ctx: LocationContext;
  researchBlock: string;
  weekBlock: string;
  mlBlock: string;
  histBlock: string;
  gradientUsed: boolean;
}

interface Entry {
  expires: number;
  bundle: AgentContextBundle;
}

const store = new Map<string, Entry>();

function weekForecastBlock(
  week: Awaited<ReturnType<typeof weekForecastForBusiness>>,
): string {
  const dayLines = week.days
    .slice(0, 5)
    .map((d) => `  ${d.dayName} (${d.date}): peak ${d.peakWindow} [${d.peakLevel}]${d.events ? `, ${d.events} ev` : ""}`);
  return [
    "<WEEK_FORECAST>",
    week.headline,
    ...dayLines,
    `Basis: ${week.basis}`,
    "</WEEK_FORECAST>",
  ].join("\n");
}

function buildMlBlock(
  businessType: string,
  grid: number[][],
  model: string,
  archetype: string,
): string {
  const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const flat = grid.flat();
  const max = Math.max(...flat, 1);
  const dayLines = grid.slice(0, 5).map((row, d) => {
    const peakH = row.indexOf(Math.max(...row));
    return `  ${DOW[d]}: peak ${String(peakH).padStart(2, "0")}:00 (~${Math.round(row[peakH])} customers)`;
  });
  return [
    `<ML_DEMAND_MODEL model="${model}" archetype="${archetype}" business_type="${businessType}">`,
    ...dayLines,
    `Peak fraction of max: this hour vs ${Math.round(max)} peak customers.`,
    "</ML_DEMAND_MODEL>",
  ].join("\n");
}

export async function loadAgentContextBundle(
  business: BusinessProfile,
  radiusM: number,
  useGradient: boolean,
): Promise<AgentContextBundle> {
  const key = `${business.id}:${radiusM}:${useGradient ? "ml" : "plain"}`;
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) return hit.bundle;

  const scope = scopeFromBusiness(business, radiusM);
  const [ctx, week, mlProfile] = await Promise.all([
    buildContext(scope),
    weekForecastForBusiness(business.id, radiusM),
    useGradient ? mlWeeklyProfile(business.businessType).catch(() => null) : Promise.resolve(null),
  ]);

  const summary = businessHistory.summary(business.id);
  const upcoming = businessSchedule.upcoming(business.id, 7);
  const histBlock = businessHistoryBlock(business.id, business.businessType, summary, upcoming);
  const researchBlock = getResearchBlock(business.id);
  const weekBlock = weekForecastBlock(week);
  const mlBlock =
    useGradient && mlProfile
      ? buildMlBlock(business.businessType, mlProfile.grid, mlProfile.model, mlProfile.archetype)
      : "";

  const bundle: AgentContextBundle = {
    ctx,
    researchBlock,
    weekBlock,
    mlBlock,
    histBlock,
    gradientUsed: useGradient && !!mlProfile,
  };
  store.set(key, { expires: Date.now() + TTL_MS, bundle });
  return bundle;
}
