#!/usr/bin/env npx tsx
/**
 * Generate synthetic 90-day history (hourly revenue + customers + staff schedule)
 * for every business in the SQLite DB, tuned by business type.
 *
 * Usage:
 *   npx tsx scripts/gen_business_data.ts
 *   npx tsx scripts/gen_business_data.ts --days 30
 *   npx tsx scripts/gen_business_data.ts --business-id <uuid>
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DAYS_BACK     = Number(arg("days", "90"));
const BUSINESS_ID   = arg("business-id", "");
const DB_PATH       = resolve(process.cwd(), "data/toronto-monitor.db");
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// ---- Business type profiles --------------------------------------------------
// Each profile defines hourly demand curves, typical revenue/customer ranges,
// and staffing patterns — loosely misaligned to give the agent something to say.

interface BizProfile {
  /** 0–23 demand weight (higher = more customers that hour) */
  hourlyDemand: number[];
  /** dow weights 0=Sun..6=Sat */
  dowWeight: number[];
  /** revenue per customer */
  revenuePerCustomer: [min: number, max: number];
  /** typical customers/hr at peak */
  peakCustomers: number;
  /** staff scheduled at each hour of day (slightly under-optimised) */
  staffSchedule: number[];
  /** special events boost (Leafs/Raptors game nights, etc.) */
  eventBoostProbability: number;
}

function makeHourly(peaks: Record<number, number>): number[] {
  const base = Array(24).fill(0.1);
  for (const [h, v] of Object.entries(peaks)) base[Number(h)] = v;
  // Smooth with a simple triangle spread
  const out = [...base];
  for (let h = 0; h < 24; h++) {
    out[h] = (base[(h - 1 + 24) % 24] * 0.2 + base[h] * 0.6 + base[(h + 1) % 24] * 0.2);
  }
  return out;
}

const PROFILES: Record<string, BizProfile> = {
  cafe: {
    hourlyDemand: makeHourly({ 7: 0.9, 8: 1.0, 9: 0.85, 10: 0.6, 11: 0.5, 12: 0.7, 13: 0.65, 14: 0.5, 15: 0.4, 16: 0.3, 17: 0.25 }),
    dowWeight: [0.6, 0.85, 0.9, 0.95, 1.0, 0.95, 0.8],
    revenuePerCustomer: [6, 14],
    peakCustomers: 28,
    staffSchedule: makeStaff({ 6: 2, 7: 3, 8: 3, 9: 2, 10: 2, 11: 2, 12: 2, 13: 2, 14: 1, 15: 1, 16: 1, 17: 1 }),
    eventBoostProbability: 0.1,
  },
  restaurant: {
    hourlyDemand: makeHourly({ 11: 0.7, 12: 1.0, 13: 0.95, 17: 0.6, 18: 0.9, 19: 1.0, 20: 0.85, 21: 0.5 }),
    dowWeight: [0.7, 0.6, 0.65, 0.75, 0.85, 1.0, 0.95],
    revenuePerCustomer: [18, 45],
    peakCustomers: 40,
    staffSchedule: makeStaff({ 10: 2, 11: 3, 12: 4, 13: 4, 14: 2, 15: 1, 16: 2, 17: 3, 18: 4, 19: 5, 20: 4, 21: 3, 22: 2 }),
    eventBoostProbability: 0.25,
  },
  bar: {
    hourlyDemand: makeHourly({ 16: 0.3, 17: 0.5, 18: 0.65, 19: 0.75, 20: 0.85, 21: 1.0, 22: 1.0, 23: 0.9 }),
    dowWeight: [0.5, 0.4, 0.45, 0.55, 0.8, 1.0, 0.9],
    revenuePerCustomer: [12, 30],
    peakCustomers: 55,
    staffSchedule: makeStaff({ 15: 1, 16: 2, 17: 2, 18: 3, 19: 3, 20: 4, 21: 4, 22: 4, 23: 3 }),
    eventBoostProbability: 0.45,
  },
  retail: {
    hourlyDemand: makeHourly({ 10: 0.5, 11: 0.7, 12: 0.85, 13: 0.9, 14: 1.0, 15: 0.95, 16: 0.85, 17: 0.7, 18: 0.5 }),
    dowWeight: [0.6, 0.7, 0.65, 0.7, 0.75, 1.0, 0.95],
    revenuePerCustomer: [25, 90],
    peakCustomers: 22,
    staffSchedule: makeStaff({ 9: 1, 10: 2, 11: 2, 12: 3, 13: 3, 14: 3, 15: 3, 16: 2, 17: 2, 18: 1 }),
    eventBoostProbability: 0.15,
  },
  gym: {
    hourlyDemand: makeHourly({ 6: 1.0, 7: 0.9, 8: 0.7, 9: 0.5, 10: 0.4, 11: 0.35, 12: 0.55, 17: 0.7, 18: 1.0, 19: 0.9, 20: 0.6 }),
    dowWeight: [0.5, 0.9, 0.85, 0.9, 0.95, 1.0, 0.7],
    revenuePerCustomer: [2, 5],
    peakCustomers: 45,
    staffSchedule: makeStaff({ 5: 1, 6: 2, 7: 2, 8: 1, 9: 1, 10: 1, 11: 1, 12: 1, 13: 1, 16: 2, 17: 2, 18: 2, 19: 2, 20: 1 }),
    eventBoostProbability: 0.05,
  },
  salon: {
    hourlyDemand: makeHourly({ 9: 0.5, 10: 0.8, 11: 1.0, 12: 0.9, 13: 0.85, 14: 0.9, 15: 0.95, 16: 0.8, 17: 0.6 }),
    dowWeight: [0.3, 0.6, 0.65, 0.7, 0.8, 1.0, 0.95],
    revenuePerCustomer: [35, 120],
    peakCustomers: 8,
    staffSchedule: makeStaff({ 9: 2, 10: 2, 11: 3, 12: 3, 13: 3, 14: 3, 15: 3, 16: 2, 17: 1 }),
    eventBoostProbability: 0.05,
  },
  convenience: {
    hourlyDemand: makeHourly({ 7: 0.7, 8: 0.8, 9: 0.6, 12: 0.75, 13: 0.7, 17: 0.85, 18: 1.0, 19: 0.9, 20: 0.7, 21: 0.5, 22: 0.4, 23: 0.3 }),
    dowWeight: [0.8, 0.75, 0.8, 0.85, 0.9, 1.0, 0.95],
    revenuePerCustomer: [4, 15],
    peakCustomers: 30,
    staffSchedule: makeStaff({ 6: 1, 7: 2, 8: 2, 9: 1, 10: 1, 11: 1, 12: 2, 13: 2, 14: 1, 15: 1, 16: 2, 17: 2, 18: 2, 19: 1, 20: 1, 21: 1, 22: 1 }),
    eventBoostProbability: 0.2,
  },
};

const DEFAULT_PROFILE: BizProfile = PROFILES.retail;

function makeStaff(peaks: Record<number, number>): number[] {
  const base = Array(24).fill(0);
  for (const [h, v] of Object.entries(peaks)) base[Number(h)] = v;
  return base;
}

function resolveProfile(businessType: string): BizProfile {
  const t = businessType.toLowerCase();
  for (const [key, profile] of Object.entries(PROFILES)) {
    if (t.includes(key)) return profile;
  }
  // Fuzzy fallbacks
  if (t.includes("coffee") || t.includes("bakery") || t.includes("tea")) return PROFILES.cafe;
  if (t.includes("food") || t.includes("pizza") || t.includes("sushi") || t.includes("diner")) return PROFILES.restaurant;
  if (t.includes("pub") || t.includes("lounge") || t.includes("tavern") || t.includes("club")) return PROFILES.bar;
  if (t.includes("clothing") || t.includes("boutique") || t.includes("shop") || t.includes("store")) return PROFILES.retail;
  if (t.includes("fitness") || t.includes("yoga") || t.includes("crossfit")) return PROFILES.gym;
  if (t.includes("hair") || t.includes("nail") || t.includes("spa") || t.includes("barber")) return PROFILES.salon;
  return DEFAULT_PROFILE;
}

// ---- Random helpers ----------------------------------------------------------

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }

function gaussianNoise(rand: () => number, stddev = 0.15): number {
  // Box-Muller
  const u1 = Math.max(1e-9, rand());
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * stddev;
}

const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ---- Generate ----------------------------------------------------------------

function generateForBusiness(
  businessId: string,
  businessType: string,
  headcount: number,
  daysBack: number,
): { history: object[]; schedule: object[] } {
  const profile = resolveProfile(businessType);
  const rand = rng(businessId.charCodeAt(0) * 31337 + businessId.charCodeAt(4) * 1337);

  const history: object[] = [];
  const schedule: object[] = [];

  const now = new Date();
  const startDate = new Date(now.getTime() - daysBack * 86_400_000);
  startDate.setHours(0, 0, 0, 0);

  // Seasonal trend: slight revenue growth over time (simulates business ramping up)
  // Also add random "event days" where demand spikes
  const eventDays = new Set<string>();
  for (let d = 0; d < daysBack; d++) {
    if (rand() < profile.eventBoostProbability / 7) {
      const date = new Date(startDate.getTime() + d * 86_400_000);
      eventDays.add(date.toISOString().slice(0, 10));
    }
  }

  for (let d = 0; d < daysBack; d++) {
    const date = new Date(startDate.getTime() + d * 86_400_000);
    const dateStr = date.toISOString().slice(0, 10);
    const dow = date.getDay();
    const isWeekend = dow === 0 || dow === 6;
    const seasonalBoost = 1 + (d / daysBack) * 0.12; // 12% growth over period
    const isEventDay = eventDays.has(dateStr);
    const eventMultiplier = isEventDay ? lerp(1.3, 1.8, rand()) : 1.0;
    const dowW = profile.dowWeight[dow];

    // Some days closed (Sundays for some business types, random sick days)
    const isClosed = (dow === 0 && rand() < 0.15) || rand() < 0.02;
    if (isClosed) continue;

    for (let hour = 0; hour < 24; hour++) {
      const demandW = profile.hourlyDemand[hour];
      if (demandW < 0.05) continue; // closed this hour

      const noise = 1 + gaussianNoise(rand, 0.2);
      const rawDemand = demandW * dowW * seasonalBoost * eventMultiplier * noise;
      const customers = Math.max(0, Math.round(rawDemand * profile.peakCustomers));
      if (customers === 0) continue;

      const [rMin, rMax] = profile.revenuePerCustomer;
      const revenuePerCustomer = lerp(rMin, rMax, rand());
      const revenue = Math.round(customers * revenuePerCustomer * 100) / 100;

      history.push({
        business_id: businessId,
        date: dateStr,
        hour,
        revenue,
        customer_count: customers,
        notes: isEventDay ? "event day" : null,
      });

      // Staff schedule — use profile.staffSchedule but intentionally misalign:
      // Under-staff on high-demand days (no one knew it would be busy)
      // Over-staff on some slow days (routine scheduling didn't adapt)
      const baseStaff = profile.staffSchedule[hour] ?? 0;
      if (baseStaff > 0) {
        let staff = baseStaff;
        if (isEventDay && rand() < 0.6) {
          // 60% chance of under-staffing on event days (didn't anticipate it)
          staff = Math.max(1, staff - 1);
        } else if (!isWeekend && dowW < 0.7 && rand() < 0.3) {
          // 30% chance of over-staffing on slow weekdays
          staff = Math.min(headcount, staff + 1);
        }
        schedule.push({
          business_id: businessId,
          date: dateStr,
          hour,
          staff_count: Math.min(staff, headcount),
          role: null,
        });
      }
    }
  }

  // Also generate 7 days of UPCOMING schedule (so the agent can compare forecast vs. staffing)
  for (let d = 0; d <= 7; d++) {
    const date = new Date(now.getTime() + d * 86_400_000);
    const dateStr = date.toISOString().slice(0, 10);
    const dow = date.getDay();
    const dowW = profile.dowWeight[dow];

    for (let hour = 0; hour < 24; hour++) {
      const baseStaff = profile.staffSchedule[hour] ?? 0;
      if (baseStaff === 0) continue;
      // Future schedule is set before forecast — might be misaligned with upcoming events
      let staff = baseStaff;
      if (rand() < 0.2) staff = Math.max(1, staff - 1); // under-schedule some slots
      schedule.push({
        business_id: businessId,
        date: dateStr,
        hour,
        staff_count: Math.min(staff, headcount),
        role: null,
      });
    }
  }

  return { history, schedule };
}

// ---- DB write ----------------------------------------------------------------

const upsertHistory = db.prepare(`
  INSERT INTO business_history (business_id, date, hour, revenue, customer_count, notes)
  VALUES (@business_id, @date, @hour, @revenue, @customer_count, @notes)
  ON CONFLICT(business_id, date, hour) DO UPDATE SET
    revenue = excluded.revenue,
    customer_count = excluded.customer_count,
    notes = excluded.notes
`);

const upsertSchedule = db.prepare(`
  INSERT INTO business_schedule (business_id, date, hour, staff_count, role)
  VALUES (@business_id, @date, @hour, @staff_count, @role)
  ON CONFLICT(business_id, date, hour, role) DO UPDATE SET staff_count = excluded.staff_count
`);

const writeHistory  = db.transaction((rows: object[]) => rows.forEach((r) => upsertHistory.run(r as any)));
const writeSchedule = db.transaction((rows: object[]) => rows.forEach((r) => upsertSchedule.run(r as any)));

// ---- Main --------------------------------------------------------------------

const businesses = db.prepare(
  BUSINESS_ID
    ? "SELECT id, business_type, headcount FROM businesses WHERE id = ?"
    : "SELECT id, business_type, headcount FROM businesses",
).all(...(BUSINESS_ID ? [BUSINESS_ID] : [])) as Array<{ id: string; business_type: string; headcount: number }>;

if (!businesses.length) {
  console.error("No businesses found. Add a business via the dashboard first.");
  process.exit(1);
}

console.log(`Generating ${DAYS_BACK} days of data for ${businesses.length} business(es)…`);

for (const biz of businesses) {
  const t0 = Date.now();
  const { history, schedule } = generateForBusiness(biz.id, biz.business_type, biz.headcount || 4, DAYS_BACK);
  writeHistory(history);
  writeSchedule(schedule);
  const profile = resolveProfile(biz.business_type);
  console.log(
    `  ✓ ${biz.id.slice(0, 8)}  type=${biz.business_type}  profile=${Object.keys(PROFILES).find(k => PROFILES[k as keyof typeof PROFILES] === profile) ?? "default"}` +
    `  history=${history.length} rows  schedule=${schedule.length} rows  (${Date.now() - t0}ms)`,
  );
}

console.log("Done.");
