#!/usr/bin/env python3
"""
Backfill a REAL demand-forecasting training set for Toronto Monitor.

Joins two genuine, free sources into one supervised dataset:
  - LABEL:    Bike Share Toronto ridership (hourly trip counts) = city demand proxy
  - FEATURES: Open-Meteo historical hourly weather + calendar/holiday/time-of-day

Outputs (in data/):
  - demand-<year>.jsonl        one row per hour: features + demand label (tabular)
  - forecast-train.jsonl       instruction JSONL (signals -> forecast JSON) for the
                               Nemotron LoRA fine-tune; labels derived from REAL demand
  - forecast-val.jsonl         ~10% held-out split

Usage:
  python3 scripts/backfill_dataset.py \
      --csv /tmp/tomon/bikeshare-ridership-2024.csv --year 2024

The big CSV is streamed (never fully loaded), so it runs in modest memory.
"""
import argparse
import csv
import json
import math
import os
import sys
import urllib.request
from collections import defaultdict
from datetime import date, datetime

WMO = {
    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Rime fog", 51: "Light drizzle", 53: "Drizzle", 55: "Dense drizzle",
    61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain",
    71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
    80: "Rain showers", 81: "Rain showers", 82: "Violent rain showers",
    85: "Snow showers", 86: "Heavy snow showers",
    95: "Thunderstorm", 96: "Thunderstorm w/ hail", 99: "Thunderstorm w/ hail",
}

# Ontario statutory + bank holidays (2023-2026) — affects commute vs leisure demand.
HOLIDAYS = {
    # 2024
    "2024-01-01", "2024-02-19", "2024-03-29", "2024-05-20", "2024-07-01",
    "2024-08-05", "2024-09-02", "2024-10-14", "2024-12-25", "2024-12-26",
    # 2023
    "2023-01-01", "2023-02-20", "2023-04-07", "2023-05-22", "2023-07-01",
    "2023-08-07", "2023-09-04", "2023-10-09", "2023-12-25", "2023-12-26",
    # 2025
    "2025-01-01", "2025-02-17", "2025-04-18", "2025-05-19", "2025-07-01",
    "2025-08-04", "2025-09-01", "2025-10-13", "2025-12-25", "2025-12-26",
}

DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def season(month):
    if month in (12, 1, 2):
        return "winter"
    if month in (3, 4, 5):
        return "spring"
    if month in (6, 7, 8):
        return "summer"
    return "fall"


def count_trips(csv_path):
    """Stream the ridership CSV -> hourly counts keyed 'YYYY-MM-DD HH'."""
    total = defaultdict(int)
    casual = defaultdict(int)
    member = defaultdict(int)
    n = 0
    with open(csv_path, newline="", encoding="utf-8", errors="replace") as f:
        reader = csv.DictReader(f)
        for row in reader:
            st = row.get("Start_Time") or row.get("Start Time") or ""
            if len(st) < 13:
                continue
            key = st[:13]  # "YYYY-MM-DD HH"
            total[key] += 1
            ut = (row.get("User_Type") or row.get("user_type") or "").strip().lower()
            if ut == "casual":
                casual[key] += 1
            elif ut == "member":
                member[key] += 1
            n += 1
            if n % 1_000_000 == 0:
                print(f"  ...{n:,} trips streamed", file=sys.stderr)
    print(f"  done: {n:,} trips across {len(total):,} hour-buckets", file=sys.stderr)
    return total, casual, member


def fetch_weather(year):
    """Open-Meteo historical archive: hourly weather for the whole year, one call."""
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
    for i, t in enumerate(h["time"]):  # t = "YYYY-MM-DDTHH:MM"
        key = t[:10] + " " + t[11:13]
        out[key] = {
            "temperatureC": _round(h["temperature_2m"][i]),
            "precipMm": h["precipitation"][i] or 0.0,
            "windKph": _round(h["wind_speed_10m"][i]),
            "code": int(h["weather_code"][i] or 0),
        }
    print(f"  weather: {len(out):,} hourly records", file=sys.stderr)
    return out


def _round(x):
    return round(x) if x is not None else None


def meal_window(hour):
    if 11 <= hour <= 14:
        return "lunch"
    if 17 <= hour <= 20:
        return "dinner"
    if 7 <= hour <= 10:
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


def build_drivers(feat, demand_norm):
    drivers = []
    h = feat["localHour"]
    mw = meal_window(h)
    if mw == "lunch":
        drivers.append({"signal": "Lunch rush", "impact": "up", "detail": "Midday demand window."})
    elif mw == "dinner":
        drivers.append({"signal": "Dinner rush", "impact": "up", "detail": "Evening demand window."})
    elif mw == "morning":
        drivers.append({"signal": "Morning commute", "impact": "up", "detail": "AM commute window."})
    elif h <= 5:
        drivers.append({"signal": "Overnight lull", "impact": "down", "detail": "Low ambient demand."})
    if feat["isWeekend"]:
        drivers.append({"signal": "Weekend", "impact": "up", "detail": "Higher discretionary trips."})
    if feat["isHoliday"]:
        drivers.append({"signal": "Holiday", "impact": "up", "detail": "Leisure-pattern demand."})
    w = feat["weather"]
    if w["precipMm"] >= 0.5:
        drivers.append({"signal": "Wet weather", "impact": "down", "detail": f"{w['description']} suppresses trips."})
    if w["temperatureC"] is not None and w["temperatureC"] <= -5:
        drivers.append({"signal": "Cold", "impact": "down", "detail": f"{w['temperatureC']}°C dampens movement."})
    if feat["season"] == "summer":
        drivers.append({"signal": "Summer", "impact": "up", "detail": "Peak cycling season."})
    elif feat["season"] == "winter":
        drivers.append({"signal": "Winter", "impact": "down", "detail": "Off-season demand."})
    return drivers[:5]


SYSTEM = (
    "You are a Toronto demand-forecasting model for small businesses. "
    "Given live civic signals, output ONLY a JSON demand forecast for the next ~12 hours."
)


def to_instruction_row(feat, demand_norm):
    level = level_from_norm(demand_norm)
    drivers = build_drivers(feat, demand_norm)
    top = drivers[0]["signal"].lower() if drivers else "current conditions"
    headline = {
        "surge": f"Surge demand — driven by {top}.",
        "elevated": f"Elevated demand building — {top} in play.",
        "moderate": "Steady, moderate demand.",
        "low": "Quiet stretch — demand running low.",
    }[level]
    signals = {
        "localHour": feat["localHour"],
        "dayOfWeek": feat["dayOfWeek"],
        "isWeekend": feat["isWeekend"],
        "isHoliday": feat["isHoliday"],
        "season": feat["season"],
        "weather": feat["weather"],
    }
    user = (
        "Reason over the live signals below and forecast customer demand for the next ~12 hours.\n\n"
        "SIGNALS (JSON):\n" + json.dumps(signals, separators=(",", ":"))
    )
    forecast = {
        "score": round(demand_norm, 2),
        "level": level,
        "headline": headline,
        "drivers": drivers,
        "windows": [],
        "actions": [],
    }
    return {
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": user},
            {"role": "assistant", "content": json.dumps(forecast, separators=(",", ":"))},
        ]
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True, help="path to bikeshare-ridership-<year>.csv")
    ap.add_argument("--year", type=int, required=True)
    ap.add_argument("--outdir", default="data")
    args = ap.parse_args()

    os.makedirs(args.outdir, exist_ok=True)
    print(f"[backfill] counting trips from {args.csv}", file=sys.stderr)
    total, casual, member = count_trips(args.csv)
    weather = fetch_weather(args.year)

    # Robust normalization: scale demand by the 95th percentile of hourly counts.
    counts_sorted = sorted(total.values())
    if not counts_sorted:
        print("No trips parsed — aborting.", file=sys.stderr)
        sys.exit(1)
    p95 = counts_sorted[int(len(counts_sorted) * 0.95)]
    print(f"  hourly demand p95 = {p95}", file=sys.stderr)

    demand_path = os.path.join(args.outdir, f"demand-{args.year}.jsonl")
    train_path = os.path.join(args.outdir, "forecast-train.jsonl")
    val_path = os.path.join(args.outdir, "forecast-val.jsonl")

    rows = 0
    n_train = 0
    n_val = 0
    with open(demand_path, "w") as df, open(train_path, "w") as tf, open(val_path, "w") as vf:
        for key in sorted(total.keys()):
            w = weather.get(key)
            if not w:
                continue  # need weather to form a feature row
            try:
                dt = datetime.strptime(key, "%Y-%m-%d %H")
            except ValueError:
                continue
            day_str = key[:10]
            dow_i = dt.weekday()
            trips = total[key]
            demand_norm = min(1.0, trips / p95) if p95 else 0.0
            feat = {
                "datetime": key,
                "localHour": dt.hour,
                "dayOfWeek": DOW[dow_i],
                "isWeekend": dow_i >= 5,
                "isHoliday": day_str in HOLIDAYS,
                "month": dt.month,
                "season": season(dt.month),
                "weather": {
                    "temperatureC": w["temperatureC"],
                    "precipMm": w["precipMm"],
                    "windKph": w["windKph"],
                    "weatherCode": w["code"],
                    "description": WMO.get(w["code"], "Unknown"),
                },
            }
            # Tabular row (features + real label)
            tabular = dict(feat)
            tabular["demand"] = trips
            tabular["demandCasual"] = casual.get(key, 0)
            tabular["demandMember"] = member.get(key, 0)
            tabular["demandNorm"] = round(demand_norm, 4)
            df.write(json.dumps(tabular, separators=(",", ":")) + "\n")

            # Instruction row (LLM fine-tune), 90/10 split by hash of the key
            instr = to_instruction_row(feat, demand_norm)
            if (hash(key) % 10) == 0:
                vf.write(json.dumps(instr) + "\n")
                n_val += 1
            else:
                tf.write(json.dumps(instr) + "\n")
                n_train += 1
            rows += 1

    print(f"[backfill] wrote {rows:,} hourly rows", file=sys.stderr)
    print(f"  - {demand_path}  (tabular features+label)", file=sys.stderr)
    print(f"  - {train_path}   ({n_train:,} instruction examples)", file=sys.stderr)
    print(f"  - {val_path}     ({n_val:,} held-out examples)", file=sys.stderr)


if __name__ == "__main__":
    main()
