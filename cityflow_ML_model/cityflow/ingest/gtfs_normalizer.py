"""
CityFlow — GTFS-Realtime normalizer (TTC + GO).

Turns a GTFS-RT FeedMessage (protobuf) into a list of CityEvent. Both TTC and
GO publish GTFS-RT v2.0, so the SAME logic handles both; only the source tag
and the endpoint differ.

Two feed types matter for the orchestrator:
  - service_alerts  -> EventType.SERVICE_ALERT  (route suspended, station closed)
  - trip_updates    -> EventType.DELAY          (quantified lateness in minutes)

Severity normalization (0-100) maps GTFS's coarse `effect` enum and delay
magnitude onto one scale the materiality gate can threshold.

Requires:  pip install gtfs-realtime-bindings requests
The parse_* functions take already-decoded protobuf objects, so they are unit-
testable WITHOUT a network (see sample_feed.py).
"""

from __future__ import annotations

from typing import Iterable

from .schema import CityEvent, Source, EventType, Status

# GTFS-RT Alert.Effect enum -> normalized severity. Higher = more disruptive.
# Values mirror transit_realtime.Alert.Effect.
_EFFECT_SEVERITY = {
    "NO_SERVICE": 95,
    "REDUCED_SERVICE": 70,
    "SIGNIFICANT_DELAYS": 75,
    "DETOUR": 60,
    "MODIFIED_SERVICE": 55,
    "STOP_MOVED": 45,
    "ADDITIONAL_SERVICE": 20,
    "OTHER_EFFECT": 30,
    "UNKNOWN_EFFECT": 25,
    "NO_EFFECT": 5,
    "ACCESSIBILITY_ISSUE": 40,
}


def _translated(field) -> str:
    """Pull an English (or first available) string from a GTFS TranslatedString."""
    if field is None:
        return ""
    translations = getattr(field, "translation", [])
    if not translations:
        return ""
    for t in translations:
        if getattr(t, "language", "").lower().startswith("en"):
            return t.text
    return translations[0].text


def _delay_to_severity(delay_seconds: int) -> int:
    """Map a lateness in seconds onto 0-100. ~30+ min late is effectively max."""
    minutes = abs(delay_seconds) / 60.0
    if minutes <= 2:
        return 10
    if minutes <= 5:
        return 30
    if minutes <= 10:
        return 50
    if minutes <= 20:
        return 70
    return 85


def parse_alerts(feed_message, source: Source) -> list[CityEvent]:
    """FeedMessage (with alert entities) -> CityEvents."""
    events: list[CityEvent] = []
    for entity in feed_message.entity:
        if not entity.HasField("alert"):
            continue
        alert = entity.alert

        effect_name = _effect_name(alert.effect)
        severity = _EFFECT_SEVERITY.get(effect_name, 30)

        # Affected routes/stops live in informed_entity. The agents use these
        # to know WHAT is hit; we also stash them for the geo gate downstream.
        routes, stops = [], []
        for ie in alert.informed_entity:
            if ie.route_id:
                routes.append(ie.route_id)
            if ie.stop_id:
                stops.append(ie.stop_id)

        # validity window (first active_period, if any)
        eff_start = eff_end = None
        if alert.active_period:
            ap = alert.active_period[0]
            eff_start = ap.start or None
            eff_end = ap.end or None

        events.append(
            CityEvent(
                source=source,
                event_type=EventType.SERVICE_ALERT,
                title=_translated(alert.header_text) or f"{source.value.upper()} alert",
                description=_translated(alert.description_text),
                severity=severity,
                status=Status.ACTIVE,
                source_entity_id=entity.id,
                effective_start=eff_start,
                effective_end=eff_end,
                attributes={
                    "effect": effect_name,
                    "cause": _cause_name(alert.cause),
                    "routes": routes,
                    "stops": stops,
                },
            )
        )
    return events


def parse_trip_updates(feed_message, source: Source,
                       min_delay_minutes: int = 5) -> list[CityEvent]:
    """FeedMessage (with trip_update entities) -> DELAY CityEvents.

    Only emits events for trips delayed beyond `min_delay_minutes` — small
    schedule jitter is noise and should never reach the orchestrator.
    """
    events: list[CityEvent] = []
    threshold = min_delay_minutes * 60
    for entity in feed_message.entity:
        if not entity.HasField("trip_update"):
            continue
        tu = entity.trip_update
        route_id = tu.trip.route_id

        # worst delay across this trip's stop_time_updates
        worst = 0
        for stu in tu.stop_time_update:
            for fld in (stu.arrival, stu.departure):
                if fld and fld.HasField("delay"):
                    if abs(fld.delay) > abs(worst):
                        worst = fld.delay
        if abs(worst) < threshold:
            continue

        events.append(
            CityEvent(
                source=source,
                event_type=EventType.DELAY,
                title=f"{source.value.upper()} route {route_id} delayed "
                      f"{round(worst / 60)} min",
                severity=_delay_to_severity(worst),
                status=Status.ACTIVE,
                source_entity_id=entity.id,
                attributes={
                    "route": route_id,
                    "delay_minutes": round(worst / 60),
                    "trip_id": tu.trip.trip_id,
                },
            )
        )
    return events


# --- enum name helpers -------------------------------------------------------
# Done lazily so this module imports even if the bindings aren't installed yet
# (e.g. while reading the code). Real calls need the package present.

def _effect_name(effect_value) -> str:
    try:
        from google.transit import gtfs_realtime_pb2 as pb
        return pb.Alert.Effect.Name(effect_value)
    except Exception:
        return str(effect_value)


def _cause_name(cause_value) -> str:
    try:
        from google.transit import gtfs_realtime_pb2 as pb
        return pb.Alert.Cause.Name(cause_value)
    except Exception:
        return str(cause_value)
