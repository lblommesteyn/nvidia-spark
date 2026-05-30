#!/usr/bin/env python3
"""
Build the LOCATION-AWARE demand-forecasting training set for Toronto Monitor.

This is the richer successor to backfill_dataset.py. Instead of one city-wide
demand number per hour, it produces demand per BIKE-SHARE STATION per hour and
attaches real location features, so the model learns how demand depends on
*where* you are, not just the time and weather.

Joined signals
  LABEL    (real)  per-station hourly Bike Share trips, normalized to each
                   station's own 95th-percentile (self-relative busyness).
  STATIC   (real)  Google Places commercial gravity per station: business
                   density, food/retail/nightlife mix, avg rating, price level.
  WEATHER  (real)  Open-Meteo historical hourly archive (one call/year).
  CALENDAR (real)  day-of-week, weekend, Ontario holiday, season, meal window.
  EVENTS   (synth) nearby concerts/games that day from data/concerts-<year>.jsonl
                   (real venues, synthesized dates — tagged in provenance).

Outputs (data/)
  demand-loc-<year>.jsonl     tabular: features + real label + provenance
  forecast-loc-train.jsonl    instruction JSONL (signals -> forecast JSON)
  forecast-loc-val.jsonl      ~10% held-out

Level classes are balanced (low rows are capped) so the model isn't swamped by
quiet overnight hours.

Usage:
  python3 scripts/backfill_location.py \
      --csv /tmp/tomon/bikeshare-ridership-2024.csv --year 2024
"""
import argparse
import csv
import json
import math
import os
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime

WMO = {
    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Rime fog", 51: "Light drizzle", 53: "Drizzle", 55: "Dense drizzle",
    61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain",
    71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
    80: "Rain showers", 81: "Rain showers", 82: "Violent rain showers",
    85: "Snow showers", 86: "Heavy snow showers",
    95: "Thunderstorm", 96: "Thunderstorm w/ hail", 99: "Thunderstorm w/ hail",
}

HOLIDAYS = {
    "2024-01-01", "2024-02-19", "2024-03-29", "2024-05-20", "2024-07-01",
    "2024-08-05", "2024-09-02", "2024-10-14", "2024-12-25", "2024-12-26",
    "2023-01-01", "2023-02-20", "2023-04-07", "2023-05-22", "2023-07-01",
    "2023-08-07", "2023-09-04", "2023-10-09", "2023-12-25", "2023-12-26",
    "2025-01-01", "2025-02-17", "2025-04-18", "2025-05-19", "2025-07-01",
    "2025-08-04", "2025-09-01", "2025-10-13", "2025-12-25", "2025-12-26",
}

DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
EVENT_RADIUS_M = 1200.0


def season(m):
    return ("winter", "spring", "summer", "fall")[(m % 12) // 3]


def meal_window(h):
    if 11 <= h <= 14:
        return "lunch"
    if 17 <= h <= 20:
        return "dinner"
    if 7 <= h <= 10:
        return "morning"
    return "off-peak"


def level_from_norm(n):
    if n < 0.35:
        return "low"
    if n < 0.55:
        return "moderate"
    if n < 0.75:
        return "elevated"
    return "surge"


def haversine(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def fetch_weather(year):
    url = (
        "https://archive-api.open-meteo.com/v1/archive?latitude=43.6535&longitude=-79.3839"
        f"&start_date={year}-01-01&end_date={year}-12-31"
        "&hourly=temperature_2m,precipitation,wind_speed_10m,weather_code"
        "&wind_speed_unit=kmh&timezone=America%2FToronto"
    )
    print("  fetching Open-Meteo archive…", file=sys.stderr)
    with urllib.request.urlopen(url, timeout=120) as r:
        data = json.load(r)
    h = data["hourly"]
    out = {}
    for i, t in enumerate(h["time"]):
        key = t[:10] + " " + t[11:13]
        out[key] = {
            "temperatureC": round(h["temperature_2m"][i]) if h["temperature_2m"][i] is not None else None,
            "precipMm": h["precipitation"][i] or 0.0,
            "windKph": round(h["wind_speed_10m"][i]) if h["wind_speed_10m"][i] is not None else None,
            "code": int(h["weather_code"][i] or 0),
        }
    print(f"  weather: {len(out):,} hourly records", file=sys.stderr)
    return out


def aggregate_station_hours(csv_path, keep_ids):
    """Stream CSV -> counts[station_id]['YYYY-MM-DD HH'] = trips, only for keep_ids."""
    counts = defaultdict(lambda: defaultdict(int))
    n = 0
    with open(csv_path, newline="", encoding="utf-8", errors="replace") as f:
        reader = csv.DictReader(f)
        for row in reader:
            sid = (row.get("Start_Station_Id") or row.get("Start Station Id") or "").strip()
            if sid not in keep_ids:
                n += 1
                continue
            st = row.get("Start_Time") or row.get("Start Time") or ""
            if len(st) < 13:
                continue
            counts[sid][st[:13]] += 1
            n += 1
            if n % 1_000_000 == 0:
                print(f"  ...{n:,} trips streamed", file=sys.stderr)
    print(f"  done: {n:,} trips; {len(counts)} target stations have data", file=sys.stderr)
    return counts


def load_concert_days(path):
    """date -> list of (lat, lon, attendanceEst)."""
    days = defaultdict(list)
    if not os.path.exists(path):
        return days
    with open(path) as f:
        for line in f:
            r = json.loads(line)
            days[r["date"]].append((r["lat"], r["lon"], r.get("attendanceEst", 0)))
    return days


def station_event_dates(stations, sids, concert_days):
    """Per station: date -> (count, attendance) for events within EVENT_RADIUS_M."""
    out = {}
    for sid in sids:
        st = stations[sid]
        slat, slon = st["lat"], st["lon"]
        per_date = {}
        for d, evs in concert_days.items():
            cnt = 0
            att = 0
            for (lat, lon, a) in evs:
                if haversine(slat, slon, lat, lon) <= EVENT_RADIUS_M:
                    cnt += 1
                    att += a
            if cnt:
                per_date[d] = (cnt, att)
        out[sid] = per_date
    return out


SYSTEM = (
    "You are a Toronto demand-forecasting model for small businesses. Given the "
    "location profile and live civic signals, output ONLY a JSON demand forecast "
    "for the next ~12 hours at that location."
)


def build_drivers(feat):
    drivers = []
    mw = feat["mealWindow"]
    if mw == "lunch":
        drivers.append({"signal": "Lunch rush", "impact": "up", "detail": "Midday demand window."})
    elif mw == "dinner":
        drivers.append({"signal": "Dinner rush", "impact": "up", "detail": "Evening demand window."})
    elif mw == "morning":
        drivers.append({"signal": "Morning commute", "impact": "up", "detail": "AM commute window."})
    elif feat["localHour"] <= 5:
        drivers.append({"signal": "Overnight lull", "impact": "down", "detail": "Low ambient demand."})
    lp = feat["location"]
    if lp["commercialGravity"] >= 0.7:
        drivers.append({"signal": "Dense commercial area", "impact": "up",
                        "detail": f"{lp['placesCount']}+ businesses nearby (gravity {lp['commercialGravity']})."})
    if lp["nightlifeCount"] >= 2 and feat["localHour"] >= 20:
        drivers.append({"signal": "Nightlife district", "impact": "up",
                        "detail": f"{lp['nightlifeCount']} bars/clubs nearby for evening trade."})
    ev = feat["events"]
    if ev["count"] > 0:
        drivers.append({"signal": "Nearby event", "impact": "up",
                        "detail": f"{ev['count']} event(s) (~{ev['attendance']:,} attendance) within 1.2km."})
    w = feat["weather"]
    if w["precipMm"] >= 0.5:
        drivers.append({"signal": "Wet weather", "impact": "down", "detail": f"{w['description']} suppresses trips."})
    if w["temperatureC"] is not None and w["temperatureC"] <= -5:
        drivers.append({"signal": "Cold", "impact": "down", "detail": f"{w['temperatureC']}°C dampens movement."})
    if feat["isWeekend"]:
        drivers.append({"signal": "Weekend", "impact": "up", "detail": "Higher discretionary trips."})
    if feat["season"] == "summer":
        drivers.append({"signal": "Summer", "impact": "up", "detail": "Peak season."})
    elif feat["season"] == "winter":
        drivers.append({"signal": "Winter", "impact": "down", "detail": "Off-season demand."})
    return drivers[:5]


def to_instruction_row(feat, norm):
    level = level_from_norm(norm)
    drivers = build_drivers(feat)
    top = drivers[0]["signal"].lower() if drivers else "current conditions"
    headline = {
        "surge": f"Surge demand — driven by {top}.",
        "elevated": f"Elevated demand building — {top} in play.",
        "moderate": "Steady, moderate demand.",
        "low": "Quiet stretch — demand running low.",
    }[level]
    signals = {
        "location": feat["location"],
        "localHour": feat["localHour"],
        "dayOfWeek": feat["dayOfWeek"],
        "isWeekend": feat["isWeekend"],
        "isHoliday": feat["isHoliday"],
        "season": feat["season"],
        "weather": feat["weather"],
        "events": feat["events"],
    }
    user = ("Forecast customer demand for the next ~12 hours at this location.\n\n"
            "SIGNALS (JSON):\n" + json.dumps(signals, separators=(",", ":")))
    forecast = {"score": round(norm, 2), "level": level, "headline": headline,
                "drivers": drivers, "windows": [], "actions": []}
    return {"messages": [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": user},
        {"role": "assistant", "content": json.dumps(forecast, separators=(",", ":"))},
    ]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True)
    ap.add_argument("--year", type=int, required=True)
    ap.add_argument("--outdir", default="data")
    ap.add_argument("--low-cap", type=int, default=60000,
                    help="max 'low' instruction rows to keep (class balancing)")
    args = ap.parse_args()
    os.makedirs(args.outdir, exist_ok=True)

    stations = json.load(open(os.path.join(args.outdir, "stations.json")))
    places = json.load(open(os.path.join(args.outdir, "places-cache.json")))
    # Location set = stations we have BOTH coords and Places enrichment for.
    sids = [s for s in places
            if "error" not in places[s] and s in stations
            and stations[s].get("lat") is not None]
    print(f"[loc] {len(sids)} enriched stations form the location set", file=sys.stderr)

    weather = fetch_weather(args.year)
    concert_days = load_concert_days(os.path.join(args.outdir, f"concerts-{args.year}.jsonl"))
    print(f"[loc] {sum(len(v) for v in concert_days.values()):,} events across {len(concert_days)} days",
          file=sys.stderr)
    counts = aggregate_station_hours(args.csv, set(sids))
    ev_dates = station_event_dates(stations, [s for s in sids if s in counts], concert_days)

    demand_path = os.path.join(args.outdir, f"demand-loc-{args.year}.jsonl")
    train_path = os.path.join(args.outdir, "forecast-loc-train.jsonl")
    val_path = os.path.join(args.outdir, "forecast-loc-val.jsonl")

    rows = n_train = n_val = 0
    low_kept = 0
    level_hist = defaultdict(int)
    with open(demand_path, "w") as df, open(train_path, "w") as tf, open(val_path, "w") as vf:
        for sid in sids:
            if sid not in counts:
                continue
            st = stations[sid]
            pc = places[sid]
            location = {
                "stationId": sid,
                "name": st["name"],
                "commercialGravity": pc.get("commercialGravity", 0.0),
                "placesCount": pc.get("placesCount", 0),
                "foodCount": pc.get("foodCount", 0),
                "retailCount": pc.get("retailCount", 0),
                "nightlifeCount": pc.get("nightlifeCount", 0),
                "avgRating": pc.get("avgRating"),
                "priceLevel": pc.get("priceLevel"),
            }
            hourly = counts[sid]
            ordered = sorted(hourly.values())
            p95 = ordered[int(len(ordered) * 0.95)] if ordered else 0
            p95 = max(p95, 1)
            evmap = ev_dates.get(sid, {})

            for key in sorted(hourly.keys()):
                w = weather.get(key)
                if not w:
                    continue
                try:
                    dt = datetime.strptime(key, "%Y-%m-%d %H")
                except ValueError:
                    continue
                day_str = key[:10]
                dow_i = dt.weekday()
                trips = hourly[key]
                norm = min(1.0, trips / p95)
                ev_cnt, ev_att = evmap.get(day_str, (0, 0))
                feat = {
                    "datetime": key,
                    "location": location,
                    "localHour": dt.hour,
                    "dayOfWeek": DOW[dow_i],
                    "isWeekend": dow_i >= 5,
                    "isHoliday": day_str in HOLIDAYS,
                    "season": season(dt.month),
                    "mealWindow": meal_window(dt.hour),
                    "weather": {
                        "temperatureC": w["temperatureC"],
                        "precipMm": w["precipMm"],
                        "windKph": w["windKph"],
                        "weatherCode": w["code"],
                        "description": WMO.get(w["code"], "Unknown"),
                    },
                    "events": {"count": ev_cnt, "attendance": ev_att},
                }
                level = level_from_norm(norm)

                # Tabular row (always written — full real record).
                tab = {k: feat[k] for k in feat}
                tab["demand"] = trips
                tab["demandNorm"] = round(norm, 4)
                tab["level"] = level
                tab["provenance"] = {
                    "label": "bike-share-ridership",
                    "static": "google-places-new",
                    "weather": "open-meteo-archive",
                    "synthetic": ["events" if ev_cnt else None],
                }
                df.write(json.dumps(tab, separators=(",", ":")) + "\n")
                rows += 1

                # Class-balanced instruction rows.
                if level == "low":
                    if low_kept >= args.low_cap:
                        continue
                    low_kept += 1
                level_hist[level] += 1
                instr = to_instruction_row(feat, norm)
                if (hash(sid + key) % 10) == 0:
                    vf.write(json.dumps(instr) + "\n")
                    n_val += 1
                else:
                    tf.write(json.dumps(instr) + "\n")
                    n_train += 1

    print(f"[loc] tabular rows: {rows:,} -> {demand_path}", file=sys.stderr)
    print(f"[loc] instruction train/val: {n_train:,}/{n_val:,}", file=sys.stderr)
    print(f"[loc] level distribution (instruction): {dict(level_hist)}", file=sys.stderr)


if __name__ == "__main__":
    main()
