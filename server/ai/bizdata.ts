import type { HistoryInsert, ScheduleInsert } from "../db.ts";

interface BizProfile {
  hourlyDemand: number[];
  dowWeight: number[];
  revenuePerCustomer: [number, number];
  peakCustomers: number;
  staffSchedule: number[];
  eventBoostProbability: number;
}

function makeHourly(peaks: Record<number, number>): number[] {
  const base = Array(24).fill(0.05) as number[];
  for (const [h, v] of Object.entries(peaks)) base[Number(h)] = v;
  return base.map((v, i) =>
    base[(i - 1 + 24) % 24] * 0.2 + v * 0.6 + base[(i + 1) % 24] * 0.2,
  );
}

function makeStaff(peaks: Record<number, number>): number[] {
  const base = Array(24).fill(0) as number[];
  for (const [h, v] of Object.entries(peaks)) base[Number(h)] = v;
  return base;
}

const PROFILES: Record<string, BizProfile> = {
  cafe: {
    hourlyDemand: makeHourly({ 7: 0.9, 8: 1.0, 9: 0.85, 10: 0.6, 11: 0.5, 12: 0.7, 13: 0.65, 14: 0.5, 15: 0.4, 16: 0.3 }),
    dowWeight: [0.6, 0.85, 0.9, 0.95, 1.0, 0.95, 0.8],
    revenuePerCustomer: [6, 14],
    peakCustomers: 28,
    staffSchedule: makeStaff({ 6: 2, 7: 3, 8: 3, 9: 2, 10: 2, 11: 2, 12: 2, 13: 2, 14: 1, 15: 1, 16: 1 }),
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
    hourlyDemand: makeHourly({ 6: 1.0, 7: 0.9, 8: 0.7, 9: 0.5, 12: 0.55, 17: 0.7, 18: 1.0, 19: 0.9, 20: 0.6 }),
    dowWeight: [0.5, 0.9, 0.85, 0.9, 0.95, 1.0, 0.7],
    revenuePerCustomer: [2, 5],
    peakCustomers: 45,
    staffSchedule: makeStaff({ 5: 1, 6: 2, 7: 2, 8: 1, 9: 1, 10: 1, 16: 2, 17: 2, 18: 2, 19: 2, 20: 1 }),
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
    hourlyDemand: makeHourly({ 7: 0.7, 8: 0.8, 9: 0.6, 12: 0.75, 17: 0.85, 18: 1.0, 19: 0.9, 20: 0.7, 21: 0.5, 22: 0.4 }),
    dowWeight: [0.8, 0.75, 0.8, 0.85, 0.9, 1.0, 0.95],
    revenuePerCustomer: [4, 15],
    peakCustomers: 30,
    staffSchedule: makeStaff({ 6: 1, 7: 2, 8: 2, 9: 1, 12: 2, 13: 2, 16: 2, 17: 2, 18: 2, 19: 1, 20: 1, 21: 1 }),
    eventBoostProbability: 0.2,
  },
};

function resolveProfile(businessType: string): BizProfile {
  const t = businessType.toLowerCase();
  for (const [key, p] of Object.entries(PROFILES)) {
    if (t.includes(key)) return p;
  }
  if (t.includes("coffee") || t.includes("bakery") || t.includes("tea")) return PROFILES.cafe;
  if (t.includes("food") || t.includes("pizza") || t.includes("sushi") || t.includes("diner")) return PROFILES.restaurant;
  if (t.includes("pub") || t.includes("lounge") || t.includes("tavern") || t.includes("club")) return PROFILES.bar;
  if (t.includes("clothing") || t.includes("boutique") || t.includes("shop") || t.includes("store")) return PROFILES.retail;
  if (t.includes("fitness") || t.includes("yoga") || t.includes("crossfit")) return PROFILES.gym;
  if (t.includes("hair") || t.includes("nail") || t.includes("spa") || t.includes("barber")) return PROFILES.salon;
  return PROFILES.retail;
}

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function gaussNoise(rand: () => number, std = 0.18): number {
  const u1 = Math.max(1e-9, rand());
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * std;
}

export function generateBusinessData(
  businessId: string,
  businessType: string,
  headcount: number,
  daysBack: number,
): { history: HistoryInsert[]; schedule: ScheduleInsert[] } {
  const profile = resolveProfile(businessType);
  const seed = Array.from(businessId).reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 0);
  const rand = lcg(Math.abs(seed) || 42);

  const history: HistoryInsert[] = [];
  const schedule: ScheduleInsert[] = [];

  const now = new Date();
  const startDate = new Date(now.getTime() - daysBack * 86_400_000);
  startDate.setHours(0, 0, 0, 0);

  // Sprinkle random event days (Leafs/Raptors/concert-type spikes)
  const eventDays = new Set<string>();
  for (let d = 0; d < daysBack; d++) {
    if (rand() < profile.eventBoostProbability / 7) {
      const dt = new Date(startDate.getTime() + d * 86_400_000);
      eventDays.add(dt.toISOString().slice(0, 10));
    }
  }

  for (let d = 0; d < daysBack; d++) {
    const date = new Date(startDate.getTime() + d * 86_400_000);
    const dateStr = date.toISOString().slice(0, 10);
    const dow = date.getDay();
    const isWeekend = dow === 0 || dow === 6;
    const seasonalBoost = 1 + (d / daysBack) * 0.12;
    const isEventDay = eventDays.has(dateStr);
    const eventMult = isEventDay ? 1.3 + rand() * 0.5 : 1.0;
    const dowW = profile.dowWeight[dow];

    // ~2% closed days, ~15% chance Sundays
    if ((dow === 0 && rand() < 0.15) || rand() < 0.02) continue;

    for (let hour = 0; hour < 24; hour++) {
      const demandW = profile.hourlyDemand[hour];
      if (demandW < 0.05) continue;

      const noise = 1 + gaussNoise(rand, 0.2);
      const customers = Math.max(0, Math.round(demandW * dowW * seasonalBoost * eventMult * noise * profile.peakCustomers));
      if (customers === 0) continue;

      const [rMin, rMax] = profile.revenuePerCustomer;
      const revenue = Math.round(customers * (rMin + rand() * (rMax - rMin)) * 100) / 100;

      history.push({
        business_id: businessId,
        date: dateStr,
        hour,
        revenue,
        customer_count: customers,
        notes: isEventDay ? "event day" : null,
      });

      const baseStaff = profile.staffSchedule[hour] ?? 0;
      if (baseStaff > 0) {
        // Deliberate misalignment for the agent to surface
        let staff = baseStaff;
        if (isEventDay && rand() < 0.6) staff = Math.max(1, staff - 1);
        else if (!isWeekend && dowW < 0.7 && rand() < 0.3) staff = Math.min(headcount, staff + 1);
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

  // 7 days of upcoming schedule (future-facing, potentially misaligned with forecast)
  for (let d = 0; d <= 7; d++) {
    const date = new Date(now.getTime() + d * 86_400_000);
    const dateStr = date.toISOString().slice(0, 10);
    for (let hour = 0; hour < 24; hour++) {
      const baseStaff = profile.staffSchedule[hour] ?? 0;
      if (baseStaff === 0) continue;
      const staff = rand() < 0.2 ? Math.max(1, baseStaff - 1) : baseStaff;
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

export function businessHistoryBlock(
  businessId: string,
  businessType: string,
  summary: {
    totalDays: number;
    avgDailyRevenue: number | null;
    avgDailyCustomers: number | null;
    peakHour: number | null;
    peakDow: number | null;
  },
  upcomingSchedule: Array<{ date: string; hour: number; staff_count: number }>,
): string {
  if (summary.totalDays === 0) return "";

  const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const HOUR = (h: number) => h === 0 ? "12am" : h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h - 12}pm`;

  const lines: string[] = [
    `<BUSINESS_HISTORY>`,
    `Business type: ${businessType}`,
    `History: ${summary.totalDays} days of real operational data`,
  ];
  if (summary.avgDailyRevenue != null) lines.push(`Average daily revenue: $${summary.avgDailyRevenue.toLocaleString()}`);
  if (summary.avgDailyCustomers != null) lines.push(`Average daily customers: ${summary.avgDailyCustomers}`);
  if (summary.peakHour != null) lines.push(`Peak trading hour: ${HOUR(summary.peakHour)}`);
  if (summary.peakDow != null) lines.push(`Busiest day of week: ${DOW[summary.peakDow]}`);

  if (upcomingSchedule.length > 0) {
    // Aggregate upcoming staff by date
    const byDate: Record<string, number> = {};
    for (const r of upcomingSchedule) {
      byDate[r.date] = (byDate[r.date] ?? 0) + r.staff_count;
    }
    lines.push("");
    lines.push("Upcoming staff schedule (total hours scheduled per day):");
    for (const [date, total] of Object.entries(byDate).slice(0, 7)) {
      const dow = new Date(date).getDay();
      lines.push(`  ${DOW[dow]} ${date}: ${total} staff-hours scheduled`);
    }
    lines.push(
      "NOTE: Compare this schedule against the demand forecast to flag under/over-staffing.",
      "If forecast is ELEVATED or SURGE and staff-hours are below the owner's typical peak level, call it out explicitly.",
    );
  }

  lines.push(`</BUSINESS_HISTORY>`);
  return lines.join("\n");
}
