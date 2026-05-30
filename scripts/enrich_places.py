#!/usr/bin/env python3
"""
Enrich Bike Share stations with REAL "commercial gravity" features from the
Google Places API (New). For each station we pull the most popular nearby
places within ~300 m and distill them into model features:

  placesCount     business density (capped at 20 = one Places page; flagged)
  avgRating       mean Google rating of nearby places
  totalReviews    sum of review counts (popularity proxy)
  foodCount       restaurants / cafes / bars nearby
  retailCount     shops / stores nearby
  nightlifeCount  bars / clubs nearby
  priceLevel      mean price level 1..4 (None if unknown)
  commercialGravity  0..1 blended density+popularity score

Results are cached to data/places-cache.json keyed by station_id and the run
is RESUMABLE — re-running only fills missing stations. Real data, requires
GOOGLE_PLACES_API_KEY (loaded from .env).

Usage:
  python3 scripts/enrich_places.py --limit 250          # top-N stations by capacity
  python3 scripts/enrich_places.py --select data/top-stations.json
"""
import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error

ENDPOINT = "https://places.googleapis.com/v1/places:searchNearby"
RADIUS_M = 300.0
FIELD_MASK = "places.types,places.rating,places.userRatingCount,places.priceLevel,places.primaryType"

FOOD = {"restaurant", "cafe", "coffee_shop", "bakery", "meal_takeaway", "meal_delivery", "food"}
NIGHTLIFE = {"bar", "night_club", "pub", "liquor_store"}
RETAIL = {"store", "clothing_store", "shopping_mall", "convenience_store", "supermarket",
          "grocery_store", "department_store", "book_store", "electronics_store"}
PRICE = {"PRICE_LEVEL_INEXPENSIVE": 1, "PRICE_LEVEL_MODERATE": 2,
         "PRICE_LEVEL_EXPENSIVE": 3, "PRICE_LEVEL_VERY_EXPENSIVE": 4}


def load_env_key():
    # Prefer process env; else parse .env (gitignored).
    key = os.environ.get("GOOGLE_PLACES_API_KEY")
    if key:
        return key
    try:
        with open(".env") as f:
            for line in f:
                line = line.strip()
                if line.startswith("GOOGLE_PLACES_API_KEY="):
                    return line.split("=", 1)[1].strip()
    except FileNotFoundError:
        pass
    return None


def search_nearby(key, lat, lon):
    body = {
        "maxResultCount": 20,
        "rankPreference": "POPULARITY",
        "locationRestriction": {
            "circle": {"center": {"latitude": lat, "longitude": lon}, "radius": RADIUS_M}
        },
    }
    req = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(body).encode(),
        headers={
            "Content-Type": "application/json",
            "X-Goog-Api-Key": key,
            "X-Goog-FieldMask": FIELD_MASK,
        },
        method="POST",
    )
    # Retry with exponential backoff on 429 / transient 5xx.
    delay = 1.0
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 503) and attempt < 5:
                time.sleep(delay)
                delay = min(delay * 2, 30)
                continue
            raise



def distill(places):
    n = len(places)
    ratings = [p["rating"] for p in places if p.get("rating")]
    reviews = sum(p.get("userRatingCount", 0) for p in places)
    food = retail = nightlife = 0
    prices = []
    for p in places:
        types = set(p.get("types", []))
        if types & FOOD:
            food += 1
        if types & RETAIL:
            retail += 1
        if types & NIGHTLIFE:
            nightlife += 1
        pl = PRICE.get(p.get("priceLevel"))
        if pl:
            prices.append(pl)
    # Commercial gravity: density (cap 20) + log-scaled popularity, 0..1.
    import math
    density = min(n, 20) / 20.0
    pop = min(1.0, math.log10(reviews + 1) / 5.0)  # ~100k reviews -> 1.0
    gravity = round(0.5 * density + 0.5 * pop, 3)
    return {
        "placesCount": n,
        "capped": n >= 20,
        "avgRating": round(sum(ratings) / len(ratings), 2) if ratings else None,
        "totalReviews": reviews,
        "foodCount": food,
        "retailCount": retail,
        "nightlifeCount": nightlife,
        "priceLevel": round(sum(prices) / len(prices), 1) if prices else None,
        "commercialGravity": gravity,
        "source": "google-places-new",
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stations", default="data/stations.json")
    ap.add_argument("--cache", default="data/places-cache.json")
    ap.add_argument("--select", help="JSON array of station_ids to enrich")
    ap.add_argument("--limit", type=int, default=250, help="top-N by capacity if no --select")
    ap.add_argument("--sleep", type=float, default=0.2)
    args = ap.parse_args()

    key = load_env_key()
    if not key:
        print("[places] GOOGLE_PLACES_API_KEY not set — aborting.", file=sys.stderr)
        sys.exit(1)

    stations = json.load(open(args.stations))
    if args.select and os.path.exists(args.select):
        ids = [str(s) for s in json.load(open(args.select))]
    else:
        ids = sorted(stations.keys(),
                     key=lambda s: stations[s].get("capacity", 0), reverse=True)[: args.limit]

    cache = {}
    if os.path.exists(args.cache):
        cache = json.load(open(args.cache))
    todo = [s for s in ids if s in stations and s not in cache]
    print(f"[places] {len(todo)} stations to enrich ({len(cache)} cached)", file=sys.stderr)

    done = 0
    for sid in todo:
        st = stations[sid]
        if st.get("lat") is None or st.get("lon") is None:
            continue
        try:
            resp = search_nearby(key, st["lat"], st["lon"])
            cache[sid] = distill(resp.get("places", []))
            done += 1
        except Exception as e:  # noqa: BLE001
            print(f"  ! {sid} {st['name']}: {e}", file=sys.stderr)
            cache[sid] = {"error": str(e)}
        if done % 25 == 0 and done:
            json.dump(cache, open(args.cache, "w"), separators=(",", ":"))
            print(f"  ...{done}/{len(todo)} enriched", file=sys.stderr)
        time.sleep(args.sleep)

    json.dump(cache, open(args.cache, "w"), separators=(",", ":"))
    ok = sum(1 for v in cache.values() if "error" not in v)
    print(f"[places] cache now holds {ok} enriched stations -> {args.cache}", file=sys.stderr)


if __name__ == "__main__":
    main()
