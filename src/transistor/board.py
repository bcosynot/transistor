"""Turn raw departures into the JSON document published to MQTT."""

from __future__ import annotations

import datetime as dt
import time
from zoneinfo import ZoneInfo

from .config import Config, Watch
from .gtfs import Departure


def _fmt_time(epoch: int, tz: ZoneInfo) -> str:
    return dt.datetime.fromtimestamp(epoch, tz).strftime("%-I:%M%p").lower()


def minutes_away(epoch: int, now: float) -> int:
    """Minutes until departure, half-up rounded and never negative.

    Rounding (rather than flooring) keeps '4 min' meaning "about four", which
    reads better on a kiosk than a value that sits at 3 for a full minute.
    Half-up rather than Python's default banker's rounding so the result is
    stable and predictable: 30 s reads as 1 min, not 0.
    """
    return max(0, int((epoch - now + 30) // 60))


def build_line(
    watch: Watch, departures: list[Departure], now: float, tz: ZoneInfo, top_n: int
) -> dict:
    mine = [d for d in departures if d.line == watch.line and d.stop_id == watch.stop_id]
    mine.sort(key=lambda d: d.epoch)
    deps = [
        {
            "min": minutes_away(d.epoch, now),
            "at": _fmt_time(d.epoch, tz),
            "epoch": d.epoch,
        }
        for d in mine[:top_n]
    ]
    return {
        "line": watch.line,
        "mode": watch.mode,
        "stop": watch.stop_name,
        "direction": watch.direction,
        "deps": deps,
    }


def build_board(
    cfg: Config,
    departures: dict[str, list[Departure]],
    feed_status: dict[str, dict],
    now: float | None = None,
) -> dict:
    """Assemble the full payload. Safe to call between polls: minute values
    are recomputed from the stored absolute times, so they tick down even when
    no new feed data has arrived."""
    if now is None:
        now = time.time()
    tz = ZoneInfo(cfg.timezone)

    lines = [
        build_line(w, departures.get(w.feed, []), now, tz, cfg.top_n)
        for w in cfg.watches
    ]

    stale = any(s.get("stale") for s in feed_status.values()) or not feed_status

    parts = []
    for entry in lines:
        mins = "/".join(str(d["min"]) for d in entry["deps"]) or "—"
        parts.append(f"{entry['line']} {mins}")

    return {
        "generated": dt.datetime.fromtimestamp(now, tz).isoformat(timespec="seconds"),
        "generated_ts": int(now),
        "stale": bool(stale),
        "summary": " · ".join(parts),
        "lines": lines,
        "feeds": feed_status,
    }
