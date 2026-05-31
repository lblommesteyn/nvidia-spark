"""
CityFlow — feed configuration.

Endpoint URLs and the GO/Metrolinx API key live here, NOT in the fetcher code.
Two reasons:
  1. GO Transit's GTFS-RT URL sits behind their developer portal. You register
     (free) at the Metrolinx / GO API portal, accept the Access & Use Agreement,
     and they give you an endpoint + key. Paste those in below.
  2. Config-driven sources are the clean pattern: adding a new feed is editing
     this dict, not the parser.

Set values via environment variables so you never commit a key:
    export GO_GTFS_RT_ALERTS_URL="https://..."
    export GO_API_KEY="..."
    export TTC_GTFS_RT_ALERTS_URL="https://..."
"""

import os

# TTC GTFS-Realtime (served via NextBus/UMO). No key required for the public
# GTFS-RT endpoints. Fill in the alerts + trip-updates URLs you're using.
TTC = {
    "alerts_url": os.environ.get("TTC_GTFS_RT_ALERTS_URL", ""),
    "trip_updates_url": os.environ.get("TTC_GTFS_RT_TRIP_UPDATES_URL", ""),
    "api_key": os.environ.get("TTC_API_KEY", ""),  # usually empty
}

# GO Transit / Metrolinx GTFS-Realtime. Requires registration + key.
GO = {
    "alerts_url": os.environ.get("GO_GTFS_RT_ALERTS_URL", ""),
    "trip_updates_url": os.environ.get("GO_GTFS_RT_TRIP_UPDATES_URL", ""),
    "api_key": os.environ.get("GO_API_KEY", ""),
}

# Polling cadence (seconds). Vehicle positions update every few seconds, but
# alerts and trip updates change far less often — polling alerts every 30-60s
# is plenty and keeps load on both their servers and your Spark low.
POLL_INTERVAL_SECONDS = int(os.environ.get("CITYFLOW_POLL_INTERVAL", "45"))

# How the GO key is passed. Some Metrolinx endpoints want it as a query param
# (?key=...), others as a header. Set whichever their portal documents.
GO_KEY_MODE = os.environ.get("GO_KEY_MODE", "query")  # "query" | "header"
GO_KEY_PARAM = os.environ.get("GO_KEY_PARAM", "key")
