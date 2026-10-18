"""GTFS-Realtime fetching and departure extraction.

Any GTFS-Realtime protobuf feed works; the MTA's subway line-group feeds need
no API key. The old datamine.mta.info / api-endpoints.mta.info hostnames no
longer resolve.

For buses, prefer the SIRI StopMonitoring source (`siri.py`): it answers per
stop in a few KB, where the system-wide bus GTFS-RT feed is ~1.8 MB per poll.
"""

from __future__ import annotations

import gzip
import logging
import time
import urllib.request
from typing import Iterable

from google.transit import gtfs_realtime_pb2

# Re-exported so callers can keep importing the departure model from here.
from .departures import (  # noqa: F401
    GRACE_SECONDS,
    HORIZON_SECONDS,
    Departure,
    Watched,
    apply_window,
)

log = logging.getLogger("transistor.gtfs")


def fetch(url: str, timeout: float = 20.0, user_agent: str = "transistor/0.1") -> bytes:
    """GET a feed, transparently handling a gzip Content-Encoding."""
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": user_agent,
            # The system-wide bus feed is ~1.8 MB uncompressed; asking for gzip
            # cuts that roughly 5-8x on the wire.
            "Accept-Encoding": "gzip",
            "Accept": "application/x-protobuf, application/octet-stream, */*",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        if resp.headers.get("Content-Encoding", "").lower() == "gzip":
            raw = gzip.decompress(raw)
        return raw


def parse(payload: bytes) -> gtfs_realtime_pb2.FeedMessage:
    msg = gtfs_realtime_pb2.FeedMessage()
    msg.ParseFromString(payload)
    return msg


def extract_departures(
    msg: gtfs_realtime_pb2.FeedMessage,
    watches: Iterable[Watched],
    now: float | None = None,
    grace: int = GRACE_SECONDS,
    horizon: int = HORIZON_SECONDS,
) -> list[Departure]:
    """Pull upcoming stop_time_updates matching the given watches.

    A trip carries the route id and each stop_time_update carries a
    directional stop id (subway platforms differ per direction; bus stops
    differ per direction *and* side of the street). Matching on both keeps the
    two directions of a line apart — see `departures.apply_window`.
    """
    if now is None:
        now = time.time()

    wanted = {(w.line, w.stop_id) for w in watches}
    routes = {line for line, _ in wanted}

    raw: list[Departure] = []
    for entity in msg.entity:
        if not entity.HasField("trip_update"):
            continue
        trip_update = entity.trip_update
        route = trip_update.trip.route_id
        if route not in routes:
            continue
        for stu in trip_update.stop_time_update:
            # Route *and* directional stop id must both match.
            if (route, stu.stop_id) not in wanted:
                continue
            when = stu.arrival.time or stu.departure.time
            if not when:
                continue
            raw.append(
                Departure(
                    line=route,
                    stop_id=stu.stop_id,
                    epoch=int(when),
                    trip_id=trip_update.trip.trip_id,
                )
            )

    return apply_window(raw, watches, now, grace, horizon)
