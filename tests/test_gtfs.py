from __future__ import annotations

from transistor.config import Watch
from transistor.gtfs import extract_departures

from conftest import build_feed

# Fictional ids throughout — see conftest.
PLATFORM_S = "ZZ01S"
PLATFORM_N = "ZZ01N"
BUS_SIDE_A = "990001"
BUS_SIDE_B = "990002"


def _watch(line: str, stop_id: str, mode: str = "subway") -> Watch:
    return Watch(
        line=line,
        mode=mode,
        feed=mode,
        stop_id=stop_id,
        stop_name="test",
        direction="test",
    )


WATCHES = [
    _watch("A", PLATFORM_S),
    _watch("B", PLATFORM_S),
    _watch("C9", BUS_SIDE_A, mode="bus"),
]


def test_matches_route_and_platform_together(now):
    feed = build_feed(
        [
            ("A", PLATFORM_S, now + 120, "t1"),   # wanted
            ("A", PLATFORM_N, now + 180, "t2"),   # wrong platform (opposite direction)
            ("Z", PLATFORM_S, now + 240, "t3"),   # wrong route
            ("B", PLATFORM_S, now + 300, "t4"),   # wanted
            ("C9", BUS_SIDE_A, now + 360, "t5"),  # wanted
            ("C9", BUS_SIDE_B, now + 400, "t6"),  # wrong side of the street
        ]
    )
    got = extract_departures(feed, WATCHES, now=now)
    assert [(d.line, d.stop_id) for d in got] == [
        ("A", PLATFORM_S),
        ("B", PLATFORM_S),
        ("C9", BUS_SIDE_A),
    ]


def test_sorted_by_time(now):
    feed = build_feed(
        [
            ("A", PLATFORM_S, now + 900, "late"),
            ("A", PLATFORM_S, now + 60, "soon"),
            ("A", PLATFORM_S, now + 300, "mid"),
        ]
    )
    got = extract_departures(feed, WATCHES, now=now)
    assert [d.trip_id for d in got] == ["soon", "mid", "late"]


def test_drops_stale_and_distant_predictions(now):
    feed = build_feed(
        [
            ("A", PLATFORM_S, now - 300, "long_gone"),   # well past the grace window
            ("A", PLATFORM_S, now - 10, "just_left"),    # still within grace
            ("A", PLATFORM_S, now + 7200, "too_far"),    # beyond the horizon
        ]
    )
    got = extract_departures(feed, WATCHES, now=now)
    assert [d.trip_id for d in got] == ["just_left"]


def test_duplicate_predictions_collapse(now):
    feed = build_feed(
        [
            ("A", PLATFORM_S, now + 120, "t1"),
            ("A", PLATFORM_S, now + 120, "t1"),
        ]
    )
    got = extract_departures(feed, WATCHES, now=now)
    assert len(got) == 1


def test_ignores_entities_without_trip_update(now):
    feed = build_feed([("A", PLATFORM_S, now + 60, "t1")])
    veh = feed.entity.add()
    veh.id = "vehicle"
    veh.vehicle.trip.route_id = "A"
    got = extract_departures(feed, WATCHES, now=now)
    assert len(got) == 1


def test_departure_falls_back_to_departure_time(now):
    """Some feeds populate departure.time but not arrival.time."""
    feed = build_feed([("A", PLATFORM_S, now + 120, "t1")])
    stu = feed.entity[0].trip_update.stop_time_update[0]
    stu.ClearField("arrival")
    stu.departure.time = int(now + 120)
    got = extract_departures(feed, WATCHES, now=now)
    assert [d.trip_id for d in got] == ["t1"]
    assert got[0].epoch == int(now + 120)


def test_no_watches_yields_nothing(now):
    feed = build_feed([("A", PLATFORM_S, now + 60, "t1")])
    assert extract_departures(feed, [], now=now) == []
