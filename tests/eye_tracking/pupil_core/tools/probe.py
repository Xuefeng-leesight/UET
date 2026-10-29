"""Read-only Capture diagnostics. Does not occupy MRT ports or write recordings."""

import argparse
import json
import math
import sys
import time

from services.eye_tracking.adapters.pupil_core.network import NetworkConfig
from services.eye_tracking.adapters.pupil_core.service import PupilService


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=50020)
    parser.add_argument("--seconds", type=float, default=10)
    parser.add_argument("--require-gaze", action="store_true", help="Fail if no gaze message was received")
    args = parser.parse_args(argv)
    if not math.isfinite(args.seconds) or not 0 < args.seconds <= 3600:
        parser.error("--seconds must be finite and within (0, 3600]")
    try:
        service = PupilService(NetworkConfig(remote_port=args.port))
    except ValueError as exc:
        parser.error(str(exc))
    result = {"model": "PupilCore", "product_integration": False, "calibration_verified": False}
    exit_code = 0
    try:
        service.connect()
        result["capture_version"] = service.network.version
        deadline = time.monotonic() + args.seconds
        while time.monotonic() < deadline:
            service.read()
        has_gaze = any(topic == "gaze" or topic.startswith("gaze.") for topic in service.received)
        result["gaze_received"] = has_gaze
        result["status"] = "acquisition_probe_passed" if has_gaze else "video_only"
        if args.require_gaze and not has_gaze:
            result.update(status="failed", error="No gaze messages received; check Capture calibration/tracking")
            exit_code = 1
    except KeyboardInterrupt:
        result["status"] = "cancelled"
        exit_code = 130
    except Exception as exc:
        result.update(status="failed", error=str(exc))
        exit_code = 1
    finally:
        result["received_by_topic"] = dict(service.received)
        result["connection_generation"] = service.generation
        service.close()
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
