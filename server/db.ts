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
  CREATE TABLE IF NOT EXISTS businesses (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    business_type TEXT NOT NULL,
    address       TEXT NOT NULL,
    lon           REAL NOT NULL,
    lat           REAL NOT NULL,
    ward          TEXT,
    neighbourhood TEXT,
    headcount     INTEGER NOT NULL DEFAULT 1,
    notes         TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );
`);

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
  created_at: string;
  updated_at: string;
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
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export type BusinessInput = Omit<
  BusinessProfile,
  "id" | "createdAt" | "updatedAt"
>;

export const businesses = {
  list(): BusinessProfile[] {
    return (db.prepare("SELECT * FROM businesses ORDER BY created_at DESC").all() as Row[]).map(
      toProfile,
    );
  },

  get(id: string): BusinessProfile | undefined {
    const row = db.prepare("SELECT * FROM businesses WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? toProfile(row) : undefined;
  },

  create(input: BusinessInput): BusinessProfile {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO businesses
        (id, name, business_type, address, lon, lat, ward, neighbourhood, headcount, notes, created_at, updated_at)
       VALUES (@id, @name, @business_type, @address, @lon, @lat, @ward, @neighbourhood, @headcount, @notes, @created_at, @updated_at)`,
    ).run({
      id,
      name: input.name,
      business_type: input.businessType,
      address: input.address,
      lon: input.lon,
      lat: input.lat,
      ward: input.ward ?? null,
      neighbourhood: input.neighbourhood ?? null,
      headcount: input.headcount,
      notes: input.notes ?? null,
      created_at: now,
      updated_at: now,
    });
    return this.get(id)!;
  },

  remove(id: string): boolean {
    return db.prepare("DELETE FROM businesses WHERE id = ?").run(id).changes > 0;
  },
};
