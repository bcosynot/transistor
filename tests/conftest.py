"""Shared fixtures: synthetic GTFS-RT feeds.

All stop and route ids here are fictional placeholders (``ZZ01N``, ``990001``,
…) so that the public test-suite carries no deployment-specific location.
"""

from __future__ import annotations

import time

import pytest
from google.transit import gtfs_realtime_pb2


def build_feed(entries, header_ts: int | None = None) -> gtfs_realtime_pb2.FeedMessage:
    """entries: iterable of (route_id, stop_id, epoch, trip_id)."""
    msg = gtfs_realtime_pb2.FeedMessage()
    msg.header.gtfs_realtime_version = "2.0"
    msg.header.timestamp = int(header_ts if header_ts is not None else time.time())
    for i, (route, stop, epoch, trip) in enumerate(entries):
        entity = msg.entity.add()
        entity.id = f"e{i}"
        tu = entity.trip_update
        tu.trip.trip_id = trip
        tu.trip.route_id = route
        stu = tu.stop_time_update.add()
        stu.stop_id = stop
        stu.arrival.time = int(epoch)
    return msg


@pytest.fixture
def now() -> float:
    # Fixed clock so minute maths is deterministic.
    return 1_700_000_000.0
