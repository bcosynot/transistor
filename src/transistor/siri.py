"""MTA Bus Time SIRI StopMonitoring client.

Unlike GTFS-Realtime, this endpoint is queried per *stop* and returns a small
JSON document (~7 KB for six visits) listing the buses due there. It is the
better bus source: the system-wide GTFS-RT feed is ~1.8 MB per poll.

    https://bustime-classic.mta.info/api/siri/stop-monitoring.json
        ?key=<API key>&version=2&OperatorRef=MTA&MonitoringRef=<stop id>

The API key is required and comes from https://register.developer.obanyc.com/.

MTA quirks this module exists to absorb — all confirmed against the live API:

  * Errors are returned as **HTTP 403 with a well-formed SIRI body** holding an
    ``ErrorCondition`` (under a ``VehicleMonitoringDelivery`` key, even for a
    stop-monitoring call). So the body must be read on HTTPError, and the
    status code alone is not the error signal.
  * Name-like fields are **array-wrapped** (``"PublishedLineName": ["C99"]``)
    while refs are plain strings (``"StopPointRef": "MTA_990001"``). Treating
    the former as a scalar yields the literal string ``"['C99']"``.
  * Refs carry the GTFS agency prefix, and it varies by operator: routes seen
    in the wild come back as ``MTABC_C99`` (MTA Bus Company), while MTA's own
    docs illustrate ``MTA NYCT_B63`` (New York City Transit).
  * ``ProgressStatus`` is array-wrapped too, and may be ``layover`` or
    ``prevTrip``, meaning the bus is still on an earlier trip and the times
    "wrap around" to the trip that will serve the stop. The prediction is still
    the best available, so it is used as-is.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .departures import Departure

log = logging.getLogger("transistor.siri")

# The hostname MTA documents. bustime.mta.info is an alias serving the same API.
DEFAULT_URL = "https://bustime-classic.mta.info/api/siri/stop-monitoring.json"

# Every stop currently has this operator/agency id, and populating it makes the
# call measurably faster (per MTA's docs).
OPERATOR_REF = "MTA"

# A stop can serve several routes; enough visits to fill top_n for each.
DEFAULT_MAX_VISITS = 10


def _unwrap(node: Any) -> Any:
    """SIRI JSON may render an element with attributes as {"value": x, ...}."""
    if isinstance(node, dict) and "value" in node:
        return node["value"]
    return node


def _scalar(node: Any) -> Any:
    """Collapse SIRI's single-element arrays and value-wrappers to a scalar."""
    value = _unwrap(node)
    while isinstance(value, list):
        if not value:
            return None
        value = _unwrap(value[0])
    return value


def _as_list(node: Any) -> list:
    """Repeatable SIRI elements may be one object or a list."""
    if node is None:
        return []
    if isinstance(node, list):
        return node
    return [node]


def strip_agency(ref: Any) -> str:
    """'MTA_990001' -> '990001'; 'MTABC_C99' -> 'C99'.

    MTA prefixes stop ids and route refs with the GTFS agency id.
    """
    text = str(_scalar(ref) or "").strip()
    if not text:
        return ""
    return text.rsplit("_", 1)[-1]


def _parse_iso8601(value: Any) -> int | None:
    text = str(_scalar(value) or "").strip()
    if not text:
        return None
    # Tolerate "...Z" (not emitted by MTA today, but cheap to accept).
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return int(dt.datetime.fromisoformat(text).timestamp())
    except ValueError:
        log.debug("unparseable SIRI timestamp: %r", text)
        return None


def error_text(payload: Any) -> str | None:
    """Pull an ErrorCondition message out of an otherwise well-formed body."""
    try:
        delivery = payload["Siri"]["ServiceDelivery"]
    except (TypeError, KeyError):
        return None
    if not isinstance(delivery, dict):
        return None
    for value in delivery.values():
        for entry in _as_list(value):
            if not isinstance(entry, dict):
                continue
            condition = entry.get("ErrorCondition")
            if not isinstance(condition, dict):
                continue
            other = condition.get("OtherError")
            text = _scalar(other.get("ErrorText")) if isinstance(other, dict) else None
            description = _scalar(condition.get("Description"))
            return str(text or description or "unknown SIRI error")
    return None


def build_url(
    base_url: str,
    monitoring_ref: str,
    api_key: str,
    max_visits: int = DEFAULT_MAX_VISITS,
    version: int = 2,
    operator_ref: str = OPERATOR_REF,
) -> str:
    query = urllib.parse.urlencode(
        {
            "key": api_key,
            "version": version,
            "OperatorRef": operator_ref,
            "MonitoringRef": monitoring_ref,
            "MaximumStopVisits": max_visits,
        }
    )
    separator = "&" if urllib.parse.urlparse(base_url).query else "?"
    return f"{base_url}{separator}{query}"


def redact(url: str) -> str:
    """Strip the API key before a URL reaches a log line or an error message."""
    parsed = urllib.parse.urlsplit(url)
    if not parsed.query:
        return url
    pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    scrubbed = [(k, "REDACTED" if k.lower() == "key" else v) for k, v in pairs]
    return urllib.parse.urlunsplit(parsed._replace(query=urllib.parse.urlencode(scrubbed)))


class SiriError(RuntimeError):
    """Raised when SIRI returns an error condition or an unusable document."""


def fetch_json(url: str, timeout: float = 20.0, user_agent: str = "transistor/0.1") -> Any:
    """GET a SIRI JSON document, surfacing ErrorCondition bodies as exceptions."""
    request = urllib.request.Request(
        url, headers={"User-Agent": user_agent, "Accept": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            raise SiriError(
                f"HTTP {exc.code} from SIRI for {redact(url)}: {body[:200]}"
            ) from exc
        message = error_text(payload) or body[:200]
        raise SiriError(f"HTTP {exc.code} from SIRI for {redact(url)}: {message}") from exc


def _line_of(journey: dict) -> str:
    """Prefer the GTFS route_short_name; fall back to stripping the agency."""
    published = _scalar(journey.get("PublishedLineName"))
    if published:
        return str(published).strip()
    return strip_agency(journey.get("LineRef"))


def _trip_id(journey: dict) -> str:
    framed = journey.get("FramedVehicleJourneyRef")
    if isinstance(framed, dict):
        ref = _scalar(framed.get("DatedVehicleJourneyRef"))
        if ref:
            return str(ref)
    return str(_scalar(journey.get("VehicleRef")) or "")


def _expected_epoch(call: dict) -> int | None:
    """MonitoredCall's predicted time at the stop of interest.

    ``OriginAimedDepartureTime`` is deliberately *not* a fallback: it is the
    scheduled departure from the route's origin terminal, so presenting it as
    an arrival here would be wrong. A visit with no prediction is skipped.
    """
    for field in ("ExpectedArrivalTime", "ExpectedDepartureTime"):
        epoch = _parse_iso8601(call.get(field))
        if epoch is not None:
            return epoch
    return None


def parse_stop_monitoring(payload: Any) -> list[Departure]:
    """Extract departures from a SIRI StopMonitoring JSON document."""
    if not isinstance(payload, dict):
        raise SiriError("SIRI response was not a JSON object")

    try:
        delivery = payload["Siri"]["ServiceDelivery"]
    except (KeyError, TypeError) as exc:
        raise SiriError(f"unrecognised SIRI response: {str(payload)[:200]}") from exc

    message = error_text(payload)
    if message:
        raise SiriError(message)

    deliveries = _as_list(delivery.get("StopMonitoringDelivery"))
    if not deliveries:
        raise SiriError("no StopMonitoringDelivery in SIRI response")

    out: list[Departure] = []
    for entry in deliveries:
        if not isinstance(entry, dict):
            continue
        for visit in _as_list(entry.get("MonitoredStopVisit")):
            if not isinstance(visit, dict):
                continue
            journey = visit.get("MonitoredVehicleJourney")
            if not isinstance(journey, dict):
                continue
            call = journey.get("MonitoredCall")
            if not isinstance(call, dict):
                continue
            line = _line_of(journey)
            stop_id = strip_agency(call.get("StopPointRef"))
            epoch = _expected_epoch(call)
            if not line or not stop_id or epoch is None:
                continue
            out.append(
                Departure(
                    line=line,
                    stop_id=stop_id,
                    epoch=epoch,
                    trip_id=_trip_id(journey),
                )
            )
    return out
