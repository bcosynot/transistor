"""Command-line entry point."""

from __future__ import annotations

import argparse
import json
import logging
import sys

from .config import ConfigError, load_config
from .mqtt import Publisher
from .service import TransitService


class _StdoutPublisher:
    """Prints the board instead of publishing it (used by --once/--dry-run)."""

    def publish_board(self, board: dict) -> bool:
        print(json.dumps(board, indent=2))
        return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="transistor",
        description="Publish NYC transit departures to MQTT.",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="poll every feed a single time, print the board as JSON, and exit",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="run the poll loop but print boards instead of publishing to MQTT",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )

    try:
        cfg = load_config()
    except ConfigError as exc:
        print(f"configuration error: {exc}", file=sys.stderr)
        return 2

    if args.once:
        service = TransitService(cfg, _StdoutPublisher())
        service.build_once()
        return 0

    publisher = _StdoutPublisher() if args.dry_run else Publisher(cfg)
    service = TransitService(cfg, publisher)
    if not args.dry_run:
        publisher.start()
    try:
        service.run()
    finally:
        if not args.dry_run:
            publisher.stop()
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
