/**
 * Ontario statutory holidays — deterministic, no external API.
 *
 * Statutory holidays strongly shape demand for Toronto businesses (many closed
 * or on reduced hours; foot-traffic patterns shift). This module computes the
 * Ontario stat holidays for any year and exposes the upcoming ones so the UI
 * and agent can surface them. Self-contained (own date math) so it doesn't
 * couple to the forecast engine.
 */

import { nowIso } from "../cache.ts";
import type { SourceResult } from "../types.ts";

export interface Holiday {
  /** YYYY-MM-DD (Toronto local date). */
  date: string;
  name: string;
  /** Days from "today" (Toronto) until the holiday; 0 = today. */
  inDays: number;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** The date of the `nth` `weekday` (0=Sun..6=Sat) in `month` (1-12) of `year`. */
function nthWeekday(year: number, month: number, weekday: number, nth: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const offset = (weekday - first + 7) % 7;
  const day = 1 + offset + (nth - 1) * 7;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Anonymous Gregorian (Meeus/Jones/Butcher) Easter Sunday. */
function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

/** Ontario statutory holidays for a year as a date(YYYY-MM-DD) -> name map. */
export function ontarioHolidays(year: number): Map<string, string> {
  const m = new Map<string, string>();
  m.set(`${year}-01-01`, "New Year's Day");
  m.set(nthWeekday(year, 2, 1, 3), "Family Day");

  // Good Friday = Easter Sunday - 2 days.
  const easter = easterSunday(year);
  const gf = new Date(Date.UTC(year, easter.month - 1, easter.day - 2));
  m.set(`${gf.getUTCFullYear()}-${pad(gf.getUTCMonth() + 1)}-${pad(gf.getUTCDate())}`, "Good Friday");

  // Victoria Day: the Monday on/before May 24.
  const may24Dow = new Date(Date.UTC(year, 4, 24)).getUTCDay();
  const vicDay = 24 - ((may24Dow + 6) % 7);
  m.set(`${year}-05-${pad(vicDay)}`, "Victoria Day");

  m.set(`${year}-07-01`, "Canada Day");
  m.set(nthWeekday(year, 8, 1, 1), "Civic Holiday");
  m.set(nthWeekday(year, 9, 1, 1), "Labour Day");
  m.set(`${year}-09-30`, "National Day for Truth and Reconciliation");
  m.set(nthWeekday(year, 10, 1, 2), "Thanksgiving");
  m.set(`${year}-12-25`, "Christmas Day");
  m.set(`${year}-12-26`, "Boxing Day");
  return m;
}

/** Today's date in Toronto as YYYY-MM-DD. */
function torontoToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function daysBetween(fromYmd: string, toYmd: string): number {
  const a = new Date(`${fromYmd}T00:00:00Z`).getTime();
  const b = new Date(`${toYmd}T00:00:00Z`).getTime();
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

/** Upcoming Ontario statutory holidays (today + future), soonest first. */
export function upcomingHolidays(count = 6): Holiday[] {
  const today = torontoToday();
  const year = Number(today.slice(0, 4));
  const all = new Map<string, string>();
  // Span this year and next so December lookups still see January holidays.
  for (const [k, v] of ontarioHolidays(year)) all.set(k, v);
  for (const [k, v] of ontarioHolidays(year + 1)) all.set(k, v);

  return [...all.entries()]
    .filter(([date]) => date >= today)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .slice(0, count)
    .map(([date, name]) => ({ date, name, inDays: daysBetween(today, date) }));
}

/** SourceResult wrapper so holidays fit the standard data-source envelope. */
export function holidaysSource(count = 6): SourceResult<Holiday[]> {
  const data = upcomingHolidays(count);
  const next = data[0];
  return {
    source: "holidays",
    status: "live",
    fetchedAt: nowIso(),
    note: next
      ? `Next: ${next.name} on ${next.date}${next.inDays === 0 ? " (today)" : ` (in ${next.inDays} day${next.inDays === 1 ? "" : "s"})`}.`
      : "No upcoming statutory holidays.",
    data,
    attribution: "Ontario statutory holidays (computed)",
  };
}
