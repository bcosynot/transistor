# transistor

Publishes the next departures for a configurable set of transit lines to MQTT,
for a Home Assistant dashboard. Built for a wall-mounted kiosk: two numbers per
line, minutes away (primary) and clock time (secondary).

```
A      Example Av → Downtown         3 min    8:03am     9 min    8:09am
B      Example Av → Downtown           —                    —
C9     Example Rd/1 St → City Centre 4 min    8:04am    12 min    8:12am
D4     Example Rd/1 St → City Centre 6 min    8:06am    14 min    8:14am
```

## Why there are no default stops

**`feeds` and `watches` have no defaults, on purpose.** Which platform you
stand on is a precise indicator of where you live, and this repository is
public. A baked-in default would publish the deployment's location on every
clone. Both options are required, and the examples in this README use fictional
ids (`ZZ01S`, `990001`) rather than any real stop.

Set your real values in the consuming host configuration, which is private.

## Data sources

Two feed types, chosen per feed with `kind`:

| `kind` | Source | Payload | API key |
|---|---|---|---|
| `siri` | MTA Bus Time StopMonitoring, `https://bustime-classic.mta.info/api/siri/stop-monitoring.json` | **~11 KB per stop** | yes, free |
| `gtfs-rt` | GTFS-Realtime protobuf, e.g. subway `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-<group>` | ~50-100 KB per line group | no |
| `gtfs-rt` | GTFS-Realtime protobuf, system-wide buses `https://gtfsrt.prod.obanyc.com/tripUpdates` | **~1.8 MB** (gzipped on the wire) | no |

Use `kind = "siri"` for buses. There is no per-route bus GTFS-RT feed, so that
route means downloading and filtering the entire bus system: at a 60 s poll
that is roughly **2.5 GB/day**, against a few tens of KB for SIRI. Measured
against the live API: 11,266 bytes for a 10-visit stop response, versus
1,860,581 bytes for one bus GTFS-RT poll.

Subway stays on `gtfs-rt` — the line-group feeds are already small and there is
no SIRI equivalent.

Subway line groups: `gtfs` (1-7/S), `gtfs-ace`, `gtfs-bdfm`, `gtfs-g`,
`gtfs-jz`, `gtfs-l`, `gtfs-nqrw`, `gtfs-si`. The feed listing and the
real-time terms are at <https://api.mta.info/>. The old `datamine.mta.info` and
`api-endpoints.mta.info` hostnames no longer resolve — ignore any tutorial that
still uses them.

### The SIRI API key

Free, from <https://register.developer.obanyc.com/>; delivered by email within
about half an hour.

Supply it, never commit it, and never pass it on a command line. The service
takes it from, in order:

1. a systemd credential named `siri-api-key` (what the NixOS module wires up),
2. the file named by `TRANSISTOR_SIRI_API_KEY_FILE`,
3. the plain `TRANSISTOR_SIRI_API_KEY` variable.

The key is a `?key=` query parameter — that is the only way the API accepts it —
so it is redacted out of every log line and error message.

## Finding your stop ids

Both ids come from the route's static GTFS (`stops.txt` and `stop_times.txt`).
Download the relevant zip, then:

- **Subway.** Platform ids carry an `N`/`S` suffix — there is one per direction,
  and they are *different ids*. Pick the one for the direction you travel.
  `stop_times.txt` tells you which routes serve it.
- **Buses.** Each direction, and each side of the street, is a separate stop id.
  The direction is `trips.direction_id`; the terminal is the highest
  `stop_sequence` on a trip.

Static GTFS bundles: subway, and one per borough plus MTA Bus Company for
buses — see <https://new.mta.info/developers>.

Matching is on **route *and* platform**, so two directions of the same line are
never mixed together. A line with no service at the moment (many routes do not
run overnight or at weekends) still appears with an empty list, so the kiosk
never has to special-case it.

## NixOS module

The flake exposes `nixosModules.transistor`, consumed as an input by a host
flake:

```nix
{
  inputs.transistor.url = "github:bcosynot/transistor";

  imports = [ inputs.transistor.nixosModules.transistor ];

  services.transistor = {
    enable = true;

    mqtt = {
      host = "10.0.0.5";
      port = 1883;
      username = "transistor";
      # A plain path string, deliberately not types.path — a types.path would
      # copy the secret into the world-readable Nix store. It is handed to the
      # service as a systemd credential.
      passwordFile = "/etc/transistor/mqtt-password";
    };

    # Required by any feed with kind = "siri".
    siriApiKeyFile = "/etc/transistor/siri-api-key";

    timezone = "America/New_York";

    feeds = {
      subway = {
        url = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-<group>";
        pollInterval = 30;
      };
      bus = {
        kind = "siri";
        url = "https://bustime-classic.mta.info/api/siri/stop-monitoring.json";
        pollInterval = 60;
      };
    };

    watches = [
      { line = "A"; mode = "subway"; feed = "subway";
        stopId = "ZZ01S"; stopName = "Example Av"; direction = "Downtown"; }
      { line = "C9"; mode = "bus"; feed = "bus";
        stopId = "990001"; stopName = "Example Rd/1 St"; direction = "City Centre"; }
    ];

    topN = 2;              # departures per line
    publishInterval = 15;  # seconds between MQTT publishes
  };
}
```

The service runs as a `DynamicUser` with a hardened unit
(`ProtectSystem=strict`, empty `CapabilityBoundingSet`, `@system-service`
syscall filter) and restarts forever. It only ever makes outbound TCP
connections.

## MQTT topics

All retained, under `mqtt.prefix` (default `transistor`):

| Topic | Payload |
|---|---|
| `transistor/status` | `online` / `offline` (last will — for HA availability) |
| `transistor/summary` | `A 3/9 · B — · C9 4/12 · D4 6/14` |
| `transistor/state` | the full JSON board |

```json
{
  "generated": "2026-01-01T08:00:04-05:00",
  "generated_ts": 1767272404,
  "stale": false,
  "summary": "A 3/9 · B — · C9 4/12 · D4 6/14",
  "lines": [
    { "line": "A", "mode": "subway", "stop": "Example Av", "direction": "Downtown",
      "deps": [ { "min": 3, "at": "8:03am", "epoch": 1767272584 },
                { "min": 9, "at": "8:09am", "epoch": 1767272944 } ] }
  ],
  "feeds": { "subway": { "stale": false, "age": 0.5, "error": null } }
}
```

`stale` goes true when any feed has missed `3 ×` its poll interval; per-feed
detail is in `feeds`. Minute values are recomputed on every publish from the
stored absolute times, so they tick down between feed polls rather than jumping
every 30 s.

## Home Assistant

1. Copy `homeassistant/dashboard-transit-card.js` to `/config/www/`.
2. Register it as a module resource and add the MQTT sensor — see
   `homeassistant/mqtt_sensors.yaml` and `homeassistant/dashboard-snippet.yaml`.
3. Add `custom:dashboard-transit-card` to your dashboard in its own
   `column_span: 4` section.

A markdown card cannot do this: HA strips every `style` attribute out of
markdown content, so the presentation has to come from a custom element.

## Development

```sh
nix develop            # python + node with all deps
pytest -q tests        # no network
node --test tests/card.test.mjs
nix flake check        # runs both suites
```

Against the live feeds, without touching a broker:

```sh
TRANSISTOR_MQTT_HOST=unused \
TRANSISTOR_FEEDS='{"subway":{"url":"https://example.invalid/gtfs-xyz"}}' \
TRANSISTOR_WATCHES='[{"line":"A","feed":"subway","stopId":"ZZ01S","stopName":"Example Av","direction":"Downtown"}]' \
transistor --once | jq .
```

`--dry-run` runs the real poll loop but prints each board instead of publishing.

## Layout

```
src/transistor/config.py      env-driven configuration
src/transistor/departures.py  the departure record + time-window filtering
src/transistor/gtfs.py        GTFS-Realtime fetch + extraction
src/transistor/siri.py        MTA Bus Time SIRI StopMonitoring client
src/transistor/board.py       JSON document + minute rounding
src/transistor/mqtt.py        MQTT publishing
src/transistor/service.py     feeder threads + publish loop
nix/module.nix                NixOS module (services.transistor)
nix/package.nix               the derivation
homeassistant/                MQTT sensor, kiosk card, dashboard snippet
```

## License

MIT
