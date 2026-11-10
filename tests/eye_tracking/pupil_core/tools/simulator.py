"""Synthetic Capture for automated verification; never a production data source."""

import argparse
import json
import math
import time


def main(argv=None) -> int:
    import msgpack
    import zmq

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=50030)
    parser.add_argument("--seconds", type=float, default=60)
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535 or args.port in (9001, 9002, 9003, 50020):
        parser.error("Use a dedicated simulation port, not a real Capture/MRT port")
    if not math.isfinite(args.seconds) or not 0 < args.seconds <= 3600:
        parser.error("--seconds must be within (0,3600]")
    context = zmq.Context()
    remote, publisher = context.socket(zmq.REP), context.socket(zmq.PUB)
    try:
        remote.bind(f"tcp://127.0.0.1:{args.port}")
        sub_port = publisher.bind_to_random_port("tcp://127.0.0.1")
        print(json.dumps({"source": "SIMULATED", "remote_port": args.port, "duration_s": args.seconds}), flush=True)
        start = time.monotonic()
        next_frame = start
        index = 0
        width, height = 640, 360
        while time.monotonic() - start < args.seconds:
            if remote.poll(5):
                command = remote.recv_string()
                remote.send_string({"v": "mrt-pupil-simulator/1", "SUB_PORT": str(sub_port),
                                    "t": str(1000 + time.monotonic() - start)}.get(command, "Unsupported read-only simulator command"))
            now = time.monotonic()
            if now < next_frame:
                continue
            timestamp = 1000 + now - start
            # Deliberately recognizable color bars, never a fabricated human/eye image.
            bars = [(36, 55, 82), (61, 126, 168), (121, 188, 210), (121, 251, 215)]
            offset = (index // 15) % len(bars)
            row = b"".join(bytes(bars[(i + offset) % len(bars)]) * (width // 4) for i in range(4))
            frame = {"topic": "frame.world", "timestamp": timestamp, "index": index,
                     "width": width, "height": height, "format": "bgr", "simulated": True}
            publisher.send_multipart([b"frame.world", msgpack.packb(frame, use_bin_type=True), row * height])
            pupils = [{"topic": f"pupil.{eye}.3d", "id": eye, "timestamp": timestamp,
                       "diameter": 36, "diameter_3d": 3.2, "confidence": 0.95, "simulated": True} for eye in (0, 1)]
            gaze = {"topic": "gaze.3d.01.", "timestamp": timestamp, "confidence": 0.95,
                    "norm_pos": [0.5 + 0.3 * math.sin(now - start), 0.5 + 0.3 * math.cos(now - start)],
                    "base_data": pupils, "simulated": True}
            for sample in (*pupils, gaze):
                publisher.send_multipart([sample["topic"].encode(), msgpack.packb(sample, use_bin_type=True)])
            index += 1
            next_frame = now + 1 / 30
        return 0
    except KeyboardInterrupt:
        return 130
    finally:
        remote.close(linger=0)
        publisher.close(linger=0)
        context.term()


if __name__ == "__main__":
    raise SystemExit(main())
