"""
CityFlow — synthetic GTFS-RT sample.

Builds a real protobuf FeedMessage in memory (one service alert + one delayed
trip) so you can exercise the normalizer end-to-end with NO network. This is
exactly the shape TTC/GO return; swap fetcher.fetch_all() in once your keys
are set and nothing downstream changes.

    pip install gtfs-realtime-bindings
"""

from google.transit import gtfs_realtime_pb2 as pb


def sample_alerts_feed() -> pb.FeedMessage:
    msg = pb.FeedMessage()
    msg.header.gtfs_realtime_version = "2.0"
    msg.header.incrementality = pb.FeedHeader.FULL_DATASET
    msg.header.timestamp = 1748520000

    e = msg.entity.add()
    e.id = "ttc-alert-504-001"
    a = e.alert
    a.effect = pb.Alert.Effect.Value("NO_SERVICE")
    a.cause = pb.Alert.Cause.Value("CONSTRUCTION")
    ap = a.active_period.add()
    ap.start = 1748520000
    ap.end = 1748563200
    ie = a.informed_entity.add()
    ie.route_id = "504"
    ie.stop_id = "14041"
    a.header_text.translation.add(language="en",
        text="504 King: no service between Spadina and Jarvis")
    a.description_text.translation.add(language="en",
        text="Track work. Shuttle buses operating. Expect delays through the evening.")
    return msg


def sample_trip_updates_feed() -> pb.FeedMessage:
    msg = pb.FeedMessage()
    msg.header.gtfs_realtime_version = "2.0"
    msg.header.incrementality = pb.FeedHeader.FULL_DATASET
    msg.header.timestamp = 1748520000

    e = msg.entity.add()
    e.id = "go-trip-LW-1422"
    tu = e.trip_update
    tu.trip.route_id = "LW"          # Lakeshore West
    tu.trip.trip_id = "LW-1422"
    stu = tu.stop_time_update.add()
    stu.stop_id = "UN"               # Union
    stu.arrival.delay = 18 * 60      # 18 minutes late
    return msg
