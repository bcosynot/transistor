{ lib, python3 }:

python3.pkgs.buildPythonApplication {
  pname = "transistor";
  version = "0.1.0";

  pyproject = true;
  src = lib.cleanSource ../.;

  build-system = [ python3.pkgs.setuptools ];

  dependencies = with python3.pkgs; [
    gtfs-realtime-bindings
    paho-mqtt
  ];

  # Importing the package is a cheap, real smoke test: it catches a missing
  # runtime dependency or a broken entry point at build time rather than at
  # first poll on the box.
  pythonImportsCheck = [ "transistor" ];

  # The unit tests need pytest and a network-free fixture set; they run in CI
  # and in the dev shell rather than as part of every deploy.
  doCheck = false;

  meta = {
    description = "Publish NYC transit departures to MQTT for a Home Assistant kiosk";
    homepage = "https://github.com/bcosynot/transistor";
    license = lib.licenses.mit;
    mainProgram = "transistor";
    platforms = lib.platforms.linux;
  };
}
