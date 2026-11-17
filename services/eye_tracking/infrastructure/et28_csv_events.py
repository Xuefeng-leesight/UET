"""Write completed ET28 events on the recording timeline."""

from collections import Counter
import csv
import json

from .pupil_csv import CSV_FIELDS


def _event_fields(kind, event, index, start_ms, duration_ms, width, height):
    if kind == 'fixation':
        x, y = event['centroid']
        fields = dict(fixation_state=4, fixation_index=index,
                      fixation_timestamp_ms=start_ms, fixation_duration_ms=duration_ms)
        if x is not None and y is not None and 0 <= x < width and 0 <= y < height:
            fields.update(fixation_center_x=x / width, fixation_center_y=y / height,
                          fixation_point_x_px=x, fixation_point_y_px=y)
        return fields
    if kind == 'saccade':
        fields = dict(fixation_state=2, saccade_index=index, saccade_duration_ms=duration_ms)
        for key, raw_key, divisor in (
            ('saccade_endpoint_distance_px', 'amplitude', 1),
            ('saccade_endpoint_distance_deg', 'amplitudeDeg', 1),
            ('average_saccade_velocity_px_ms', 'meanVelocity', 1000),
            ('average_saccade_velocity_deg_ms', 'meanVelocityDeg', 1000),
            ('peak_saccade_velocity_px_ms', 'peakVelocity', 1000),
            ('peak_saccade_velocity_deg_ms', 'peakVelocityDeg', 1000),
        ):
            value = event.get(raw_key)
            if value is not None and value >= 0:
                fields[key] = value / divisor
        for phase in ('start', 'end'):
            point = event[phase]
            x, y = point['point']
            if point['valid'] and x is not None and y is not None and 0 <= x < width and 0 <= y < height:
                fields.update({f'saccade_{phase}_x': x / width, f'saccade_{phase}_y': y / height})
        return fields
    return {}


def _reported_events(row):
    events = json.loads(row.get('et28_gaze_events') or '{}')
    for kind, event in events.items():
        if kind == 'invalid':
            start, end = event['startTimeStamp'], event['endTimeStamp']
        else:
            start, end = event['start']['timeStamp'], event['end']['timeStamp']
        yield kind, '', event, row['left_et28_device_timestamp'], start, end
    for eye in ('left', 'right'):
        raw = row.get(f'{eye}_et28_blink_event')
        if raw:
            blink = json.loads(raw)
            yield 'blink', eye, blink, row[f'{eye}_et28_device_timestamp'], blink['startTimeStamp'], blink['endTimeStamp']


def append_et28_events(spool, output, t0, duration):
    # Match the device clock to host time at the reporting callback. Using the
    # callback's video time directly would shift completed events by ~400 ms.
    spool.seek(0)
    writer = csv.DictWriter(output, fieldnames=CSV_FIELDS)
    seen = set()
    counts = Counter()
    for line in spool:
        if not line.endswith('\n'):
            break
        sample = json.loads(line)
        for kind, eye, event, device_time, start, end in _reported_events(sample):
            if not 0 < start < end <= device_time:
                continue
            duration_ms = end - start
            end_ms = sample['video_time_ms'] - (device_time - end)
            start_ms = end_ms - duration_ms
            if start_ms < 0 or end_ms >= duration * 1000:
                continue
            key = (sample['source_generation'], kind, eye, start, end)
            if key in seen:
                continue
            seen.add(key)
            counts[kind] += 1
            index = counts[kind]
            row = dict(source_model='HH_ET28', source_backend='huahong_sdk', source_event_algorithm='huahong_et28_sdk',
                       source_event_type=kind, source_event_id=index, source_event_duration_ms=duration_ms,
                       source_event_start_timestamp_s=t0 + start_ms / 1000, source_event_clipped=0,
                       source_event_completion='complete_interval',
                       source_generation=sample['source_generation'], source_topic=sample['source_topic'],
                       source_receive_sequence=sample['source_receive_sequence'], source_timestamp_s=sample['source_timestamp_s'],
                       timestamp=start_ms, video_time_ms=start_ms, recom_gaze_bit_mask=0,
                       source_coordinate_space='world_normalized_top_left', gaze_coordinate_space='world_normalized_top_left')
            if kind == 'blink':
                row.update(blink=1, blink_phase='onset', blink_pair_id=index, blink_pair_status='paired',
                           blink_marker=1 if eye == 'left' else 2, blink_index=index, blink_duration_ms=duration_ms)
                row[f'{eye}_blink'] = 1
                writer.writerow(row)
                row.update(blink=0, blink_phase='offset', blink_index='', blink_duration_ms='',
                           timestamp=end_ms, video_time_ms=end_ms)
                row[f'{eye}_blink'] = 0
            else:
                row.update(_event_fields(kind, event, index, start_ms, duration_ms,
                                         sample['world_image_width'], sample['world_image_height']))
            writer.writerow(row)
    return dict(sourceEventMessages=sum(counts.values()), fixationEvents=counts['fixation'],
                completedFixationEvents=counts['fixation'], saccadeEvents=counts['saccade'],
                blinkOnsets=counts['blink'], invalidGazeEvents=counts['invalid'],
                eventAvailability='observed' if counts else 'not observed')
