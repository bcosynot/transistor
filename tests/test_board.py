from __future__ import annotations

from transistor.board import build_board, minutes_away
from transistor.config import Config, Feed, Watch
from transistor.gtfs import Departure

# Fictional placeholders — the public test-suite carries no real stop ids.
PLATFORM_S = "ZZ01S"
BUS_SIDE_A = "990001"

WATCHES = (
    Watch("A", "subway", "subway", PLATFORM_S, "Example Av", "Downtown"),
    Watch("B", "subway", "subway", PLATFORM_S, "Example Av", "Downtown"),
    Watch("C9", "bus", "bus", BUS_SIDE_A, "Example Rd/1 St", "City Centre"),
    Watch("D4", "bus", "bus", BUS_SIDE_A, "Example Rd/1 St", "City Centre"),
)


def make_cfg(top_n: int = 2) -> Config:
    return Config(
        mqtt_host="broker",
        feeds=(Feed("subway", "http://x", 30), Feed("bus", "http://y", 60)),
        watches=WATCHES,
        top_n=top_n,
        timezone="America/New_York",
    )


def dep(line, stop, epoch):
    return Departure(line=line, stop_id=stop, epoch=int(epoch), trip_id=f"{line}-{epoch}")


def test_minutes_are_rounded_and_never_negative():
    now = 1000.0
    assert minutes_away(int(now + 30), now) == 1     # 0.5 min rounds up
    assert minutes_away(int(now + 89), now) == 1
    assert minutes_away(int(now + 150), now) == 3    # 2.5 min rounds up
    assert minutes_away(int(now - 600), now) == 0    # never negative


def test_only_watched_route_and_stop_are_used(now):
    board = build_board(
        make_cfg(),
        {
            "subway": [
                dep("A", PLATFORM_S, now + 120),
                dep("A", "ZZ01N", now + 150),   # opposite direction
                dep("Z", PLATFORM_S, now + 180),  # unwatched route
            ],
            "bus": [],
        },
        {"subway": {"stale": False}, "bus": {"stale": False}},
        now=now,
    )
    by_line = {entry["line"]: entry for entry in board["lines"]}
    assert len(by_line["A"]["deps"]) == 1
    assert by_line["A"]["deps"][0]["min"] == 2
    assert by_line["C9"]["deps"] == []


def test_top_n_limits_the_list(now):
    board = build_board(
        make_cfg(top_n=2),
        {"subway": [dep("A", PLATFORM_S, now + t) for t in (60, 120, 180, 240)], "bus": []},
        {"subway": {"stale": False}, "bus": {"stale": False}},
        now=now,
    )
    deps = next(e for e in board["lines"] if e["line"] == "A")["deps"]
    assert [d["min"] for d in deps] == [1, 2]


def test_line_with_no_service_still_appears(now):
    """A route that does not run at weekends must still render its row."""
    board = build_board(
        make_cfg(),
        {"subway": [], "bus": []},
        {"subway": {"stale": False}, "bus": {"stale": False}},
        now=now,
    )
    b = next(e for e in board["lines"] if e["line"] == "B")
    assert b["deps"] == []
    assert "B —" in board["summary"]


def test_stale_propagates_from_any_feed(now):
    board = build_board(
        make_cfg(),
        {"subway": [], "bus": []},
        {"subway": {"stale": True}, "bus": {"stale": False}},
        now=now,
    )
    assert board["stale"] is True


def test_no_feed_status_is_treated_as_stale(now):
    """Before the first poll completes there is no data, so the board is stale."""
    board = build_board(make_cfg(), {}, {}, now=now)
    assert board["stale"] is True


def test_summary_shape(now):
    board = build_board(
        make_cfg(),
        {
            "subway": [dep("A", PLATFORM_S, now + 180), dep("A", PLATFORM_S, now + 540)],
            "bus": [dep("C9", BUS_SIDE_A, now + 240)],
        },
        {"subway": {"stale": False}, "bus": {"stale": False}},
        now=now,
    )
    assert board["summary"] == "A 3/9 · B — · C9 4 · D4 —"


def test_summary_keeps_only_the_first_two_minutes(now):
    """The state string stays a short glance even though the payload carries
    every departure the line's top_n allows."""
    board = build_board(
        make_cfg(top_n=5),
        {"subway": [dep("A", PLATFORM_S, now + t) for t in (300, 600, 900, 1200, 1500)], "bus": []},
        {"subway": {"stale": False}, "bus": {"stale": False}},
        now=now,
    )
    a = next(e for e in board["lines"] if e["line"] == "A")
    assert [d["min"] for d in a["deps"]] == [5, 10, 15, 20, 25]
    assert board["summary"].startswith("A 5/10 · ")


def test_times_are_rendered_in_configured_timezone(now):
    board = build_board(
        make_cfg(),
        {"subway": [dep("A", PLATFORM_S, now)], "bus": []},
        {"subway": {"stale": False}, "bus": {"stale": False}},
        now=now,
    )
    # 1700000000 == 2023-11-14 22:13:20 UTC == 17:13 EST
    a = next(e for e in board["lines"] if e["line"] == "A")
    assert a["deps"][0]["at"] == "5:13pm"


def test_lines_are_ordered_as_configured(now):
    board = build_board(
        make_cfg(),
        {},
        {"subway": {"stale": False}, "bus": {"stale": False}},
        now=now,
    )
    assert [e["line"] for e in board["lines"]] == ["A", "B", "C9", "D4"]
