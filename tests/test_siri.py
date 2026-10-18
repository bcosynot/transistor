"""Tests for the SIRI StopMonitoring source.

The fixture mirrors the live MTA response byte-for-byte in *shape*, with all
identifiers replaced by fictional ones. The shapes that matter, and that were
all confirmed against the live API:

  * name-like fields arrive array-wrapped ("PublishedLineName": ["C99"])
  * refs arrive as plain agency-prefixed strings ("MTA_990001")
  * value-wrappers ({ "value": "C99" }) appear on some elements
  * ProgressStatus is array-wrapped and may be layover / prevTrip
"""

from __future__ import annotations

import datetime as dt
import json
import pathlib
import urllib.error
from unittest import mock

import pytest

from transistor import siri
from transistor.config import Watch

FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "siri_stop_monitoring.json"

WATCHES = [
    Watch("C99", "bus", "bus", "990001", "Example Rd/1 St", "City Centre"),
    Watch("D44", "bus", "bus", "990001", "Example Rd/1 St", "City Centre"),
]


def epoch(iso: str) -> int:
    return int(dt.datetime.fromisoformat(iso).timestamp())


@pytest.fixture
def payload() -> dict:
    return json.loads(FIXTURE.read_text())


def test_parses_the_expected_visits(payload):
    got = siri.parse_stop_monitoring(payload)
    assert [(d.line, d.stop_id) for d in got] == [
        ("C99", "990001"),   # 08:05
        ("D44", "990001"),   # 08:09
        ("C99", "990001"),   # 08:15 (departure-only)
        ("C99", "990001"),   # 08:21 (value-wrapped line name)
        ("Z9", "990001"),    # unwatched route, still parsed at this layer
    ]


def test_route_ids_are_not_array_artifacts(payload):
    """Regression: str() on an array-wrapped name yields "['C99']"."""
    lines = {d.line for d in siri.parse_stop_monitoring(payload)}
    assert "['C99']" not in lines
    assert not any("[" in line or "'" in line for line in lines)
    assert "C99" in lines and "D44" in lines


def test_agency_prefixes_are_stripped(payload):
    got = siri.parse_stop_monitoring(payload)
    assert {d.stop_id for d in got} == {"990001"}
    assert {"MTA_C99", "MTABC_D44"}.isdisjoint({d.line for d in got})


def test_value_wrapped_fields_are_unwrapped(payload):
    got = siri.parse_stop_monitoring(payload)
    epochs = {d.epoch for d in got}
    assert epoch("2026-01-01T08:21:26.246-05:00") in epochs


def test_layover_and_prev_trip_predictions_are_kept(payload):
    """MTA marks these via ProgressStatus; the ETA is still the best we have."""
    epochs = {d.epoch for d in siri.parse_stop_monitoring(payload)}
    assert epoch("2026-01-01T08:21:26.246-05:00") in epochs  # prevTrip
    # The layover visit has only AimedArrivalTime, which must NOT be used as a
    # prediction: the bus has not left the terminal.
    assert epoch("2026-01-01T08:20:00.000-05:00") not in epochs


def test_visits_without_a_prediction_are_skipped(payload):
    got = siri.parse_stop_monitoring(payload)
    assert len(got) == 5
    assert all(isinstance(d.epoch, int) for d in got)


def test_departure_time_is_used_when_arrival_is_absent(payload):
    epochs = {d.epoch for d in siri.parse_stop_monitoring(payload)}
    assert epoch("2026-01-01T08:15:50.722-05:00") in epochs


def test_watch_filtering_keeps_only_the_requested_lines(payload):
    from transistor.departures import apply_window

    got = siri.parse_stop_monitoring(payload)
    now = epoch("2026-01-01T08:00:00.000-05:00")
    kept = apply_window(got, WATCHES, now)
    assert {d.line for d in kept} == {"C99", "D44"}
    assert [d.line for d in kept] == ["C99", "D44", "C99", "C99"]
    assert kept == sorted(kept, key=lambda d: d.epoch)


def test_error_body_is_raised_as_siri_error(payload):
    error = {
        "Siri": {
            "ServiceDelivery": {
                "ResponseTimestamp": "x",
                "VehicleMonitoringDelivery": [
                    {
                        "ResponseTimestamp": "x",
                        "ErrorCondition": {
                            "OtherError": {"ErrorText": "API key is not authorized."},
                            "Description": "API key is not authorized.",
                        },
                    }
                ],
            }
        }
    }
    assert siri.error_text(error) == "API key is not authorized."
    with pytest.raises(siri.SiriError, match="not authorized"):
        siri.parse_stop_monitoring(error)


def test_error_text_reads_the_mta_error_shape_we_actually_received():
    """Real 403 body captured from the API before the key was issued."""
    body = {
        "Siri": {
            "ServiceDelivery": {
                "ResponseTimestamp": "2026-10-18T13:01:43.242-04:00",
                "VehicleMonitoringDelivery": [
                    {
                        "ResponseTimestamp": "2026-10-18T13:01:43.242-04:00",
                        "ErrorCondition": {
                            "OtherError": {"ErrorText": "API key is required."},
                            "Description": "API key is required.",
                        },
                    }
                ],
            }
        }
    }
    assert siri.error_text(body) == "API key is required."


def test_empty_delivery_is_not_an_error(payload):
    """A stop with no buses due is valid, not a failure."""
    assert siri.parse_stop_monitoring({"Siri": {"ServiceDelivery": {
        "StopMonitoringDelivery": [{"ResponseTimestamp": "x", "MonitoredStopVisit": []}]
    }}}) == []


def test_missing_delivery_is_an_error():
    with pytest.raises(siri.SiriError, match="no StopMonitoringDelivery"):
        siri.parse_stop_monitoring(
            {"Siri": {"ServiceDelivery": {"ResponseTimestamp": "x"}}}
        )


def test_non_object_payload_is_an_error():
    with pytest.raises(siri.SiriError, match="not a JSON object"):
        siri.parse_stop_monitoring(["nope"])


def test_single_visit_is_accepted_unwrapped_from_a_list():
    """SIRI may emit a lone repeatable element as a bare object."""
    doc = {
        "Siri": {
            "ServiceDelivery": {
                "StopMonitoringDelivery": {
                    "MonitoredStopVisit": {
                        "MonitoredVehicleJourney": {
                            "PublishedLineName": "C99",
                            "LineRef": "MTA_C99",
                            "MonitoredCall": {
                                "ExpectedArrivalTime": "2026-01-01T08:05:00.000-05:00",
                                "StopPointRef": "MTA_990001",
                            },
                        }
                    }
                }
            }
        }
    }
    got = siri.parse_stop_monitoring(doc)
    assert [(d.line, d.stop_id) for d in got] == [("C99", "990001")]


# --- request building / secret handling -----------------------------------


def test_build_url_carries_the_documented_parameters():
    url = siri.build_url("https://example.invalid/sm.json", "990001", "KEY", 7)
    assert url.startswith("https://example.invalid/sm.json?")
    query = dict(
        pair.split("=", 1) for pair in url.split("?", 1)[1].split("&")
    )
    assert query == {
        "key": "KEY",
        "version": "2",
        "OperatorRef": "MTA",
        "MonitoringRef": "990001",
        "MaximumStopVisits": "7",
    }


def test_build_url_appends_to_an_existing_query():
    url = siri.build_url("https://example.invalid/sm.json?foo=1", "990001", "KEY")
    assert "?foo=1&key=KEY" in url


def test_redact_hides_only_the_key():
    url = siri.build_url("https://example.invalid/sm.json", "990001", "SUPERSECRET")
    scrubbed = siri.redact(url)
    assert "SUPERSECRET" not in scrubbed
    assert "key=REDACTED" in scrubbed
    assert "MonitoringRef=990001" in scrubbed


def test_fetch_reads_the_body_on_http_error_so_the_reason_survives():
    """MTA returns the real reason in a 403 body, not the status line."""
    body = json.dumps(
        {
            "Siri": {
                "ServiceDelivery": {
                    "VehicleMonitoringDelivery": [
                        {
                            "ErrorCondition": {
                                "OtherError": {"ErrorText": "API key is not authorized."}
                            }
                        }
                    ]
                }
            }
        }
    ).encode()
    error = urllib.error.HTTPError(
        url="https://example.invalid/sm.json",
        code=403,
        msg="Forbidden",
        hdrs=None,
        fp=mock.Mock(read=lambda: body),
    )
    with mock.patch("urllib.request.urlopen", side_effect=error):
        with pytest.raises(siri.SiriError) as excinfo:
            siri.fetch_json("https://example.invalid/sm.json?key=SUPERSECRET")
    message = str(excinfo.value)
    assert "403" in message
    assert "not authorized" in message
    # The key must never reach a log line or an exception message.
    assert "SUPERSECRET" not in message
