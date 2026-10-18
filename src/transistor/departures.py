"""The departure record shared by every feed type, plus window filtering."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Protocol

# Ignore predictions already this far in the past — a bus that "left" 30 s ago
# is still worth showing while the board catches up.
GRACE_SECONDS = 45
# ...and never advertise anything beyond this horizon.
HORIZON_SECONDS = 60 * 60


class Watched(Protocol):
    """The subset of config.Watch that matching needs."""

    line: str
    stop_id: str


@dataclass(frozen=True)
class Departure:
    line: str
    stop_id: str
    epoch: int
    trip_id: str


def apply_window(
    departures: Iterable[Departure],
    watches: Iterable[Watched],
    now: float,
    grace: int = GRACE_SECONDS,
    horizon: int = HORIZON_SECONDS,
) -> list[Departure]:
    """Keep only the departures a watch asked for, inside the time window.

    A watch matches only when *both* the route and the stop id line up, which
    keeps the two directions of a line from being mixed together.
    """
    wanted = {(w.line, w.stop_id) for w in watches}
    out: list[Departure] = []
    seen: set[tuple[str, str, int]] = set()

    for departure in departures:
        if (departure.line, departure.stop_id) not in wanted:
            continue
        delta = departure.epoch - now
        if delta < -grace or delta > horizon:
            continue
        key = (departure.line, departure.stop_id, departure.epoch)
        if key in seen:
            continue
        seen.add(key)
        out.append(departure)

    out.sort(key=lambda d: d.epoch)
    return out
