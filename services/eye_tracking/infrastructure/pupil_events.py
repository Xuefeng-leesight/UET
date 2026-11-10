"""Capture online events: merge overlapping same-ID fixation windows once.

Original notifications remain in the journal. Capture/legacy merged fixations
retain the last reported window centroid. Native algorithm v3 emits an explicit
whole-interval centroid only on observed completion; that final result is used.
"""
import csv
from bisect import bisect_left, bisect_right
from contextlib import closing
import json
import math
import os
from pathlib import Path
import sqlite3
import tempfile

from .pupil_csv import CSV_FIELDS


def event_provenance(row, event, *, start_s=None, duration_ms=None, clipped=False):
    identity = event['identity']
    backend = ('native' if event['native'] else 'capture') if 'native' in event else (
        'native' if event['kind'] == 'saccade' else 'legacy_unspecified')
    if event['kind'] == 'fixation':
        completion = ('complete_interval' if event.get('complete') is True else
                      'incomplete:' + (event.get('completion_reason') or 'online_window')
                      if event.get('complete') is False else 'legacy_completion_unknown')
    else:
        completion = 'phase' if event['kind'] == 'blink' else 'complete_interval'
    row.update(source_backend=backend, source_timestamp_s=identity['source_time_s'],
               source_receive_sequence=identity['received_sequence'],
               source_event_algorithm=event.get('algorithm') or 'legacy_unspecified',
               source_event_algorithm_version=event.get('algorithm_version', ''),
               source_event_algorithm_parameters=json.dumps(event.get('algorithm_parameters'), sort_keys=True, separators=(',', ':'))
               if event.get('algorithm_parameters') else '',
               source_event_start_timestamp_s=start_s if start_s is not None else identity['source_time_s'],
               source_event_duration_ms=duration_ms if duration_ms is not None else event.get('duration_ms') or '',
               source_event_clipped=int(clipped), source_event_completion=completion,
               source_coordinate_space='world_normalized_bottom_left',
               gaze_coordinate_space='world_normalized_top_left')


def event_rows(spool, t0, duration):
    fixations = {}
    blinks = []
    saccades = []
    count = 0
    for line in spool:
        if not line.endswith("\n"):
            break
        event = json.loads(line)
        count += 1
        if not event["valid"]:
            continue
        timestamp = (event["identity"]["source_time_s"] - t0) * 1000
        if event["kind"] == "blink":
            blinks.append((timestamp, event))
        elif event['kind'] == 'saccade':
            saccades.append((timestamp, event))
        else:
            key = (event["identity"]["generation"], event["event_id"])
            end = timestamp + event["duration_ms"]
            prior = fixations.get(key)
            if prior is not None and timestamp > prior["end"] + 1:
                raise ValueError("Capture reused a fixation ID for disjoint intervals")
            fixations[key] = {"start": min(timestamp, prior["start"]) if prior else timestamp,
                              "end": max(end, prior["end"]) if prior else end, "event": event}
        if len(fixations) + len(blinks) + len(saccades) > 100000:
            raise ValueError("Eye event count limit exceeded")
    rows = []
    for index, item in enumerate(sorted(fixations.values(), key=lambda item: item["start"]), 1):
        start, end = max(0, item["start"]), min(duration * 1000, item["end"])
        if end <= start:
            continue
        event = item["event"]
        clipped = start != item['start'] or end != item['end']
        row = dict.fromkeys(CSV_FIELDS, "")
        row.update(timestamp=start, video_time_ms=start, source_model="PupilCore", recom_gaze_bit_mask=0,
                   source_event_type="fixation", source_event_id=event["event_id"],
                   fixation_state=3 if event.get('complete') is False or clipped else 4,
                   fixation_index=index, fixation_timestamp_ms=start, fixation_duration_ms=end-start,
                   fixation_center_x=event["position"][0], fixation_center_y=1-event["position"][1],
                   source_topic=event["identity"]["topic"], source_generation=event["identity"]["generation"],
                   pupil_confidence=event["confidence"])
        event_provenance(row, event, start_s=t0 + item['start'] / 1000,
                         duration_ms=item['end'] - item['start'], clipped=clipped)
        row.update(event.get('metrics', {}))
        rows.append(row)
    fixation_rows = [row for row in rows if row['fixation_state'] == 4]
    ended = sorted(fixation_rows, key=lambda f: f['fixation_timestamp_ms'] + f['fixation_duration_ms'])
    end_times = [f['fixation_timestamp_ms'] + f['fixation_duration_ms'] for f in ended]
    start_times = [f['fixation_timestamp_ms'] for f in fixation_rows]
    for timestamp, event in saccades:
        # Metrics describe the complete detected interval. Never clip duration
        # while retaining amplitudes measured outside the actual video.
        if timestamp < 0 or timestamp + event['duration_ms'] > duration * 1000:
            continue
        row = dict.fromkeys(CSV_FIELDS, '')
        row.update(timestamp=timestamp, video_time_ms=timestamp, source_model='PupilCore',
                   source_backend='native', source_event_type='saccade', source_event_id=event['event_id'],
                   source_topic='saccades', source_generation=event['identity']['generation'],
                   recom_gaze_bit_mask=0, saccade_index=event['event_id'],
                   fixation_state=2, fixation_center_x=event['position'][0], fixation_center_y=1-event['position'][1],
                   saccade_duration_ms=event['duration_ms'], pupil_confidence=event['confidence'],
                   **event.get('metrics', {}))
        event_provenance(row, event)
        # The existing export headers define amplitude BETWEEN FIXATIONS,
        # which differs from the I-VT interval's endpoint displacement.
        before_index = bisect_right(end_times, timestamp + 1) - 1
        before = ended[before_index] if before_index >= 0 else None
        end = timestamp + event['duration_ms']
        after_index = bisect_left(start_times, end - 1)
        after = fixation_rows[after_index] if after_index < len(fixation_rows) else None
        if (before and after and timestamp - before['fixation_timestamp_ms'] - before['fixation_duration_ms'] <= 100
                and after['fixation_timestamp_ms'] - end <= 100
                and before['source_generation'] == after['source_generation'] == event['identity']['generation']):
            points = [[f.get(f'fixation_point_{axis}_px') for axis in 'xy'] for f in (before, after)]
            directions = [[f.get(f'fixation_direction_{axis}') for axis in 'xyz'] for f in (before, after)]
            if all(type(v) in (float, int) for p in points for v in p):
                row['saccade_distance_px'] = math.dist(*points)
            if all(type(v) in (float, int) for p in directions for v in p):
                row['saccade_distance_deg'] = math.degrees(math.acos(max(-1, min(1, sum(a*b for a, b in zip(*directions))))))
        rows.append(row)
    # Match in SOURCE time, per connection. Missing phases stay explicitly
    # unpaired; they never turn all subsequent gaze rows into a blink state.
    groups = []
    # Per-eye native streams must never pair a right onset with a left offset.
    for timestamp, event in sorted(blinks, key=lambda item: (item[1].get('eye') or '', item[0])):
        generation = event["identity"]["generation"]
        eye = event.get('eye')
        session = event.get('event_id')
        if groups and groups[-1]["phase"] == event["phase"] and groups[-1]["generation"] == generation and groups[-1]['eye'] == eye and groups[-1]['session'] == session:
            continue
        groups.append({"timestamp": timestamp, "event": event, "phase": event["phase"], "generation": generation, 'eye': eye, 'session': session})
    pairs = 0
    for index, group in enumerate(groups):
        if group["phase"] == "onset" and index + 1 < len(groups):
            end = groups[index + 1]
            if (end["phase"] == "offset" and end["generation"] == group["generation"] and end['eye'] == group['eye'] and end['session'] == group['session'] and
                    0 <= group["timestamp"] < end["timestamp"] < duration * 1000):
                pairs += 1
                group["pair"] = end["pair"] = pairs
                group['duration'] = end['timestamp'] - group['timestamp']
    # Pair within each eye, then number all pairs by onset time.
    chronological = sorted((g for g in groups if g.get('pair') and g['phase'] == 'onset'), key=lambda g: g['timestamp'])
    pair_ids = {g['pair']: index for index, g in enumerate(chronological, 1)}
    for group in groups:
        if group.get('pair'):
            group['pair'] = pair_ids[group['pair']]
        timestamp, phase, event = group["timestamp"], group["phase"], group["event"]
        if not 0 <= timestamp < duration * 1000:
            continue
        row = dict.fromkeys(CSV_FIELDS, "")
        row.update(timestamp=timestamp, video_time_ms=timestamp, source_model="PupilCore",
                   source_event_type="blink", blink=int(phase == "onset"), blink_phase=phase, recom_gaze_bit_mask=0,
                   blink_pair_status="paired" if group.get("pair") else "unpaired_" + phase,
                   blink_pair_id=group.get("pair", ""), pupil_confidence=event["confidence"],
                   source_timestamp_s=event["identity"]["source_time_s"], source_topic=event["identity"]["topic"],
                   source_generation=event["identity"]["generation"])
        event_provenance(row, event)
        if group['eye'] is not None:
            row[f"{group['eye']}_blink"] = int(phase == 'onset')
            row['blink_marker'] = 1 if group['eye'] == 'left' else 2
        if group.get('pair') and phase == 'onset':
            row['blink_index'] = group['pair']
            row['blink_duration_ms'] = group['duration']
        rows.append(row)
    return sorted(rows, key=lambda row: row["video_time_ms"]), {"sourceEventMessages": count,
        "fixationEvents": sum(row["source_event_type"] == "fixation" for row in rows),
        "completedFixationEvents": sum(row['source_event_type'] == 'fixation' and row['fixation_state'] == 4 for row in rows),
        "incompleteFixationEvents": sum(row['source_event_type'] == 'fixation' and row['fixation_state'] == 3 for row in rows),
        "blinkOnsets": pairs,
        "blinkUnpairedPhases": sum(row["source_event_type"] == "blink" and row["blink_pair_status"] != "paired" for row in rows),
        "blinkConfidenceSemantics": "source event confidence retained; count complete source-time onset/offset pairs, per eye where supplied",
        "fixationPositionSemantics": "native v3 complete: unique full-interval sample mean; online/incomplete/legacy: last source window centroid; see row algorithm parameters",
        "saccadeEvents": sum(row['source_event_type'] == 'saccade' for row in rows),
        "eventAvailability": "observed" if count else "not observed"}


def append_events(spool_path, csv_file, t0, duration):
    if not spool_path.exists():
        return {}
    if spool_path.is_symlink():
        raise ValueError("Eye event journal must not be a symbolic link")
    with spool_path.open(encoding="utf-8") as source:
        rows, metadata = event_rows(source, t0, duration)
    csv.DictWriter(csv_file, fieldnames=CSV_FIELDS).writerows(rows)
    return metadata


def order_csv(csv_file, sidecar):
    """Disk-backed chronological merge, so long recordings don't grow RAM.

The existing time-block index requires chronological rows. Event/marker rows
must not be appended behind hours of gaze. Blink state is only attributed to
real gaze rows, with no invented eye/position when gaze is absent.
"""
    # A real UDP payload can expand past the csv module's 128 KiB default when
    # encoded as a single-line JSON envelope (for example control-byte text).
    csv.field_size_limit(max(csv.field_size_limit(), 1048576))
    fd, database_path = tempfile.mkstemp(prefix="csv-order-", suffix=".sqlite", dir=sidecar)
    os.close(fd)
    try:
        with closing(sqlite3.connect(database_path)) as database:
            database.execute("PRAGMA journal_mode=OFF")
            database.execute("PRAGMA temp_store=FILE")
            database.execute("CREATE TABLE rows (time REAL, sequence INTEGER, data TEXT)")
            csv_file.flush()
            csv_file.seek(0)
            for sequence, row in enumerate(csv.DictReader(csv_file)):
                database.execute("INSERT INTO rows VALUES (?, ?, ?)",
                                 (float(row["video_time_ms"]), sequence, json.dumps(row)))
            database.commit()
            csv_file.seek(0)
            csv_file.truncate()
            writer = csv.DictWriter(csv_file, fieldnames=CSV_FIELDS)
            writer.writeheader()
            blink_state = None
            native_blinks = {}
            stimulus = ""
            for (raw,) in database.execute("SELECT data FROM rows ORDER BY time, sequence"):
                row = json.loads(raw)
                if row["source_event_type"] == "blink":
                    if row.get('blink_marker') in ('1', '2'):
                        eye = 'left' if row['blink_marker'] == '1' else 'right'
                        native_blinks[eye] = row['blink'] if row['blink_pair_status'] == 'paired' else None
                    else:
                        blink_state = row["blink"] if row["blink_pair_status"] == "paired" else None
                if row["source_event_type"]:
                    row["stimulus"] = stimulus
                else:
                    stimulus = row["stimulus"]
                    if blink_state is not None:
                        row["blink"] = blink_state
                    for eye, value in native_blinks.items():
                        if value is not None:
                            row[f'{eye}_blink'] = value
                    known = [v for v in native_blinks.values() if v is not None]
                    if known:
                        row['blink'] = int('1' in known)
                writer.writerow(row)
            csv_file.flush()
            os.fsync(csv_file.fileno())
    finally:
        Path(database_path).unlink(missing_ok=True)
