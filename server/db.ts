import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { BusinessProfile } from "./types.ts";

const DB_PATH = resolve(process.cwd(), "data/toronto-monitor.db");
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS signal_snapshots (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at       TEXT NOT NULL,
    location          TEXT NOT NULL,
    business_type     TEXT,
    lon               REAL,
    lat               REAL,
    features          TEXT NOT NULL,
    digest            TEXT NOT NULL,
    forecast_score    REAL NOT NULL DEFAULT 0,
    forecast_level    TEXT NOT NULL DEFAULT 'moderate',
    forecast_headline TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_snap_captured ON signal_snapshots(captured_at DESC);
  CREATE INDEX IF NOT EXISTS idx_snap_location  ON signal_snapshots(location);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS businesses (
    id            TEXT PRIMARY KEY,
    owner_email   TEXT,
    owner_name    TEXT,
    is_public     INTEGER NOT NULL DEFAULT 0,
    name          TEXT NOT NULL,
    business_type TEXT NOT NULL,
    address       TEXT NOT NULL,
    lon           REAL NOT NULL,
    lat           REAL NOT NULL,
    ward          TEXT,
    neighbourhood TEXT,
    headcount     INTEGER NOT NULL DEFAULT 1,
    notes         TEXT,
    opens_at                  INTEGER,
    closes_at                 INTEGER,
    event_radius_km           REAL,
    customers_per_worker_hour REAL,
    hourly_wage               REAL,
    min_staff                 INTEGER,
    max_staff_per_hour        INTEGER,
    allowed_shift_lengths     TEXT,
    transit_relevance         TEXT,
    nearby_routes             TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );
`);

// Lightweight migration: add demand-model columns to businesses tables that
// predate them (CREATE TABLE IF NOT EXISTS won't alter an existing table).
{
  const existing = new Set(
    (db.prepare("PRAGMA table_info(businesses)").all() as { name: string }[]).map((r) => r.name),
  );
  const additions: Record<string, string> = {
    owner_email: "TEXT",
    owner_name: "TEXT",
    is_public: "INTEGER NOT NULL DEFAULT 0",
    opens_at: "INTEGER",
    closes_at: "INTEGER",
    event_radius_km: "REAL",
    customers_per_worker_hour: "REAL",
    hourly_wage: "REAL",
    min_staff: "INTEGER",
    max_staff_per_hour: "INTEGER",
    allowed_shift_lengths: "TEXT",
    transit_relevance: "TEXT",
    nearby_routes: "TEXT",
  };
  for (const [col, type] of Object.entries(additions)) {
    if (!existing.has(col)) db.exec(`ALTER TABLE businesses ADD COLUMN ${col} ${type}`);
  }
}

interface Row {
  id: string;
  name: string;
  business_type: string;
  address: string;
  lon: number;
  lat: number;
  ward: string | null;
  neighbourhood: string | null;
  headcount: number;
  notes: string | null;
  owner_email: string | null;
  owner_name: string | null;
  is_public: number;
  opens_at: number | null;
  closes_at: number | null;
  event_radius_km: number | null;
  customers_per_worker_hour: number | null;
  hourly_wage: number | null;
  min_staff: number | null;
  max_staff_per_hour: number | null;
  allowed_shift_lengths: string | null;
  transit_relevance: string | null;
  nearby_routes: string | null;
  created_at: string;
  updated_at: string;
}

function parseNumArray(json: string | null): number[] | undefined {
  if (!json) return undefined;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((n) => typeof n === "number") : undefined;
  } catch {
    return undefined;
  }
}

function parseStrArray(json: string | null): string[] | undefined {
  if (!json) return undefined;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((s) => typeof s === "string") : undefined;
  } catch {
    return undefined;
  }
}

function toProfile(r: Row): BusinessProfile {
  return {
    id: r.id,
    name: r.name,
    businessType: r.business_type,
    address: r.address,
    lon: r.lon,
    lat: r.lat,
    ward: r.ward ?? undefined,
    neighbourhood: r.neighbourhood ?? undefined,
    headcount: r.headcount,
    notes: r.notes ?? undefined,
    ownerEmail: r.owner_email ?? undefined,
    ownerName: r.owner_name ?? undefined,
    isPublic: Boolean(r.is_public),
    opensAt: r.opens_at ?? undefined,
    closesAt: r.closes_at ?? undefined,
    eventRadiusKm: r.event_radius_km ?? undefined,
    customersPerWorkerHour: r.customers_per_worker_hour ?? undefined,
    hourlyWage: r.hourly_wage ?? undefined,
    minStaff: r.min_staff ?? undefined,
    maxStaffPerHour: r.max_staff_per_hour ?? undefined,
    allowedShiftLengths: parseNumArray(r.allowed_shift_lengths),
    transitRelevance: r.transit_relevance ?? undefined,
    nearbyRoutes: parseStrArray(r.nearby_routes),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export type BusinessInput = Omit<
  BusinessProfile,
  "id" | "createdAt" | "updatedAt"
>;

export const businesses = {
  list(ownerEmail: string): BusinessProfile[] {
    return (db.prepare(
      `SELECT * FROM businesses
       WHERE is_public = 1
          OR owner_email = ?
          OR id IN (
            SELECT business_id FROM sessions
            WHERE operator_email = ? AND business_id IS NOT NULL
          )
       ORDER BY is_public ASC, created_at DESC`,
    ).all(ownerEmail, ownerEmail) as Row[]).map(toProfile);
  },

  owns(id: string, ownerEmail: string): boolean {
    return (
      db.prepare(
        `SELECT 1 FROM businesses
         WHERE id = ?
           AND (
            is_public = 1 OR
             owner_email = ?
             OR id IN (
               SELECT business_id FROM sessions
               WHERE operator_email = ? AND business_id IS NOT NULL
             )
           )`,
      ).get(id, ownerEmail, ownerEmail) !== undefined
    );
  },

  get(id: string): BusinessProfile | undefined {
    const row = db.prepare("SELECT * FROM businesses WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? toProfile(row) : undefined;
  },

  create(input: BusinessInput, owner?: { email?: string; name?: string }): BusinessProfile {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO businesses
        (id, owner_email, owner_name, is_public, name, business_type, address, lon, lat, ward, neighbourhood, headcount, notes,
         opens_at, closes_at, event_radius_km, customers_per_worker_hour, hourly_wage,
         min_staff, max_staff_per_hour, allowed_shift_lengths, transit_relevance, nearby_routes,
         created_at, updated_at)
       VALUES (@id, @owner_email, @owner_name, @is_public, @name, @business_type, @address, @lon, @lat, @ward, @neighbourhood, @headcount, @notes,
         @opens_at, @closes_at, @event_radius_km, @customers_per_worker_hour, @hourly_wage,
         @min_staff, @max_staff_per_hour, @allowed_shift_lengths, @transit_relevance, @nearby_routes,
         @created_at, @updated_at)`,
    ).run({
      id,
      owner_email: owner?.email ?? null,
      owner_name: owner?.name ?? null,
      is_public: 0,
      name: input.name,
      business_type: input.businessType,
      address: input.address,
      lon: input.lon,
      lat: input.lat,
      ward: input.ward ?? null,
      neighbourhood: input.neighbourhood ?? null,
      headcount: input.headcount,
      notes: input.notes ?? null,
      opens_at: input.opensAt ?? null,
      closes_at: input.closesAt ?? null,
      event_radius_km: input.eventRadiusKm ?? null,
      customers_per_worker_hour: input.customersPerWorkerHour ?? null,
      hourly_wage: input.hourlyWage ?? null,
      min_staff: input.minStaff ?? null,
      max_staff_per_hour: input.maxStaffPerHour ?? null,
      allowed_shift_lengths:
        input.allowedShiftLengths && input.allowedShiftLengths.length
          ? JSON.stringify(input.allowedShiftLengths)
          : null,
      transit_relevance: input.transitRelevance ?? null,
      nearby_routes:
        input.nearbyRoutes && input.nearbyRoutes.length ? JSON.stringify(input.nearbyRoutes) : null,
      created_at: now,
      updated_at: now,
    });
    return this.get(id)!;
  },

  remove(id: string): boolean {
    return db.prepare("DELETE FROM businesses WHERE id = ?").run(id).changes > 0;
  },
};

// Public demo business — accessible to every signed-in operator and used as a
// safe default when someone has no personal businesses yet.
db.prepare(
  `INSERT OR IGNORE INTO businesses
    (id, owner_email, owner_name, is_public, name, business_type, address, lon, lat, ward, neighbourhood, headcount, notes,
     opens_at, closes_at, event_radius_km, customers_per_worker_hour, hourly_wage, min_staff, max_staff_per_hour,
     allowed_shift_lengths, transit_relevance, nearby_routes, created_at, updated_at)
   VALUES
    (?, NULL, NULL, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).run(
  "demo-store-city-hall",
  "Toronto Demo Store",
  "retail store",
  "100 Queen St W, Toronto, ON",
  -79.3839,
  43.6535,
  "Toronto Centre",
  "Downtown",
  3,
  "Public demo business for any session.",
  9,
  21,
  1.5,
  12,
  18,
  1,
  4,
  JSON.stringify([4, 6, 8]),
  "high",
  JSON.stringify(["TTC Subway", "Queen Streetcar"]),
  new Date().toISOString(),
  new Date().toISOString(),
);

db.exec(`
  CREATE TABLE IF NOT EXISTS business_history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    date          TEXT NOT NULL,
    hour          INTEGER NOT NULL CHECK(hour >= 0 AND hour <= 23),
    revenue       REAL,
    customer_count INTEGER,
    notes         TEXT,
    UNIQUE(business_id, date, hour)
  );
  CREATE INDEX IF NOT EXISTS idx_bh_business ON business_history(business_id, date DESC);

  CREATE TABLE IF NOT EXISTS business_schedule (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    date          TEXT NOT NULL,
    hour          INTEGER NOT NULL CHECK(hour >= 0 AND hour <= 23),
    staff_count   INTEGER NOT NULL DEFAULT 1,
    role          TEXT,
    UNIQUE(business_id, date, hour, role)
  );
  CREATE INDEX IF NOT EXISTS idx_bs_business ON business_schedule(business_id, date DESC);
`);

export interface HistoryRow {
  id: number;
  business_id: string;
  date: string;
  hour: number;
  revenue: number | null;
  customer_count: number | null;
  notes: string | null;
}

export interface ScheduleRow {
  id: number;
  business_id: string;
  date: string;
  hour: number;
  staff_count: number;
  role: string | null;
}

export type HistoryInsert = Omit<HistoryRow, "id">;
export type ScheduleInsert = Omit<ScheduleRow, "id">;

export const businessHistory = {
  upsertMany(rows: HistoryInsert[]): void {
    const stmt = db.prepare(`
      INSERT INTO business_history (business_id, date, hour, revenue, customer_count, notes)
      VALUES (@business_id, @date, @hour, @revenue, @customer_count, @notes)
      ON CONFLICT(business_id, date, hour) DO UPDATE SET
        revenue = excluded.revenue,
        customer_count = excluded.customer_count,
        notes = excluded.notes
    `);
    const run = db.transaction((rs: HistoryInsert[]) => rs.forEach((r) => stmt.run(r)));
    run(rows);
  },

  forBusiness(businessId: string, daysBack = 90): HistoryRow[] {
    const cutoff = new Date(Date.now() - daysBack * 86_400_000).toISOString().slice(0, 10);
    return db.prepare(
      "SELECT * FROM business_history WHERE business_id = ? AND date >= ? ORDER BY date DESC, hour ASC",
    ).all(businessId, cutoff) as HistoryRow[];
  },

  summary(businessId: string): {
    totalDays: number;
    avgDailyRevenue: number | null;
    avgDailyCustomers: number | null;
    peakHour: number | null;
    peakDow: number | null;
  } {
    const rows = businessHistory.forBusiness(businessId, 90);
    if (!rows.length) return { totalDays: 0, avgDailyRevenue: null, avgDailyCustomers: null, peakHour: null, peakDow: null };

    const byHour: Record<number, number[]> = {};
    const byDow: Record<number, number[]> = {};
    const byDate: Record<string, number> = {};
    let totalRev = 0, totalCust = 0, revCount = 0, custCount = 0;

    for (const r of rows) {
      if (r.revenue != null) { totalRev += r.revenue; revCount++; byDate[r.date] = (byDate[r.date] ?? 0) + r.revenue; }
      if (r.customer_count != null) { totalCust += r.customer_count; custCount++; }
      byHour[r.hour] = [...(byHour[r.hour] ?? []), r.customer_count ?? r.revenue ?? 0];
      const dow = new Date(r.date).getDay();
      byDow[dow] = [...(byDow[dow] ?? []), r.customer_count ?? r.revenue ?? 0];
    }

    const avgByHour = Object.entries(byHour).map(([h, vs]) => [Number(h), vs.reduce((a, b) => a + b, 0) / vs.length] as [number, number]);
    const avgByDow  = Object.entries(byDow).map(([d, vs])  => [Number(d), vs.reduce((a, b) => a + b, 0) / vs.length] as [number, number]);
    const peakHour = avgByHour.sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const peakDow  = avgByDow.sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const dates = Object.keys(byDate);

    return {
      totalDays: dates.length,
      avgDailyRevenue: revCount ? Math.round(totalRev / dates.length) : null,
      avgDailyCustomers: custCount ? Math.round(totalCust / dates.length) : null,
      peakHour,
      peakDow,
    };
  },
};

export const businessSchedule = {
  upsertMany(rows: ScheduleInsert[]): void {
    const stmt = db.prepare(`
      INSERT INTO business_schedule (business_id, date, hour, staff_count, role)
      VALUES (@business_id, @date, @hour, @staff_count, @role)
      ON CONFLICT(business_id, date, hour, role) DO UPDATE SET staff_count = excluded.staff_count
    `);
    const run = db.transaction((rs: ScheduleInsert[]) => rs.forEach((r) => stmt.run(r)));
    run(rows);
  },

  forBusiness(businessId: string, daysBack = 14): ScheduleRow[] {
    const cutoff = new Date(Date.now() - daysBack * 86_400_000).toISOString().slice(0, 10);
    return db.prepare(
      "SELECT * FROM business_schedule WHERE business_id = ? AND date >= ? ORDER BY date ASC, hour ASC",
    ).all(businessId, cutoff) as ScheduleRow[];
  },

  upcoming(businessId: string, daysAhead = 7): ScheduleRow[] {
    const today = new Date().toISOString().slice(0, 10);
    const end   = new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
    return db.prepare(
      "SELECT * FROM business_schedule WHERE business_id = ? AND date >= ? AND date <= ? ORDER BY date ASC, hour ASC",
    ).all(businessId, today, end) as ScheduleRow[];
  },
};

interface SnapshotRow {
  id: number;
  captured_at: string;
  location: string;
  business_type: string | null;
  lon: number | null;
  lat: number | null;
  features: string;
  digest: string;
  forecast_score: number;
  forecast_level: string;
  forecast_headline: string;
}

export type SnapshotInsert = Omit<SnapshotRow, "id">;

db.exec(`
  CREATE TABLE IF NOT EXISTS business_research (
    business_id   TEXT PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
    status        TEXT NOT NULL DEFAULT 'pending',
    briefing      TEXT NOT NULL DEFAULT '',
    sources       TEXT NOT NULL DEFAULT '[]',
    generated_at  TEXT NOT NULL,
    error         TEXT
  );
`);

interface ResearchRow {
  business_id: string;
  status: string;
  briefing: string;
  sources: string;
  generated_at: string;
  error: string | null;
}

export interface BusinessResearchRow {
  business_id: string;
  status: string;
  briefing: string;
  sources: string[];
  generated_at: string;
  error: string | null;
}

export const businessResearch = {
  get(businessId: string): BusinessResearchRow | undefined {
    const row = db.prepare("SELECT * FROM business_research WHERE business_id = ?").get(businessId) as
      | ResearchRow
      | undefined;
    if (!row) return undefined;
    let sources: string[] = [];
    try {
      sources = JSON.parse(row.sources) as string[];
    } catch {
      sources = [];
    }
    const { sources: _raw, ...rest } = row;
    return { ...rest, sources };
  },

  setPending(businessId: string): void {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO business_research (business_id, status, briefing, sources, generated_at)
       VALUES (?, 'pending', '', '[]', ?)
       ON CONFLICT(business_id) DO UPDATE SET status = 'pending', error = NULL, generated_at = excluded.generated_at`,
    ).run(businessId, now);
  },

  save(businessId: string, briefing: string, sources: string[]): ResearchRow {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO business_research (business_id, status, briefing, sources, generated_at, error)
       VALUES (?, 'ready', ?, ?, ?, NULL)
       ON CONFLICT(business_id) DO UPDATE SET
         status = 'ready', briefing = excluded.briefing, sources = excluded.sources,
         generated_at = excluded.generated_at, error = NULL`,
    ).run(businessId, briefing, JSON.stringify(sources), now);
    return db.prepare("SELECT * FROM business_research WHERE business_id = ?").get(businessId) as ResearchRow;
  },

  setError(businessId: string, error: string): void {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO business_research (business_id, status, briefing, sources, generated_at, error)
       VALUES (?, 'error', '', '[]', ?, ?)
       ON CONFLICT(business_id) DO UPDATE SET status = 'error', error = excluded.error, generated_at = excluded.generated_at`,
    ).run(businessId, now, error);
  },
};

// ---- Auth sessions (public-hosting guardrail) ------------------------------
// A session is minted after an operator completes the onboarding form. The
// opaque token gates the API + terminal and is the key used for per-user rate
// limiting. Persisted so sessions survive a server restart.
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    token         TEXT PRIMARY KEY,
    business_id   TEXT REFERENCES businesses(id) ON DELETE SET NULL,
    operator_name TEXT NOT NULL,
    operator_email TEXT NOT NULL,
    company       TEXT,
    created_at    TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_email ON sessions(operator_email);
`);

interface SessionRow {
  token: string;
  business_id: string | null;
  operator_name: string;
  operator_email: string;
  company: string | null;
  created_at: string;
  last_seen_at: string;
}

export interface SessionRecord {
  token: string;
  businessId: string | null;
  operatorName: string;
  operatorEmail: string;
  company?: string;
  createdAt: string;
  lastSeenAt: string;
}

function toSession(r: SessionRow): SessionRecord {
  return {
    token: r.token,
    businessId: r.business_id,
    operatorName: r.operator_name,
    operatorEmail: r.operator_email,
    company: r.company ?? undefined,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
  };
}

export const sessions = {
  create(input: {
    token: string;
    businessId: string | null;
    operatorName: string;
    operatorEmail: string;
    company?: string;
  }): SessionRecord {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO sessions (token, business_id, operator_name, operator_email, company, created_at, last_seen_at)
       VALUES (@token, @business_id, @operator_name, @operator_email, @company, @created_at, @last_seen_at)`,
    ).run({
      token: input.token,
      business_id: input.businessId,
      operator_name: input.operatorName,
      operator_email: input.operatorEmail,
      company: input.company ?? null,
      created_at: now,
      last_seen_at: now,
    });
    return this.get(input.token)!;
  },

  get(token: string): SessionRecord | undefined {
    const row = db.prepare("SELECT * FROM sessions WHERE token = ?").get(token) as SessionRow | undefined;
    return row ? toSession(row) : undefined;
  },

  touch(token: string): void {
    db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token = ?").run(new Date().toISOString(), token);
  },

  /** Count sessions created by an email since a cutoff — abuse throttle. */
  countByEmailSince(email: string, sinceIso: string): number {
    return (
      db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE operator_email = ? AND created_at >= ?").get(email, sinceIso) as {
        n: number;
      }
    ).n;
  },

  remove(token: string): boolean {
    return db.prepare("DELETE FROM sessions WHERE token = ?").run(token).changes > 0;
  },
};

// Backfill ownership from historic session rows so previously created businesses
// remain visible to their operator after the app starts scoping by owner.
db.exec(`
  UPDATE businesses
  SET
    owner_email = COALESCE(
      owner_email,
      (SELECT operator_email FROM sessions WHERE sessions.business_id = businesses.id ORDER BY created_at DESC LIMIT 1)
    ),
    owner_name = COALESCE(
      owner_name,
      (SELECT operator_name FROM sessions WHERE sessions.business_id = businesses.id ORDER BY created_at DESC LIMIT 1)
    )
  WHERE owner_email IS NULL OR owner_name IS NULL;
`);

export const snapshots = {
  insert(row: SnapshotInsert): void {
    db.prepare(`
      INSERT INTO signal_snapshots
        (captured_at, location, business_type, lon, lat, features, digest,
         forecast_score, forecast_level, forecast_headline)
      VALUES
        (@captured_at, @location, @business_type, @lon, @lat, @features, @digest,
         @forecast_score, @forecast_level, @forecast_headline)
    `).run(row);
  },

  recent(maxAgeMinutes = 43200): SnapshotRow[] {
    const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000).toISOString();
    return db.prepare(
      "SELECT * FROM signal_snapshots WHERE captured_at > ? ORDER BY captured_at DESC LIMIT 5000",
    ).all(cutoff) as SnapshotRow[];
  },

  count(): number {
    return (db.prepare("SELECT COUNT(*) as n FROM signal_snapshots").get() as { n: number }).n;
  },
};
