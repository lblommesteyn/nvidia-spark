#!/usr/bin/env python3
"""
Build a compact GO rail schedule + geometry file from the Metrolinx GO GTFS feed.

Reads a GTFS export (routes/trips/shapes/stop_times/stops/calendar_dates) and
emits server/data/go-gtfs.json containing, for the seven GO train lines:

  - real route geometry (the full-corridor shape per direction, simplified)
  - the ordered list of stations per line
  - a realistic schedule: every trip's departure second-of-day + duration,
    bucketed by day type (weekday / sat / sun)

The frontend "GO Trains (live)" layer replays this schedule against the current
Toronto wall-clock, so trains only appear during real service hours, at real
frequency (rush-hour dense, midnight empty), taking the real travel time.

Stdlib only (Python 3.9). Usage:
    python3 scripts/build-go-gtfs.py [GTFS_DIR]
GTFS_DIR defaults to /tmp/go-gtfs (an unzipped GO-GTFS.zip).
"""
import csv, datetime, json, os, sys
from collections import defaultdict

GTFS_DIR = sys.argv[1] if len(sys.argv) > 1 else "/tmp/go-gtfs"
OUT = os.path.join(os.path.dirname(__file__), "..", "server", "data", "go-gtfs.json")

# GO rail lines keyed by short_name -> friendly name. (route_type == 2)
RAIL_NAMES = {
    "LW": "Lakeshore West",
    "LE": "Lakeshore East",
    "KI": "Kitchener",
    "MI": "Milton",
    "BR": "Barrie",
    "RH": "Richmond Hill",
    "ST": "Stouffville",
}


def rd(name):
    return csv.DictReader(open(os.path.join(GTFS_DIR, name), encoding="utf-8-sig"))


def to_sec(hms):
    h, m, s = hms.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def simplify(points, max_pts=160):
    """Evenly downsample a polyline to at most max_pts vertices (keep ends)."""
    if len(points) <= max_pts:
        return points
    step = (len(points) - 1) / (max_pts - 1)
    out = [points[round(i * step)] for i in range(max_pts)]
    out[-1] = points[-1]
    return out


def main():
    # 1) rail routes: short_name + colour, mapping every route_id to a short name.
    short_by_route = {}
    color_by_short = {}
    for r in rd("routes.txt"):
        if r["route_type"] != "2":
            continue
        sn = r["route_short_name"]
        if sn not in RAIL_NAMES:
            continue
        short_by_route[r["route_id"]] = sn
        color_by_short[sn] = "#" + r["route_color"].lower()

    # 2) representative service_id (a real date) per day type, within the feed.
    daytype = {}
    for r in rd("calendar_dates.txt"):
        d = r["service_id"]
        dt = datetime.date(int(d[:4]), int(d[4:6]), int(d[6:8]))
        wd = dt.weekday()
        key = "weekday" if wd < 5 else ("sat" if wd == 5 else "sun")
        daytype.setdefault(key, d)
    rep_service = {v: k for k, v in daytype.items()}  # service_id -> day type
    print("representative service days:", daytype)

    # 3) trips for those representative days on rail routes.
    #    track: per (short, dir) candidate shapes; per trip its short/dir/shape/day.
    trips = {}  # trip_id -> {short,dir,shape,day}
    shape_use = defaultdict(int)  # (short,dir,shape_id) -> trip count (pick popular)
    for r in rd("trips.txt"):
        sid = r["service_id"]
        if sid not in rep_service:
            continue
        short = short_by_route.get(r["route_id"])
        if not short:
            continue
        d = int(r["direction_id"] or 0)
        trips[r["trip_id"]] = {
            "short": short,
            "dir": d,
            "shape": r["shape_id"],
            "day": rep_service[sid],
        }
        shape_use[(short, d, r["shape_id"])] += 1
    print("rail trips across rep days:", len(trips))

    # 4) min departure / max arrival per needed trip from stop_times (single stream).
    #    also remember the first/last stop_id of each trip for station ordering.
    need = set(trips)
    tmin = {}
    tmax = {}
    seqstops = defaultdict(list)  # trip_id -> [(seq, stop_id)] (only for candidate trips)
    for r in rd("stop_times.txt"):
        tid = r["trip_id"]
        if tid not in need:
            continue
        dep = to_sec(r["departure_time"])
        arr = to_sec(r["arrival_time"])
        if tid not in tmin or dep < tmin[tid]:
            tmin[tid] = dep
        if tid not in tmax or arr > tmax[tid]:
            tmax[tid] = arr
        seqstops[tid].append((int(r["stop_sequence"]), r["stop_id"]))

    # 5) choose the canonical full-length shape per (short, dir): the most-used
    #    shape among trips, breaking ties by point count later.
    best_shape = {}  # (short,dir) -> shape_id
    by_pair = defaultdict(list)
    for (short, d, shp), n in shape_use.items():
        by_pair[(short, d)].append((n, shp))
    # We need point counts to break ties / prefer the longest corridor — gather
    # candidate shape ids first, then read shapes.txt once.
    candidate_shapes = set(shp for lst in by_pair.values() for _, shp in lst)
    shape_pts = defaultdict(list)  # shape_id -> [(seq, lat, lon)]
    for r in rd("shapes.txt"):
        shp = r["shape_id"]
        if shp not in candidate_shapes:
            continue
        shape_pts[shp].append(
            (int(r["shape_pt_sequence"]), float(r["shape_pt_lat"]), float(r["shape_pt_lon"]))
        )
    for pair, lst in by_pair.items():
        # prefer most points (full corridor), then most-used.
        lst.sort(key=lambda ns: (len(shape_pts.get(ns[1], [])), ns[0]), reverse=True)
        best_shape[pair] = lst[0][1]

    # 6) stations per line: from the canonical longest trip (dir 0) stop sequence.
    stops = {}  # stop_id -> {name, lat, lon}
    for r in rd("stops.txt"):
        stops[r["stop_id"]] = {
            "name": r["stop_name"],
            "lat": float(r["stop_lat"]),
            "lon": float(r["stop_lon"]),
        }

    def canonical_trip(short, d):
        shp = best_shape.get((short, d))
        # the trip on that shape with the most stops = the all-stops local run.
        best, blen = None, -1
        for tid, t in trips.items():
            if t["short"] == short and t["dir"] == d and t["shape"] == shp:
                L = len(seqstops.get(tid, []))
                if L > blen:
                    best, blen = tid, L
        return best

    out_routes = []
    out_trips = []
    for short, name in RAIL_NAMES.items():
        geom = {}
        stations = {}
        for d in (0, 1):
            shp = best_shape.get((short, d))
            if shp and shape_pts.get(shp):
                pts = sorted(shape_pts[shp])
                geom[str(d)] = simplify([[round(lon, 5), round(lat, 5)] for _, lat, lon in pts])
            ctid = canonical_trip(short, d)
            if ctid:
                seq = sorted(seqstops[ctid])
                stations[str(d)] = [
                    {"name": stops[sid]["name"], "lon": round(stops[sid]["lon"], 5), "lat": round(stops[sid]["lat"], 5)}
                    for _, sid in seq
                    if sid in stops
                ]
        out_routes.append(
            {"short": short, "name": name, "color": color_by_short.get(short, "#0f7a3d"),
             "geometry": geom, "stations": stations}
        )

    # trips schedule (compact): [short, dir, depSec, durSec, dayType]
    by_day = defaultdict(int)
    for tid, t in trips.items():
        if tid not in tmin or tid not in tmax:
            continue
        dep = tmin[tid]
        dur = max(60, tmax[tid] - dep)
        out_trips.append([t["short"], t["dir"], dep, dur, t["day"]])
        by_day[t["day"]] += 1
    out_trips.sort(key=lambda x: (x[4], x[0], x[2]))

    data = {
        "generatedFrom": "Metrolinx GO GTFS",
        "feedVersion": next(rd("feed_info.txt"))["feed_version"],
        "routes": out_routes,
        "trips": out_trips,
        "tripCounts": dict(by_day),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    kb = os.path.getsize(OUT) / 1024
    print(f"wrote {OUT} ({kb:.0f} KB) — {len(out_routes)} lines, {len(out_trips)} trips")
    print("trips per day type:", dict(by_day))


if __name__ == "__main__":
    main()
