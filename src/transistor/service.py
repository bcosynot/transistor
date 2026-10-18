"""Polling workers and the publish loop."""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field

from . import gtfs, siri
from .board import build_board
from .config import Config, Feed, Watch

log = logging.getLogger("transistor.service")


@dataclass
class FeedState:
    departures: list = field(default_factory=list)
    last_attempt: float | None = None
    last_success: float | None = None
    last_error: str | None = None


class Store:
    """Thread-safe cache of the latest departures per feed."""

    def __init__(self, cfg: Config) -> None:
        self._lock = threading.Lock()
        self._states = {f.key: FeedState() for f in cfg.feeds}
        self._interval = {f.key: f.poll_interval for f in cfg.feeds}
        self._stale_mult = cfg.stale_after_intervals

    def record_success(self, key: str, departures: list) -> None:
        now = time.time()
        with self._lock:
            state = self._states[key]
            state.departures = departures
            state.last_attempt = now
            state.last_success = now
            state.last_error = None

    def record_error(self, key: str, error: Exception) -> None:
        with self._lock:
            state = self._states[key]
            state.last_attempt = time.time()
            state.last_error = f"{type(error).__name__}: {error}"

    def snapshot(self, now: float) -> tuple[dict[str, list], dict[str, dict]]:
        with self._lock:
            departures = {k: list(s.departures) for k, s in self._states.items()}
            status = {}
            for key, state in self._states.items():
                if state.last_success is None:
                    age = None
                    stale = True
                else:
                    age = round(now - state.last_success, 1)
                    stale = age > self._interval[key] * self._stale_mult
                status[key] = {
                    "stale": stale,
                    "age": age,
                    "error": state.last_error,
                }
        return departures, status


class FeedWorker(threading.Thread):
    """Polls one GTFS-RT feed on its own cadence."""

    def __init__(self, cfg: Config, feed: Feed, watches: tuple[Watch, ...], store: Store):
        super().__init__(name=f"feed-{feed.key}", daemon=True)
        self.cfg = cfg
        self.feed = feed
        self.watches = watches
        self.store = store
        self._stop = threading.Event()

    def stop(self) -> None:
        self._stop.set()

    def poll_once(self) -> int:
        departures = self._poll_siri() if self.feed.kind == "siri" else self._poll_gtfs()
        self.store.record_success(self.feed.key, departures)
        return len(departures)

    def _poll_gtfs(self) -> list:
        raw = gtfs.fetch(self.feed.url, timeout=self.cfg.request_timeout)
        message = gtfs.parse(raw)
        return gtfs.extract_departures(message, self.watches)

    def _poll_siri(self) -> list:
        """One request per distinct stop — that is the shape of this API.

        Several lines can share a stop, so the responses are merged and then
        filtered through the same watch matching the GTFS-RT path uses.
        """
        api_key = self.cfg.siri_api_key
        if not api_key:
            raise RuntimeError("SIRI feed configured without an API key")

        collected: list = []
        for stop_id in sorted({w.stop_id for w in self.watches}):
            url = siri.build_url(
                self.feed.url, stop_id, api_key, self.cfg.siri_max_visits
            )
            log.debug("%s: monitoring stop %s", self.feed.key, stop_id)
            payload = siri.fetch_json(url, timeout=self.cfg.request_timeout)
            collected.extend(siri.parse_stop_monitoring(payload))
        return gtfs.apply_window(collected, self.watches, time.time())

    def run(self) -> None:
        while not self._stop.is_set():
            started = time.monotonic()
            try:
                count = self.poll_once()
                log.debug("%s: %d departures", self.feed.key, count)
            except Exception as exc:  # keep polling; a feed blip must not be fatal
                log.warning("%s: poll failed: %s", self.feed.key, exc)
                self.store.record_error(self.feed.key, exc)
            elapsed = time.monotonic() - started
            self._stop.wait(max(1.0, self.feed.poll_interval - elapsed))


class TransitService:
    def __init__(self, cfg: Config, publisher) -> None:
        self.cfg = cfg
        self.publisher = publisher
        self.store = Store(cfg)

    def run(self, max_cycles: int | None = None) -> None:
        workers = [
            FeedWorker(self.cfg, feed, self.cfg.watches_for(feed.key), self.store)
            for feed in self.cfg.feeds
        ]
        for worker in workers:
            worker.start()
        log.info(
            "transistor up: %d feeds, %d lines, publishing every %.0fs",
            len(workers),
            len(self.cfg.watches),
            self.cfg.publish_interval,
        )

        cycles = 0
        try:
            while max_cycles is None or cycles < max_cycles:
                now = time.time()
                departures, status = self.store.snapshot(now)
                board = build_board(self.cfg, departures, status, now)
                self.publisher.publish_board(board)
                cycles += 1
                time.sleep(self.cfg.publish_interval)
        except KeyboardInterrupt:  # pragma: no cover
            log.info("interrupted")
        finally:
            for worker in workers:
                worker.stop()

    def build_once(self) -> dict:
        """Fetch every feed once (synchronously) and return the board.

        Used by `transistor --once` for debugging without a broker.
        """
        for feed in self.cfg.feeds:
            worker = FeedWorker(self.cfg, feed, self.cfg.watches_for(feed.key), self.store)
            try:
                worker.poll_once()
            except Exception as exc:
                log.warning("%s: poll failed: %s", feed.key, exc)
                self.store.record_error(feed.key, exc)
        now = time.time()
        departures, status = self.store.snapshot(now)
        board = build_board(self.cfg, departures, status, now)
        self.publisher.publish_board(board)
        return board
