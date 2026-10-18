"""Runtime configuration, read from the environment.

The NixOS module renders structured options into these variables, so every
knob is settable from Nix without editing Python.

There are deliberately **no defaults for feeds or watches**: which lines and
which platform you stand on is site-specific, and baking one in would publish
the deployment location in this repository. Both are required.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Feed:
    key: str
    url: str
    poll_interval: float
    kind: str = "gtfs-rt"


@dataclass(frozen=True)
class Watch:
    line: str
    mode: str
    feed: str
    stop_id: str
    stop_name: str
    direction: str


@dataclass(frozen=True)
class Config:
    mqtt_host: str
    mqtt_port: int = 1883
    mqtt_username: str | None = None
    mqtt_password: str | None = None
    mqtt_prefix: str = "transistor"
    mqtt_tls: bool = False
    siri_api_key: str | None = None
    siri_max_visits: int = 10
    publish_interval: float = 15.0
    top_n: int = 2
    timezone: str = "UTC"
    feeds: tuple[Feed, ...] = ()
    watches: tuple[Watch, ...] = ()
    request_timeout: float = 20.0
    # A feed is reported stale once this many multiples of its poll interval
    # have elapsed without a successful fetch.
    stale_after_intervals: float = 3.0

    def watches_for(self, feed_key: str) -> tuple[Watch, ...]:
        return tuple(w for w in self.watches if w.feed == feed_key)


class ConfigError(RuntimeError):
    """Raised when required configuration is missing or malformed."""


# "gtfs-rt" — protobuf GTFS-Realtime feed (subway line groups, or the
#             system-wide bus feed).
# "siri"    — MTA Bus Time StopMonitoring, queried per stop, needs an API key.
FEED_KINDS = {"gtfs-rt", "siri"}


def _bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _read_secret(env: dict, credential: str, file_var: str, direct_var: str) -> str | None:
    """Prefer a systemd credential so a secret never reaches the Nix store."""
    cred_dir = env.get("CREDENTIALS_DIRECTORY")
    if cred_dir:
        path = os.path.join(cred_dir, credential)
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                return fh.read().strip()
    path = env.get(file_var)
    if path:
        with open(path, encoding="utf-8") as fh:
            return fh.read().strip()
    return env.get(direct_var) or None


def _read_password(env: dict) -> str | None:
    return _read_secret(
        env, "mqtt-password", "TRANSISTOR_MQTT_PASSWORD_FILE", "TRANSISTOR_MQTT_PASSWORD"
    )


def _read_siri_api_key(env: dict) -> str | None:
    return _read_secret(
        env,
        "siri-api-key",
        "TRANSISTOR_SIRI_API_KEY_FILE",
        "TRANSISTOR_SIRI_API_KEY",
    )


def _json_env(env: dict, name: str, default):
    raw = env.get(name)
    if not raw or not raw.strip():
        return default
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:  # pragma: no cover - operator error
        raise ConfigError(f"{name} is not valid JSON: {exc}") from exc


_WATCH_EXAMPLE = (
    'TRANSISTOR_WATCHES=\'[{"line":"L","mode":"subway","feed":"subway",'
    '"stopId":"ZZ01S","stopName":"Example Av","direction":"Downtown"}]\''
)
_FEED_EXAMPLE = (
    'TRANSISTOR_FEEDS=\'{"subway":{"url":"https://.../gtfs-xyz","pollInterval":30}}\''
)


def load_config(env: dict | None = None) -> Config:
    """Build a Config from the given mapping (defaults to os.environ)."""
    if env is None:
        env = dict(os.environ)

    host = env.get("TRANSISTOR_MQTT_HOST")
    if not host:
        raise ConfigError(
            "TRANSISTOR_MQTT_HOST is required (the MQTT broker address)"
        )

    raw_feeds = _json_env(env, "TRANSISTOR_FEEDS", None)
    if not raw_feeds:
        raise ConfigError(
            "TRANSISTOR_FEEDS is required — there is no default, so that a "
            f"deployment does not have to reveal its location. e.g. {_FEED_EXAMPLE}"
        )
    feeds = tuple(
        Feed(
            key=key,
            url=spec["url"],
            poll_interval=float(spec.get("pollInterval", 60)),
            kind=spec.get("kind", "gtfs-rt"),
        )
        for key, spec in raw_feeds.items()
    )
    for feed in feeds:
        if feed.kind not in FEED_KINDS:
            raise ConfigError(
                f"feed {feed.key!r} has unknown kind {feed.kind!r}; "
                f"expected one of {', '.join(sorted(FEED_KINDS))}"
            )

    raw_watches = _json_env(env, "TRANSISTOR_WATCHES", None)
    if not raw_watches:
        raise ConfigError(
            "TRANSISTOR_WATCHES is required — there is no default, so that a "
            f"deployment does not have to reveal its location. e.g. {_WATCH_EXAMPLE}"
        )
    watches = tuple(
        Watch(
            line=w["line"],
            mode=w.get("mode", "subway"),
            feed=w.get("feed", "subway"),
            stop_id=w["stopId"],
            stop_name=w.get("stopName", w["stopId"]),
            direction=w.get("direction", ""),
        )
        for w in raw_watches
    )

    known = {f.key for f in feeds}
    for w in watches:
        if w.feed not in known:
            raise ConfigError(
                f"watch for line {w.line} references unknown feed {w.feed!r}"
            )

    siri_api_key = _read_siri_api_key(env)
    siri_feeds = [f.key for f in feeds if f.kind == "siri"]
    if siri_feeds and not siri_api_key:
        raise ConfigError(
            "feed(s) "
            + ", ".join(map(repr, siri_feeds))
            + " use kind 'siri', which requires an MTA Bus Time API key (free, "
            "from https://register.developer.obanyc.com/). Supply it with "
            "TRANSISTOR_SIRI_API_KEY_FILE, TRANSISTOR_SIRI_API_KEY, or a "
            "systemd credential named siri-api-key."
        )

    return Config(
        mqtt_host=host,
        mqtt_port=int(env.get("TRANSISTOR_MQTT_PORT", "1883")),
        mqtt_username=env.get("TRANSISTOR_MQTT_USERNAME") or None,
        mqtt_password=_read_password(env),
        mqtt_prefix=env.get("TRANSISTOR_MQTT_PREFIX", "transistor"),
        mqtt_tls=_bool(env.get("TRANSISTOR_MQTT_TLS")),
        siri_api_key=siri_api_key,
        siri_max_visits=int(env.get("TRANSISTOR_SIRI_MAX_VISITS", "10")),
        publish_interval=float(env.get("TRANSISTOR_PUBLISH_INTERVAL", "15")),
        top_n=int(env.get("TRANSISTOR_TOP_N", "2")),
        timezone=env.get("TRANSISTOR_TIMEZONE", "UTC"),
        feeds=feeds,
        watches=watches,
        request_timeout=float(env.get("TRANSISTOR_REQUEST_TIMEOUT", "20")),
        stale_after_intervals=float(
            env.get("TRANSISTOR_STALE_AFTER_INTERVALS", "3")
        ),
    )
