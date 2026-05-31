# CityFlow — transit ingestion (TTC + GO)

Normalizes TTC and GO GTFS-Realtime feeds into a single `CityEvent` shape that
the orchestrator's gates operate on.

## Layout
- `ingest/schema.py`        — the `CityEvent` schema (one shape for every source)
- `ingest/gtfs_normalizer.py` — parses GTFS-RT alerts + trip updates -> CityEvents
- `ingest/fetcher.py`       — downloads + decodes the protobuf feeds (needs network)
- `ingest/sample_feed.py`   — synthetic protobuf feed for offline testing
- `config/feeds.py`         — endpoint URLs + GO API key (via env vars)
- `demo_normalize.py`       — runs the parser with no network / no bindings installed

## Run it for real
1. `pip install gtfs-realtime-bindings requests`
2. Register for a GO/Metrolinx API key, accept their Access & Use Agreement,
   and get your GTFS-RT endpoint URLs.
3. Set env vars:
       export TTC_GTFS_RT_ALERTS_URL="..."
       export TTC_GTFS_RT_TRIP_UPDATES_URL="..."
       export GO_GTFS_RT_ALERTS_URL="..."
       export GO_GTFS_RT_TRIP_UPDATES_URL="..."
       export GO_API_KEY="..."
4. `python -c "from cityflow.ingest.fetcher import fetch_all; print([e.to_dict() for e in fetch_all()])"`

## Test offline right now
       python demo_normalize.py
