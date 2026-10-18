{ config, lib, pkgs, ... }:

let
  cfg = config.services.transistor;
  inherit (lib) mkEnableOption mkIf mkOption optionalAttrs types;

  feedsJson = builtins.toJSON (lib.mapAttrs (_: f: {
    inherit (f) url pollInterval kind;
  }) cfg.feeds);

  watchesJson = builtins.toJSON (map (w: {
    inherit (w) line mode feed stopId stopName direction;
  }) cfg.watches);
in
{
  options.services.transistor = {
    enable = mkEnableOption "transistor, a GTFS-Realtime departure publisher for MQTT";

    package = mkOption {
      type = types.package;
      default = pkgs.callPackage ./package.nix { };
      defaultText = lib.literalExpression "transistor.packages.\${system}.transistor";
      description = "The transistor package to run.";
    };

    mqtt = {
      host = mkOption {
        type = types.str;
        example = "10.0.0.5";
        description = "Hostname or IP of the MQTT broker.";
      };

      port = mkOption {
        type = types.port;
        default = 1883;
        description = "Port of the MQTT broker.";
      };

      username = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "transistor";
        description = "MQTT username. Null connects anonymously.";
      };

      passwordFile = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "/etc/transistor/mqtt-password";
        description = ''
          Path to a file containing the MQTT password. It is passed to the
          service as a systemd credential, so it is never written to the Nix
          store. Deliberately a plain string rather than `types.path` — a
          `types.path` would copy the secret into the world-readable store.
        '';
      };

      prefix = mkOption {
        type = types.str;
        default = "transistor";
        description = "MQTT topic prefix. Publishes <prefix>/state, /summary and /status.";
      };

      tls = mkOption {
        type = types.bool;
        default = false;
        description = "Use TLS for the MQTT connection.";
      };
    };

    siriApiKeyFile = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "/etc/transistor/siri-api-key";
      description = ''
        Path to a file containing the MTA Bus Time API key, required by any
        feed with `kind = "siri"`. Free, from
        <https://register.developer.obanyc.com/>.

        Passed to the service as a systemd credential, so like
        `mqtt.passwordFile` it is never written to the Nix store. Also a plain
        string rather than `types.path`, for the same reason.
      '';
    };

    timezone = mkOption {
      type = types.str;
      default = "UTC";
      example = "America/New_York";
      description = "Timezone used to render the absolute departure times.";
    };

    publishInterval = mkOption {
      type = types.ints.positive;
      default = 15;
      description = ''
        Seconds between MQTT publishes. Minute values are recomputed on every
        publish from the stored departure times, so they tick down between
        feed polls.
      '';
    };

    topN = mkOption {
      type = types.ints.positive;
      default = 2;
      description = "How many upcoming departures to report per line.";
    };

    feeds = mkOption {
      type = types.attrsOf (types.submodule {
        options = {
          url = mkOption {
            type = types.str;
            description = "Feed URL.";
          };
          kind = mkOption {
            type = types.enum [ "gtfs-rt" "siri" ];
            default = "gtfs-rt";
            description = ''
              `gtfs-rt` fetches one protobuf document per URL.

              `siri` is MTA Bus Time's StopMonitoring API, which is queried
              **per stop** rather than per URL: the service issues one request
              per distinct `stopId` among this feed's watches (~11 KB each,
              against ~1.8 MB for the system-wide bus GTFS-RT feed). It needs
              `services.transistor.siriApiKeyFile`.
            '';
          };
          pollInterval = mkOption {
            type = types.ints.positive;
            default = 60;
            description = "Seconds between polls of this feed.";
          };
        };
      });
      example = lib.literalExpression ''
        {
          subway = {
            url = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-<line-group>";
            pollInterval = 30;
          };
          bus = {
            kind = "siri";
            url = "https://bustime-classic.mta.info/api/siri/stop-monitoring.json";
            pollInterval = 60;
          };
        }
      '';
      description = ''
        Feeds to poll, keyed by a name referenced from `watches`.

        No default is provided: the line group you subscribe to is a strong
        hint about where you live, and this module is published. Set it in the
        consuming (private) host configuration.
      '';
    };

    watches = mkOption {
      type = types.listOf (types.submodule {
        options = {
          line = mkOption {
            type = types.str;
            example = "L";
            description = "Route id exactly as it appears in the feed.";
          };
          mode = mkOption {
            type = types.enum [ "subway" "bus" ];
            default = "subway";
            description = "Presentation hint for the dashboard.";
          };
          feed = mkOption {
            type = types.str;
            description = "Key into `feeds`.";
          };
          stopId = mkOption {
            type = types.str;
            description = ''
              Directional stop/platform id. Subway platform ids carry an N/S
              suffix, one per direction; MTA bus stops are separate ids per
              direction and per side of the street. Both are in the route's
              static GTFS (stops.txt / stop_times.txt).
            '';
          };
          stopName = mkOption {
            type = types.str;
            default = "";
            description = "Human-readable stop name, shown on the dashboard.";
          };
          direction = mkOption {
            type = types.str;
            default = "";
            description = "Human-readable direction, shown on the dashboard.";
          };
        };
      });
      description = ''
        The line/stop pairs to report.

        No default is provided — see `feeds`.
      '';
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.feeds != { };
        message = "services.transistor.feeds must list at least one feed";
      }
      {
        assertion = cfg.watches != [ ];
        message = "services.transistor.watches must list at least one line/stop pair";
      }
      {
        assertion = lib.all (w: lib.elem w.feed (lib.attrNames cfg.feeds)) cfg.watches;
        message = "every services.transistor.watches entry must name a feed defined in services.transistor.feeds";
      }
      {
        assertion = !(lib.any (f: f.kind == "siri") (lib.attrValues cfg.feeds))
          || cfg.siriApiKeyFile != null;
        message = ''
          a feed with kind = "siri" needs services.transistor.siriApiKeyFile.
          Request a free key at https://register.developer.obanyc.com/
        '';
      }
    ];

    systemd.services.transistor = {
      description = "GTFS-Realtime departure publisher for MQTT";
      documentation = [ "https://github.com/bcosynot/transistor" ];

      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];

      environment = {
        TRANSISTOR_MQTT_HOST = cfg.mqtt.host;
        TRANSISTOR_MQTT_PORT = toString cfg.mqtt.port;
        TRANSISTOR_MQTT_PREFIX = cfg.mqtt.prefix;
        TRANSISTOR_MQTT_TLS = lib.boolToString cfg.mqtt.tls;
        TRANSISTOR_TIMEZONE = cfg.timezone;
        TRANSISTOR_PUBLISH_INTERVAL = toString cfg.publishInterval;
        TRANSISTOR_TOP_N = toString cfg.topN;
        TRANSISTOR_FEEDS = feedsJson;
        TRANSISTOR_WATCHES = watchesJson;
        # zoneinfo must come from tzdata; the sandbox has no /etc/localtime.
        PYTHONTZPATH = "${pkgs.tzdata}/share/zoneinfo";
      } // optionalAttrs (cfg.mqtt.username != null) {
        TRANSISTOR_MQTT_USERNAME = cfg.mqtt.username;
      };

      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        Restart = "always";
        RestartSec = 10;

        DynamicUser = true;
        LoadCredential =
          lib.optional (cfg.mqtt.passwordFile != null)
            "mqtt-password:${cfg.mqtt.passwordFile}"
          ++ lib.optional (cfg.siriApiKeyFile != null)
            "siri-api-key:${cfg.siriApiKeyFile}";

        # Hardening: the service only ever makes outbound TCP connections.
        NoNewPrivileges = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        ProtectHostname = true;
        RestrictAddressFamilies = [ "AF_INET" "AF_INET6" ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        RemoveIPC = true;
        SystemCallArchitectures = "native";
        SystemCallFilter = [ "@system-service" "~@privileged @resources" ];
        CapabilityBoundingSet = "";
        IPAddressDeny = "link-local";
      };
    };
  };
}
