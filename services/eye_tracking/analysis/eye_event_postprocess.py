"""Offline event postprocessing for completed eye-tracking recordings."""

import csv
import math
import os
from pathlib import Path


EVENT_COLUMNS = [
    "fixation_index",
    "fixation_point_x_px",
    "fixation_point_y_px",
    "saccade_index",
    "saccade_duration_ms",
    "saccade_distance_px",
    "average_saccade_velocity_px_ms",
    "peak_saccade_velocity_px_ms",
    "gaze_velocity_px_ms",
    "gaze_velocity_deg_ms",
]

RAW_BACKUP_COLUMNS = [
    "sdk_fixation_sample_count",
    "sdk_fixation_duration_ms_raw",
    "sdk_fixation_duration_us_raw",
    "sdk_fixation_center_x_raw",
    "sdk_fixation_center_y_raw",
]


def _number(value):
    try:
        text = str(value or "").strip()
        if not text:
            return None
        number = float(text)
        return number if math.isfinite(number) else None
    except Exception:
        return None


def _format(value, digits=6):
    if value is None:
        return ""
    if isinstance(value, int):
        return str(value)
    text = (f"{float(value):.{digits}f}").rstrip("0").rstrip(".")
    return "0" if text in ("", "-0") else text


def _normalized_vector(row):
    candidates = []
    recom = [_number(row.get(f"recom_direction_{axis}")) for axis in "xyz"]
    if all(value is not None for value in recom):
        candidates.append(recom)
    for prefix in ("left", "right"):
        vector = [_number(row.get(f"{prefix}_direction_{axis}")) for axis in "xyz"]
        if all(value is not None for value in vector):
            candidates.append(vector)
    valid = []
    for vector in candidates:
        length = math.sqrt(sum(value * value for value in vector))
        if length > 1e-9:
            valid.append([value / length for value in vector])
    if not valid:
        return None
    combined = [sum(vector[i] for vector in valid) for i in range(3)]
    length = math.sqrt(sum(value * value for value in combined))
    return [value / length for value in combined] if length > 1e-9 else valid[0]


def _angle_degrees(first, second):
    if first is None or second is None:
        return None
    dot = max(-1.0, min(1.0, sum(first[i] * second[i] for i in range(3))))
    return math.degrees(math.acos(dot))


def _point_to_pixels(x, y, width, height, centered):
    if x is None or y is None:
        return None
    if centered:
        px = x + width * 0.5
        py = y + height * 0.5
    elif -0.001 <= x <= 1.001 and -0.001 <= y <= 1.001:
        px = x * width
        py = y * height
    else:
        px, py = x, y
    if not (math.isfinite(px) and math.isfinite(py)):
        return None
    return (max(0.0, min(float(width), px)), max(0.0, min(float(height), py)))


def _row_gaze_pixels(row, width, height, centered):
    for prefix in ("recom_gaze", "recom_smooth_point", "recom_gaze_point"):
        point = _point_to_pixels(_number(row.get(f"{prefix}_x")), _number(row.get(f"{prefix}_y")), width, height, centered)
        if point is not None and point != (0.0, 0.0):
            return point
    return None


def _event_kind(row):
    state = _number(row.get("fixation_state"))
    if state is None:
        return None
    state = int(round(state))
    if state in (3, 4):
        return "fixation"
    if state in (1, 2):
        return "saccade"
    return None


def _finalize_event(event, next_event, width, height, centered):
    rows = event["rows"]
    if event["kind"] == "fixation":
        duration_values = [_number(row.get("fixation_duration_ms")) for row in rows]
        duration_values = [value for value in duration_values if value is not None and value >= 0]
        event["duration_ms"] = max(duration_values) if duration_values else max(0.0, event["end_ms"] - event["start_ms"])
        timestamp_ms_values = [_number(row.get("fixation_timestamp_ms")) for row in rows]
        timestamp_ms_values = [value for value in timestamp_ms_values if value is not None and value > 0]
        timestamp_us_values = [_number(row.get("fixation_timestamp_us")) for row in rows]
        timestamp_us_values = [value for value in timestamp_us_values if value is not None and value > 0]
        event["fixation_timestamp_ms"] = timestamp_ms_values[0] if timestamp_ms_values else None
        event["fixation_timestamp_us"] = timestamp_us_values[0] if timestamp_us_values else None
        center = None
        center_raw = None
        for row in reversed(rows):
            raw_x = _number(row.get("fixation_center_x"))
            raw_y = _number(row.get("fixation_center_y"))
            candidate = _point_to_pixels(raw_x, raw_y, width, height, centered)
            if candidate is not None:
                center = candidate
                center_raw = (raw_x, raw_y)
                break
        event["center"] = center
        event["center_raw"] = center_raw
        return

    end_ms = event["end_ms"]
    if next_event is not None and next_event["start_ms"] > event["start_ms"]:
        end_ms = next_event["start_ms"]
    event["duration_ms"] = max(0.0, end_ms - event["start_ms"])
    px_velocities = [value for value in event["px_velocities"] if value is not None and value >= 0]
    deg_velocities = [value for value in event["deg_velocities"] if value is not None and value >= 0]
    event["average_velocity_px_ms"] = sum(px_velocities) / len(px_velocities) if px_velocities else None
    event["peak_velocity_px_ms"] = max(px_velocities) if px_velocities else None
    event["average_velocity_deg_ms"] = sum(deg_velocities) / len(deg_velocities) if deg_velocities else None
    event["peak_velocity_deg_ms"] = max(deg_velocities) if deg_velocities else None


def _is_valid_fixation_event(event, width, height, centered):
    duration_ms = event.get("duration_ms")
    center_raw = event.get("center_raw")
    if duration_ms is None or duration_ms <= 0 or center_raw is None:
        return False
    x, y = center_raw
    if centered:
        px = x + width * 0.5
        py = y + height * 0.5
    elif -0.001 <= x <= 1.001 and -0.001 <= y <= 1.001:
        px = x * width
        py = y * height
    else:
        px, py = x, y
    return 0.0 <= px <= float(width) and 0.0 <= py <= float(height)


def postprocess_eye_event_csv(csv_path, frame_width, frame_height, is_glasses_mode=False):
    """Rewrite a completed sample CSV with SDK-style fixation/saccade event columns."""
    source = Path(csv_path)
    width = max(1, int(frame_width or 1280))
    height = max(1, int(frame_height or 720))
    centered = bool(is_glasses_mode)

    with source.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        original_headers = list(reader.fieldnames or [])
        rows = list(reader)
    if not rows or "fixation_state" not in original_headers:
        return {"ok": True, "rows": len(rows), "fixations": 0, "saccades": 0, "skipped": True}

    events = []
    current = None
    previous_time = None
    previous_gaze = None
    previous_direction = None
    for index, row in enumerate(rows):
        timestamp = _number(row.get("video_time_ms"))
        if timestamp is None:
            timestamp = _number(row.get("timestamp"))
        timestamp = timestamp if timestamp is not None else (previous_time if previous_time is not None else 0.0)
        gaze = _row_gaze_pixels(row, width, height, centered)
        direction = _normalized_vector(row)
        dt = timestamp - previous_time if previous_time is not None else None
        velocity_px = None
        velocity_deg = None
        if dt is not None and dt > 0:
            if gaze is not None and previous_gaze is not None:
                velocity_px = math.hypot(gaze[0] - previous_gaze[0], gaze[1] - previous_gaze[1]) / dt
            angle = _angle_degrees(previous_direction, direction)
            if angle is not None:
                velocity_deg = angle / dt
        row["__gaze_velocity_px_ms"] = velocity_px
        row["__gaze_velocity_deg_ms"] = velocity_deg
        kind = _event_kind(row)
        if kind != (current["kind"] if current else None):
            if current is not None:
                events.append(current)
            current = None
            if kind is not None:
                current = {
                    "kind": kind,
                    "start": index,
                    "end": index,
                    "start_ms": timestamp,
                    "end_ms": timestamp,
                    "rows": [row],
                    "px_velocities": [velocity_px],
                    "deg_velocities": [velocity_deg],
                }
        elif current is not None:
            current["end"] = index
            current["end_ms"] = timestamp
            current["rows"].append(row)
            current["px_velocities"].append(velocity_px)
            current["deg_velocities"].append(velocity_deg)
        previous_time = timestamp
        if gaze is not None:
            previous_gaze = gaze
        if direction is not None:
            previous_direction = direction
    if current is not None:
        events.append(current)

    fixation_index = 0
    for event_index, event in enumerate(events):
        next_event = events[event_index + 1] if event_index + 1 < len(events) else None
        _finalize_event(event, next_event, width, height, centered)
        if event["kind"] == "fixation":
            event["valid"] = _is_valid_fixation_event(event, width, height, centered)
            if event["valid"]:
                fixation_index += 1
                event["index"] = fixation_index

    previous_fixation = None
    pending_saccades = []
    saccade_index = 0
    for event in events:
        if event["kind"] == "saccade":
            # SDK-style saccades connect from a completed fixation. Motion before
            # the first fixation remains unclassified instead of consuming index 1.
            event["valid"] = previous_fixation is not None
            if event["valid"]:
                saccade_index += 1
                event["index"] = saccade_index
                pending_saccades.append(event)
            continue
        if event.get("valid") is not True:
            continue
        if previous_fixation is not None and event.get("center") is not None:
            for saccade in pending_saccades:
                if previous_fixation.get("center") is not None:
                    dx = event["center"][0] - previous_fixation["center"][0]
                    dy = event["center"][1] - previous_fixation["center"][1]
                    saccade["distance_px"] = math.hypot(dx, dy)
                    first_vector = _normalized_vector(previous_fixation["rows"][-1])
                    second_vector = _normalized_vector(event["rows"][0])
                    saccade["distance_deg"] = _angle_degrees(first_vector, second_vector)
        pending_saccades = []
        previous_fixation = event

    event_by_row = {}
    for event in events:
        if event.get("valid") is not True:
            continue
        for index in range(event["start"], event["end"] + 1):
            event_by_row[index] = event

    headers = list(original_headers)
    for header in RAW_BACKUP_COLUMNS + EVENT_COLUMNS + [
        "saccade_distance_deg",
        "average_saccade_velocity_deg_ms",
        "peak_saccade_velocity_deg_ms",
    ]:
        if header not in headers:
            headers.append(header)

    temp_path = source.with_name(f".{source.name}.{os.getpid()}.events.tmp")
    try:
        with temp_path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=headers, extrasaction="ignore")
            writer.writeheader()
            for index, row in enumerate(rows):
                event = event_by_row.get(index)
                row["sdk_fixation_sample_count"] = row.get("fixation_count", "")
                row["sdk_fixation_duration_ms_raw"] = row.get("fixation_duration_ms", "")
                row["sdk_fixation_duration_us_raw"] = row.get("fixation_duration_us", "")
                row["sdk_fixation_center_x_raw"] = row.get("fixation_center_x", "")
                row["sdk_fixation_center_y_raw"] = row.get("fixation_center_y", "")
                for header in EVENT_COLUMNS + ["saccade_distance_deg", "average_saccade_velocity_deg_ms", "peak_saccade_velocity_deg_ms"]:
                    row[header] = ""
                row["gaze_velocity_px_ms"] = _format(row.pop("__gaze_velocity_px_ms", None))
                row["gaze_velocity_deg_ms"] = _format(row.pop("__gaze_velocity_deg_ms", None))
                if event is None:
                    for header in ("fixation_timestamp", "fixation_duration", "fixation_timestamp_us", "fixation_duration_us", "fixation_timestamp_ms", "fixation_duration_ms", "fixation_count", "fixation_center_x", "fixation_center_y"):
                        row[header] = ""
                elif event["kind"] == "fixation":
                    center = event.get("center")
                    center_raw = event.get("center_raw")
                    row["fixation_index"] = str(event["index"])
                    row["fixation_count"] = str(event["index"])
                    row["fixation_duration"] = _format(event.get("duration_ms"))
                    row["fixation_duration_ms"] = _format(event.get("duration_ms"))
                    row["fixation_duration_us"] = _format(event.get("duration_ms") * 1000.0 if event.get("duration_ms") is not None else None)
                    if event.get("fixation_timestamp_ms") is not None:
                        row["fixation_timestamp"] = _format(event.get("fixation_timestamp_ms"))
                        row["fixation_timestamp_ms"] = _format(event.get("fixation_timestamp_ms"))
                    if event.get("fixation_timestamp_us") is not None:
                        row["fixation_timestamp_us"] = _format(event.get("fixation_timestamp_us"))
                    row["fixation_point_x_px"] = _format(center[0] if center else None)
                    row["fixation_point_y_px"] = _format(center[1] if center else None)
                    if center_raw:
                        row["fixation_center_x"] = _format(center_raw[0])
                        row["fixation_center_y"] = _format(center_raw[1])
                else:
                    for header in ("fixation_timestamp", "fixation_duration", "fixation_timestamp_us", "fixation_duration_us", "fixation_timestamp_ms", "fixation_duration_ms", "fixation_count", "fixation_center_x", "fixation_center_y"):
                        row[header] = ""
                    row["saccade_index"] = str(event["index"])
                    row["saccade_duration_ms"] = _format(event.get("duration_ms"))
                    row["saccade_distance_px"] = _format(event.get("distance_px"))
                    row["average_saccade_velocity_px_ms"] = _format(event.get("average_velocity_px_ms"))
                    row["peak_saccade_velocity_px_ms"] = _format(event.get("peak_velocity_px_ms"))
                    row["saccade_distance_deg"] = _format(event.get("distance_deg"))
                    row["average_saccade_velocity_deg_ms"] = _format(event.get("average_velocity_deg_ms"))
                    row["peak_saccade_velocity_deg_ms"] = _format(event.get("peak_velocity_deg_ms"))
                writer.writerow(row)
        os.replace(str(temp_path), str(source))
    finally:
        if temp_path.exists():
            try:
                temp_path.unlink()
            except Exception:
                pass
    return {"ok": True, "rows": len(rows), "fixations": fixation_index, "saccades": saccade_index, "skipped": False}
