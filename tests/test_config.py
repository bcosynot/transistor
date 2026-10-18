from __future__ import annotations

import json

import pytest

from transistor.config import ConfigError, load_config

FEEDS = json.dumps({"subway": {"url": "https://example.invalid/gtfs", "pollInterval": 30}})
WATCHES = json.dumps(
    [
        {
            "line": "A",
            "mode": "subway",
            "feed": "subway",
            "stopId": "ZZ01S",
            "stopName": "Example Av",
            "direction": "Downtown",
        }
    ]
)


def minimal(**extra):
    """The smallest env that produces a valid Config."""
    env = {
        "TRANSISTOR_MQTT_HOST": "broker",
        "TRANSISTOR_FEEDS": FEEDS,
        "TRANSISTOR_WATCHES": WATCHES,
    }
    env.update(extra)
    return env


def test_requires_broker_host():
    with pytest.raises(ConfigError, match="TRANSISTOR_MQTT_HOST"):
        load_config({})


def test_feeds_have_no_default():
    """A default would pin the deployment's line group into a public repo."""
    env = minimal()
    del env["TRANSISTOR_FEEDS"]
    with pytest.raises(ConfigError, match="TRANSISTOR_FEEDS is required"):
        load_config(env)


def test_watches_have_no_default():
    env = minimal()
    del env["TRANSISTOR_WATCHES"]
    with pytest.raises(ConfigError, match="TRANSISTOR_WATCHES is required"):
        load_config(env)


def test_the_error_says_why_and_shows_the_shape():
    env = minimal()
    del env["TRANSISTOR_WATCHES"]
    with pytest.raises(ConfigError) as excinfo:
        load_config(env)
    message = str(excinfo.value)
    assert "reveal its location" in message
    assert "stopId" in message


def test_generic_defaults_are_location_neutral():
    cfg = load_config(minimal())
    assert cfg.top_n == 2
    assert cfg.mqtt_prefix == "transistor"
    assert cfg.mqtt_port == 1883
    assert cfg.publish_interval == 15.0
    assert cfg.timezone == "UTC"
    assert cfg.mqtt_tls is False


def test_env_overrides():
    cfg = load_config(
        minimal(
            TRANSISTOR_MQTT_PORT="8883",
            TRANSISTOR_MQTT_USERNAME="transistor",
            TRANSISTOR_MQTT_PASSWORD="hunter2",
            TRANSISTOR_MQTT_TLS="true",
            TRANSISTOR_TOP_N="3",
            TRANSISTOR_PUBLISH_INTERVAL="5",
            TRANSISTOR_TIMEZONE="America/New_York",
        )
    )
    assert cfg.mqtt_port == 8883
    assert cfg.mqtt_username == "transistor"
    assert cfg.mqtt_password == "hunter2"
    assert cfg.mqtt_tls is True
    assert cfg.top_n == 3
    assert cfg.publish_interval == 5.0
    assert cfg.timezone == "America/New_York"


def test_password_prefers_systemd_credential(tmp_path):
    cred = tmp_path / "mqtt-password"
    cred.write_text("from-credential\n")
    cfg = load_config(
        minimal(CREDENTIALS_DIRECTORY=str(tmp_path), TRANSISTOR_MQTT_PASSWORD="from-env")
    )
    assert cfg.mqtt_password == "from-credential"


def test_password_file(tmp_path):
    p = tmp_path / "pw"
    p.write_text("secret\n")
    cfg = load_config(minimal(TRANSISTOR_MQTT_PASSWORD_FILE=str(p)))
    assert cfg.mqtt_password == "secret"


def test_watches_and_feeds_are_parsed():
    cfg = load_config(minimal())
    assert [f.key for f in cfg.feeds] == ["subway"]
    assert cfg.feeds[0].poll_interval == 30
    assert cfg.watches[0].stop_name == "Example Av"
    assert cfg.watches_for("subway") == cfg.watches
    assert cfg.watches_for("bus") == ()


def test_watch_referencing_unknown_feed_is_rejected():
    with pytest.raises(ConfigError, match="unknown feed"):
        load_config(
            minimal(
                TRANSISTOR_WATCHES=json.dumps(
                    [{"line": "A", "feed": "nope", "stopId": "ZZ01S"}]
                )
            )
        )


def test_malformed_json_is_reported():
    with pytest.raises(ConfigError, match="not valid JSON"):
        load_config(minimal(TRANSISTOR_FEEDS="{oops"))


def test_empty_json_list_is_treated_as_missing():
    with pytest.raises(ConfigError, match="TRANSISTOR_WATCHES is required"):
        load_config(minimal(TRANSISTOR_WATCHES="[]"))
