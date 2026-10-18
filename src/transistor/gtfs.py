"""GTFS-Realtime fetching and departure extraction.

Any GTFS-Realtime protobuf feed works; the MTA's subway line-group feeds and
the system-wide bus feed both need no API key. The old
datamine.mta.info / api-endpoints.mta.info hostnames no longer resolve.
"""

from __future__ import annotations

import gzip
import logging
import time
import urllib.request
from dataclasses import dataclass
from typing import Iterable, Protocol

from google.transit import gtfs_realtime_pb2

log = logging.getLogger("transistor.gtfs")

# Ignore predictions already this far in the past — a train that "left" 30 s
# ago is still worth showing while the board catches up.
GRACE_SECONDS = 45
# ...and never advertise anything beyond this horizon.
HORIZON_SECONDS = 60 * 60


class Watched(Protocol):
    """The subset of config.Watch that extraction needs."""

    line: str
    stop_id: str


@dataclass(frozen=True)
class Departure:
    line: str
    stop_id: str
    epoch: int
    trip_id: str


def fetch(url: str, timeout: float = 20.0, user_agent: str = "transistor/0.1") -> bytes:
    """GET a feed, transparently handling a gzip Content-Encoding."""
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": user_agent,
            # The bus feed is ~1.8 MB uncompressed; asking for gzip cuts that
            # roughly 5-8x on the wire.
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
    differ per direction *and* side of the street). A watch therefore matches
    only when *both* the route and the stop id line up, which keeps the two
    directions of a line from being mixed together.
    """
    if now is None:
        now = time.time()

    wanted = {(w.line, w.stop_id) for w in watches}
    routes = {line for line, _ in wanted}

    out: list[Departure] = []
    seen: set[tuple[str, str, int]] = set()

    for entity in msg.entity:
        if not entity.HasField("trip_update"):
            continue
        trip_update = entity.trip_update
        route = trip_update.trip.route_id
        if route not in routes:
            continue
        for stu in trip_update.stop_time_update:
            if (route, stu.stop_id) not in wanted:
                continue
            when = stu.arrival.time or stu.departure.time
            if not when:
                continue
            delta = when - now
            if delta < -grace or delta > horizon:
                continue
            key = (route, stu.stop_id, int(when))
            if key in seen:
                continue
            seen.add(key)
            out.append(
                Departure(
                    line=route,
                    stop_id=stu.stop_id,
                    epoch=int(when),
                    trip_id=trip_update.trip.trip_id,
                )
            )

    out.sort(key=lambda d: d.epoch)
    return out
