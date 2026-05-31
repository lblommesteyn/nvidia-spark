"""
Local demo of CityFlow normalization WITHOUT the gtfs-realtime-bindings package
(which needs network to install). It builds objects with the SAME attribute
shape the real protobuf FeedMessage exposes, then runs the actual parser
functions from gtfs_normalizer unchanged.

In your real environment you delete this file and call fetcher.fetch_all().
"""
import json
import types
from cityflow.ingest import gtfs_normalizer as norm
from cityflow.ingest.schema import Source


def _ns(**kw):
    return types.SimpleNamespace(**kw)


def _translated(text):
    # mimic TranslatedString: .translation -> list of {language, text}
    return _ns(translation=[_ns(language="en", text=text)])


# --- monkeypatch the two enum-name helpers so we don't need the pb module ----
norm._effect_name = lambda v: v          # we'll pass the name straight through
norm._cause_name = lambda v: v


# --- build an alerts FeedMessage-shaped object -------------------------------
def fake_alerts_feed():
    alert = _ns(
        effect="NO_SERVICE",
        cause="CONSTRUCTION",
        active_period=[_ns(start=1748520000, end=1748563200)],
        informed_entity=[_ns(route_id="504", stop_id="14041")],
        header_text=_translated("504 King: no service between Spadina and Jarvis"),
        description_text=_translated(
            "Track work. Shuttle buses operating. Expect delays through the evening."),
    )
    entity = _ns(id="ttc-alert-504-001",
                 alert=alert,
                 HasField=lambda f: f == "alert")
    return _ns(entity=[entity])


# --- build a trip_updates FeedMessage-shaped object --------------------------
def fake_trip_updates_feed():
    stu = _ns(
        stop_id="UN",
        arrival=_ns(delay=18 * 60, HasField=lambda f: f == "delay"),
        departure=_ns(HasField=lambda f: False),
    )
    tu = _ns(trip=_ns(route_id="LW", trip_id="LW-1422"),
             stop_time_update=[stu])
    entity = _ns(id="go-trip-LW-1422",
                 trip_update=tu,
                 HasField=lambda f: f == "trip_update")
    return _ns(entity=[entity])


if __name__ == "__main__":
    events = []
    events += norm.parse_alerts(fake_alerts_feed(), Source.TTC)
    events += norm.parse_trip_updates(fake_trip_updates_feed(), Source.GO)

    print(f"Normalized {len(events)} CityEvent(s):\n")
    for ev in events:
        print(json.dumps(ev.to_dict(), indent=2, default=str))
        print("-" * 60)
