/**
 * Proactive alert monitor — runs every 5 minutes inside the server process.
 *
 * Each tick fetches the current signal state for all sample locations, diffs
 * it against the previous tick, and fires an alert when a threshold is crossed:
 *
 *   • Demand level upgrade  (moderate→elevated, elevated→surge)
 *   • Transit disruption    (2+ new TTC delays in the interval)
 *   • Rain onset            (dry → precipMm > 2)
 *   • Extreme wind          (windKph crosses 50)
 *   • Temperature drop      (>8°C fall in one interval)
 *   • New event detected    (events count increases)
 *
 * A per-location cooldown prevents the same alert type from firing more than
 * once per 30 minutes so the feed doesn't spam.
 */
import { buildContext } from "./context.ts";
import { buildHeuristic, signalDigest } from "./forecast.ts";
import { broadcastAlert, makeAlert } from "./alerts.ts";
import { storeSnapshot } from "./patterns.ts";
import { SAMPLE_LOCATIONS } from "./dataset.ts";
import type { DemandLevel } from "./forecast.ts";

// ---- Previous state per location --------------------------------------------
interface LocationState {
  demandLevel: DemandLevel;
  demandScore: number;
  precipMm: number;
  windKph: number;
  temperatureC: number;
  transitCount: number;
  eventCount: number;
  capturedAt: string;
}

const prevState = new Map<string, LocationState>();

// Cooldown: map of "location:signalType" → last fired timestamp
const cooldowns = new Map<string, number>();
const COOLDOWN_MS = 30 * 60_000; // 30 minutes

function canFire(location: string, signal: string): boolean {
  const key = `${location}:${signal}`;
  const last = cooldowns.get(key) ?? 0;
  if (Date.now() - last < COOLDOWN_MS) return false;
  cooldowns.set(key, Date.now());
  return true;
}

// ---- Demand level ordering --------------------------------------------------
const LEVEL_ORDER: Record<DemandLevel, number> = { low: 0, moderate: 1, elevated: 2, surge: 3 };

function levelUp(from: DemandLevel, to: DemandLevel): boolean {
  return LEVEL_ORDER[to] > LEVEL_ORDER[from];
}

// ---- Business-type–aware action copy ----------------------------------------
function demandActions(level: DemandLevel, businessType: string): string[] {
  const biz = businessType;
  if (level === "surge") {
    const baseActions = ["Increase front-of-house staffing immediately", "Prep additional inventory now"];
    if (biz === "cafe" || biz === "bakery") return [...baseActions, "Activate mobile order queue, cap wait times"];
    if (biz === "restaurant") return [...baseActions, "Open waitlist, consider walk-in hold policy"];
    if (biz === "bar") return [...baseActions, "Open full bar capacity, brief staff on pacing"];
    return [...baseActions, "Alert all available staff"];
  }
  if (level === "elevated") {
    if (biz === "cafe" || biz === "bakery") return ["Pre-batch high-volume items", "Staff an extra counter position"];
    if (biz === "restaurant") return ["Pre-set extra covers", "Brief kitchen on elevated throughput"];
    if (biz === "retail") return ["Ensure floor coverage at peak hours", "Stage restocking now"];
    return ["Brief staff on elevated demand window", "Review inventory levels"];
  }
  return ["Monitor conditions", "Adjust staffing at next break"];
}

// ---- Single monitor tick ----------------------------------------------------
async function tick(): Promise<void> {
  for (const loc of SAMPLE_LOCATIONS) {
    try {
      const ctx = await buildContext({
        point: loc.point,
        radiusM: 750,
        businessType: loc.businessType,
      });
      const heuristic = buildHeuristic(ctx);
      const digest = signalDigest(ctx) as Record<string, unknown>;

      const weather = (digest.weather ?? {}) as Record<string, number>;
      const counts = (digest.counts ?? {}) as Record<string, number>;

      const current: LocationState = {
        demandLevel: heuristic.level,
        demandScore: heuristic.score,
        precipMm: Number(weather.precipMm ?? 0),
        windKph: Number(weather.windKph ?? 0),
        temperatureC: Number(weather.temperatureC ?? 10),
        transitCount: Number(counts.transit ?? 0),
        eventCount: Number(counts.events ?? 0),
        capturedAt: new Date().toISOString(),
      };

      // Store snapshot for pattern matching regardless of alerts.
      storeSnapshot(ctx, loc.name, loc.businessType, heuristic.score, heuristic.level, heuristic.headline);

      const prev = prevState.get(loc.name);
      prevState.set(loc.name, current);

      // First tick — no previous state to diff against, just record.
      if (!prev) continue;

      // ---- 1. Demand level upgrade ----
      if (levelUp(prev.demandLevel, current.demandLevel) && canFire(loc.name, "demand")) {
        const isUrgent = current.demandLevel === "surge";
        broadcastAlert(makeAlert({
          location: loc.name,
          businessType: loc.businessType,
          severity: isUrgent ? "urgent" : "warning",
          signal: "demand",
          title: `Demand ${current.demandLevel === "surge" ? "surge" : "spike"} — ${loc.name}`,
          body: heuristic.headline,
          actions: demandActions(current.demandLevel, loc.businessType),
          delta: { metric: "demand level", from: prev.demandLevel, to: current.demandLevel },
        }));
      }

      // ---- 2. Transit disruption spike ----
      const transitIncrease = current.transitCount - prev.transitCount;
      if (transitIncrease >= 2 && canFire(loc.name, "transit")) {
        broadcastAlert(makeAlert({
          location: loc.name,
          businessType: loc.businessType,
          severity: transitIncrease >= 4 ? "urgent" : "warning",
          signal: "transit",
          title: `TTC disruption near ${loc.name}`,
          body: `${transitIncrease} new transit alerts detected in your area. Expect shifts in foot traffic patterns over the next 30–90 minutes.`,
          actions: [
            "Expect delayed walk-in traffic — staff accordingly",
            "Consider pushing a pickup or delivery promotion",
            transitIncrease >= 4 ? "Monitor for extended disruption window" : "Check TTC alerts for service restoration ETA",
          ],
          delta: { metric: "transit alerts", from: String(prev.transitCount), to: String(current.transitCount) },
        }));
      }

      // ---- 3. Rain onset ----
      if (prev.precipMm < 1 && current.precipMm >= 2 && canFire(loc.name, "weather-rain")) {
        broadcastAlert(makeAlert({
          location: loc.name,
          businessType: loc.businessType,
          severity: current.precipMm >= 5 ? "warning" : "info",
          signal: "weather",
          title: `Rain starting near ${loc.name}`,
          body: `Precipitation now at ${current.precipMm.toFixed(1)}mm. Walk-in foot traffic typically drops 15–25% within 20 minutes of rain onset in this area.`,
          actions: [
            "Push a rainy-day promotion or delivery special",
            "Ensure awning/entrance is accessible",
            "Brief staff — expect delivery order volume to rise",
          ],
          delta: { metric: "precipitation", from: `${prev.precipMm.toFixed(1)}mm`, to: `${current.precipMm.toFixed(1)}mm` },
        }));
      }

      // ---- 4. Extreme wind ----
      if (prev.windKph < 50 && current.windKph >= 50 && canFire(loc.name, "weather-wind")) {
        broadcastAlert(makeAlert({
          location: loc.name,
          businessType: loc.businessType,
          severity: "warning",
          signal: "weather",
          title: `High wind advisory — ${loc.name}`,
          body: `Wind gusts at ${Math.round(current.windKph)} km/h. Outdoor seating should be secured and signage checked.`,
          actions: [
            "Bring in outdoor furniture and signage",
            "Expect reduced patio and walk-by traffic",
            "Monitor for escalation above 70 km/h",
          ],
          delta: { metric: "wind speed", from: `${Math.round(prev.windKph)} km/h`, to: `${Math.round(current.windKph)} km/h` },
        }));
      }

      // ---- 5. Sharp temperature drop ----
      const tempDelta = prev.temperatureC - current.temperatureC;
      if (tempDelta >= 8 && canFire(loc.name, "weather-temp")) {
        broadcastAlert(makeAlert({
          location: loc.name,
          businessType: loc.businessType,
          severity: "info",
          signal: "weather",
          title: `Temperature drop — ${loc.name}`,
          body: `Temperature fell ${tempDelta.toFixed(0)}°C to ${current.temperatureC.toFixed(0)}°C. Hot beverage and comfort food demand typically rises in the first hour.`,
          actions: [
            "Promote hot beverages or seasonal specials",
            "Ensure entrance area is warm and welcoming",
          ],
          delta: { metric: "temperature", from: `${prev.temperatureC.toFixed(0)}°C`, to: `${current.temperatureC.toFixed(0)}°C` },
        }));
      }

      // ---- 6. New event nearby ----
      const newEvents = current.eventCount - prev.eventCount;
      if (newEvents >= 1 && canFire(loc.name, "event")) {
        const eventHighlight = ctx.civic
          .find((g) => g.category === "event")
          ?.nearby[0]?.title ?? "a nearby event";
        broadcastAlert(makeAlert({
          location: loc.name,
          businessType: loc.businessType,
          severity: "info",
          signal: "event",
          title: `New event detected near ${loc.name}`,
          body: `${eventHighlight} added to your area. Expect elevated demand in the pre/post-event windows.`,
          actions: [
            "Review staffing for the event window",
            "Consider a timed promotion around event start/end",
            "Pre-stage additional inventory",
          ],
          delta: { metric: "nearby events", from: String(prev.eventCount), to: String(current.eventCount) },
        }));
      }
    } catch (err) {
      // Non-fatal — one bad location shouldn't stop the monitor.
      console.warn(`[monitor] ${loc.name}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

// ---- Public API -------------------------------------------------------------
export function startMonitor(intervalMs = 5 * 60_000): () => void {
  console.log(`[monitor] proactive alert monitor started (interval: ${intervalMs / 60_000}min, ${SAMPLE_LOCATIONS.length} locations)`);
  // First tick after a short delay so the server finishes booting.
  const boot = setTimeout(() => {
    tick().catch((e) => console.error("[monitor] boot tick failed:", e));
  }, 15_000);

  const id = setInterval(
    () => tick().catch((e) => console.error("[monitor] tick failed:", e)),
    intervalMs,
  );

  return () => {
    clearTimeout(boot);
    clearInterval(id);
  };
}
