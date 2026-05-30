#!/usr/bin/env python3
"""
Build the Toronto live-events feature source for the demand dataset.

  venues.json        REAL major Toronto venues (name, coords, capacity, kind).
                     Coordinates and capacities are real, verified landmarks.

  concerts-<year>.jsonl   a per-day events calendar at those venues.
                     There is NO free historical concert/setlist API, so this
                     calendar is SYNTHESIZED with venue-appropriate cadence and
                     seasonality, and every row is tagged  "synthetic": true
                     so training/eval can weight or exclude it honestly.

A station near a venue on an event day gets an "events nearby" demand feature.

Usage:  python3 scripts/venues_concerts.py --year 2024
"""
import argparse
import json
import os
import random
import sys
from datetime import date, timedelta

# REAL Toronto venues — coordinates & capacities are real.
VENUES = [
    {"id": "scotiabank-arena", "name": "Scotiabank Arena", "lat": 43.6435, "lon": -79.3791,
     "capacity": 19800, "kind": "arena", "weeklyShows": 4, "months": list(range(1, 13))},
    {"id": "rogers-centre", "name": "Rogers Centre", "lat": 43.6414, "lon": -79.3894,
     "capacity": 49000, "kind": "stadium", "weeklyShows": 3, "months": list(range(4, 11))},
    {"id": "budweiser-stage", "name": "Budweiser Stage", "lat": 43.6285, "lon": -79.4155,
     "capacity": 16000, "kind": "amphitheatre", "weeklyShows": 4, "months": [5, 6, 7, 8, 9]},
    {"id": "bmo-field", "name": "BMO Field", "lat": 43.6332, "lon": -79.4185,
     "capacity": 28000, "kind": "stadium", "weeklyShows": 2, "months": list(range(3, 12))},
    {"id": "history", "name": "HISTORY", "lat": 43.6646, "lon": -79.3312,
     "capacity": 2500, "kind": "club", "weeklyShows": 3, "months": list(range(1, 13))},
    {"id": "massey-hall", "name": "Massey Hall", "lat": 43.6544, "lon": -79.3789,
     "capacity": 2765, "kind": "theatre", "weeklyShows": 3, "months": list(range(1, 13))},
    {"id": "roy-thomson-hall", "name": "Roy Thomson Hall", "lat": 43.6466, "lon": -79.3863,
     "capacity": 2630, "kind": "theatre", "weeklyShows": 3, "months": list(range(1, 13))},
    {"id": "danforth-music-hall", "name": "The Danforth Music Hall", "lat": 43.6766, "lon": -79.3576,
     "capacity": 1500, "kind": "club", "weeklyShows": 3, "months": list(range(1, 13))},
    {"id": "phoenix-concert", "name": "The Phoenix Concert Theatre", "lat": 43.6677, "lon": -79.3637,
     "capacity": 1350, "kind": "club", "weeklyShows": 3, "months": list(range(1, 13))},
    {"id": "coca-cola-coliseum", "name": "Coca-Cola Coliseum", "lat": 43.6360, "lon": -79.4128,
     "capacity": 8100, "kind": "arena", "weeklyShows": 2, "months": list(range(1, 13))},
    {"id": "meridian-hall", "name": "Meridian Hall", "lat": 43.6469, "lon": -79.3760,
     "capacity": 3191, "kind": "theatre", "weeklyShows": 2, "months": list(range(1, 13))},
    {"id": "rebel-nightclub", "name": "Rebel", "lat": 43.6443, "lon": -79.3520,
     "capacity": 2500, "kind": "club", "weeklyShows": 2, "months": list(range(1, 13))},
]

KIND_HOURS = {  # typical event start hour
    "arena": 19, "stadium": 19, "amphitheatre": 19, "theatre": 20, "club": 21,
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, default=2024)
    ap.add_argument("--outdir", default="data")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()
    os.makedirs(args.outdir, exist_ok=True)
    rng = random.Random(args.seed)

    # Write the real venue table.
    vpath = os.path.join(args.outdir, "venues.json")
    json.dump({v["id"]: v for v in VENUES}, open(vpath, "w"), separators=(",", ":"))
    print(f"[venues] wrote {len(VENUES)} real venues -> {vpath}", file=sys.stderr)

    cpath = os.path.join(args.outdir, f"concerts-{args.year}.jsonl")
    d = date(args.year, 1, 1)
    end = date(args.year, 12, 31)
    n = 0
    with open(cpath, "w") as cf:
        while d <= end:
            dow = d.weekday()  # 0=Mon
            weekend_boost = 1.6 if dow >= 4 else 1.0  # Fri/Sat/Sun busier
            for v in VENUES:
                if d.month not in v["months"]:
                    continue
                p = (v["weeklyShows"] / 7.0) * weekend_boost
                if rng.random() < p:
                    occ = rng.uniform(0.55, 0.98)
                    rec = {
                        "date": d.isoformat(),
                        "venueId": v["id"],
                        "venue": v["name"],
                        "lat": v["lat"],
                        "lon": v["lon"],
                        "kind": v["kind"],
                        "startHour": KIND_HOURS[v["kind"]],
                        "capacity": v["capacity"],
                        "attendanceEst": int(v["capacity"] * occ),
                        "synthetic": True,
                    }
                    cf.write(json.dumps(rec, separators=(",", ":")) + "\n")
                    n += 1
            d += timedelta(days=1)
    print(f"[venues] wrote {n:,} synthetic {args.year} events -> {cpath}", file=sys.stderr)


if __name__ == "__main__":
    main()
