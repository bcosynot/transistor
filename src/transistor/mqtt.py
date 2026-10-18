"""MQTT publishing.

Topics (all retained, under `mqtt_prefix`, default `transistor`):

    transistor/status   -> "online" | "offline"  (last will, for HA availability)
    transistor/summary  -> "A 3/9 · B — · C9 4/12 · D4 6/14"
    transistor/state    -> the full JSON board

Home Assistant consumes `state` as a single mqtt sensor whose attributes carry
the whole board, which is what the kiosk card renders.
"""

from __future__ import annotations

import json
import logging
import socket

import paho.mqtt.client as mqtt

from .config import Config

log = logging.getLogger("transistor.mqtt")


class Publisher:
    """Thin wrapper over paho-mqtt that publishes one retained board document."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.prefix = cfg.mqtt_prefix.rstrip("/")
        self.topic_state = f"{self.prefix}/state"
        self.topic_summary = f"{self.prefix}/summary"
        self.topic_status = f"{self.prefix}/status"
        self.connected = False

        self.client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id=f"transistor-{socket.gethostname()}",
            protocol=mqtt.MQTTv311,
        )
        if cfg.mqtt_username:
            self.client.username_pw_set(cfg.mqtt_username, cfg.mqtt_password)
        if cfg.mqtt_tls:
            self.client.tls_set()

        self.client.will_set(self.topic_status, "offline", qos=1, retain=True)
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect

    # -- callbacks ---------------------------------------------------------
    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        if reason_code == 0:
            self.connected = True
            log.info("connected to MQTT broker %s:%s", self.cfg.mqtt_host, self.cfg.mqtt_port)
            client.publish(self.topic_status, "online", qos=1, retain=True)
        else:
            self.connected = False
            log.error("MQTT connect refused: %s", reason_code)

    def _on_disconnect(self, client, userdata, flags, reason_code, properties=None):
        self.connected = False
        log.warning("disconnected from MQTT broker: %s", reason_code)

    # -- lifecycle ---------------------------------------------------------
    def start(self) -> None:
        """Connect and begin the background network loop.

        paho retries the connection itself once loop_start() is running, so a
        broker that is briefly unavailable does not kill the service.
        """
        self.client.connect_async(self.cfg.mqtt_host, self.cfg.mqtt_port, keepalive=60)
        self.client.loop_start()

    def stop(self) -> None:
        try:
            self.client.publish(self.topic_status, "offline", qos=1, retain=True)
            self.client.loop_stop()
            self.client.disconnect()
        except Exception:  # pragma: no cover - best effort on shutdown
            log.debug("error during MQTT shutdown", exc_info=True)

    # -- publishing --------------------------------------------------------
    def publish_board(self, board: dict) -> bool:
        payload = json.dumps(board, separators=(",", ":"))
        ok = True
        info = self.client.publish(self.topic_state, payload, qos=1, retain=True)
        if info.rc != mqtt.MQTT_ERR_SUCCESS:
            log.warning("failed to publish board: rc=%s", info.rc)
            ok = False
        info = self.client.publish(self.topic_summary, board.get("summary", ""), qos=1, retain=True)
        if info.rc != mqtt.MQTT_ERR_SUCCESS:
            log.warning("failed to publish summary: rc=%s", info.rc)
            ok = False
        return ok
