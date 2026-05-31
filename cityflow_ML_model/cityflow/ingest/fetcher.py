"""
CityFlow — GTFS-RT fetcher.

Downloads the protobuf feed from TTC / GO and decodes it into a FeedMessage,
then hands it to the normalizer. THIS is the part that needs network access —
run it in your own environment / Claude Code, not in a sandbox.

    pip install gtfs-realtime-bindings requests
"""

from __future__ import annotations

import requests
from google.transit import gtfs_realtime_pb2

from . import gtfs_normalizer as norm
from .schema import CityEvent, Source
from ..config import feeds


def _fetch_feed_message(url: str, api_key: str = "") -> gtfs_realtime_pb2.FeedMessage:
    params, headers = {}, {}
    if api_key:
        if feeds.GO_KEY_MODE == "query":
            params[feeds.GO_KEY_PARAM] = api_key
        else:
            headers["Authorization"] = api_key
    resp = requests.get(url, params=params, headers=headers, timeout=15)
    resp.raise_for_status()
    msg = gtfs_realtime_pb2.FeedMessage()
    msg.ParseFromString(resp.content)
    return msg


def fetch_ttc() -> list[CityEvent]:
    out: list[CityEvent] = []
    if feeds.TTC["alerts_url"]:
        msg = _fetch_feed_message(feeds.TTC["alerts_url"], feeds.TTC["api_key"])
        out += norm.parse_alerts(msg, Source.TTC)
    if feeds.TTC["trip_updates_url"]:
        msg = _fetch_feed_message(feeds.TTC["trip_updates_url"], feeds.TTC["api_key"])
        out += norm.parse_trip_updates(msg, Source.TTC)
    return out


def fetch_go() -> list[CityEvent]:
    out: list[CityEvent] = []
    if feeds.GO["alerts_url"]:
        msg = _fetch_feed_message(feeds.GO["alerts_url"], feeds.GO["api_key"])
        out += norm.parse_alerts(msg, Source.GO)
    if feeds.GO["trip_updates_url"]:
        msg = _fetch_feed_message(feeds.GO["trip_updates_url"], feeds.GO["api_key"])
        out += norm.parse_trip_updates(msg, Source.GO)
    return out


def fetch_all() -> list[CityEvent]:
    """All transit events this cycle. Wrap failures so one dead feed doesn't
    kill the others — the orchestrator just sees fewer signals that tick."""
    events: list[CityEvent] = []
    for fn in (fetch_ttc, fetch_go):
        try:
            events += fn()
        except Exception as e:  # noqa: BLE001
            print(f"[ingest] {fn.__name__} failed: {e}")
    return events
