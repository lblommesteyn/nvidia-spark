"""
CityFlow — normalized event schema.

Every data source (TTC, GO, weather, roads, events, 311 ...) is converted into
this one shape before anything downstream touches it. The orchestrator's gates
(materiality, novelty, relevance) all operate on CityEvent, so the rest of the
system never needs to know which agency or API a signal came from.

Design notes:
- `signal_id` is STABLE for a given real-world disruption. The novelty gate
  diffs the current set of signal_ids against the previous cycle, so this id
  must be the same across polls for the *same* alert. We derive it from the
  source + the source's own entity id, not from anything that changes per poll
  (like a timestamp).
- `severity` is a normalized 0-100 score so the materiality gate can apply one
  threshold table across heterogeneous sources.
- `lat`/`lon` may be None (e.g. a system-wide alert with no single location).
  The geographic gate treats None as "applies everywhere" rather than dropping.
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Optional


class Source(str, Enum):
    TTC = "ttc"
    GO = "go"
    WEATHER = "weather"
    ROAD = "road"
    EVENT = "event"
    BIKESHARE = "bikeshare"
    NOTICE = "notice"
    SR311 = "311"


class EventType(str, Enum):
    # transit
    SERVICE_ALERT = "service_alert"      # route/station disruption
    DELAY = "delay"                      # quantified lateness
    # other sources (here so the schema is the single source of truth)
    ROAD_CLOSURE = "road_closure"
    WEATHER_ALERT = "weather_alert"
    PLANNED_EVENT = "planned_event"
    SUPPLY_SIGNAL = "supply_signal"      # e.g. bikeshare availability
    NOTICE = "notice"


class Status(str, Enum):
    ACTIVE = "active"
    CLEARED = "cleared"


@dataclass
class CityEvent:
    source: Source
    event_type: EventType
    title: str
    description: str = ""
    severity: int = 0                    # 0-100, normalized
    status: Status = Status.ACTIVE
    lat: Optional[float] = None
    lon: Optional[float] = None
    # the source's own id for this entity (e.g. GTFS alert id). Used to build
    # a stable signal_id and to detect escalation across polls.
    source_entity_id: str = ""
    # free-form, source-specific extras the agents may want (route ids,
    # delay minutes, alert effect/cause, affected stops ...).
    attributes: dict = field(default_factory=dict)
    # epoch seconds. observed_at = when WE saw it; effective_* = the event's own
    # validity window if the source provides one.
    observed_at: float = field(default_factory=lambda: time.time())
    effective_start: Optional[float] = None
    effective_end: Optional[float] = None

    @property
    def signal_id(self) -> str:
        """Stable id for the same real-world disruption across polls."""
        basis = f"{self.source.value}:{self.source_entity_id or self.title}"
        return hashlib.sha1(basis.encode("utf-8")).hexdigest()[:16]

    def to_dict(self) -> dict:
        d = asdict(self)
        d["source"] = self.source.value
        d["event_type"] = self.event_type.value
        d["status"] = self.status.value
        d["signal_id"] = self.signal_id
        return d
