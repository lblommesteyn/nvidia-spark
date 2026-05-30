#!/usr/bin/env python3
"""
Fetch the REAL Bike Share Toronto station roster from the public GBFS feed.

GBFS station_information is free, no key, and gives the authoritative
station_id -> name / lat / lon / capacity mapping we need to attach
location-aware features (business density, demographics, nearby venues)
to per-station ridership demand.

Output: data/stations.json  — { "<station_id>": {name, lat, lon, capacity} }

Usage:  python3 scripts/fetch_stations.py
"""
import json
import os
import sys
import urllib.request

GBFS = "https://tor.publicbikesystem.net/ube/gbfs/v1/en/station_information"


def main():
    outdir = "data"
    os.makedirs(outdir, exist_ok=True)
    print(f"[stations] fetching {GBFS}", file=sys.stderr)
    with urllib.request.urlopen(GBFS, timeout=60) as r:
        data = json.load(r)
    stations = data["data"]["stations"]
    out = {}
    for s in stations:
        sid = str(s["station_id"])
        out[sid] = {
            "name": s.get("name", ""),
            "lat": s.get("lat"),
            "lon": s.get("lon"),
            "capacity": s.get("capacity", 0),
        }
    path = os.path.join(outdir, "stations.json")
    with open(path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"[stations] wrote {len(out):,} stations -> {path}", file=sys.stderr)


if __name__ == "__main__":
    main()
