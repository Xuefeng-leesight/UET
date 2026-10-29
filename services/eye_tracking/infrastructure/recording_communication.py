"""Durable communication events from the actual I/O owner, separate from gaze/markers."""
import csv
import base64
import json
import math
from pathlib import Path
import re

from .pupil_csv import CSV_FIELDS

COMMUNICATION_CHANNELS = ('udp_send', 'udp_receive', 'trigger_send', 'trigger_receive')


def communication_capture_status(directory, recording_id, generation):
    """Report I/O capture failures without preventing recovery of saved data."""
    path = Path(directory) / 'communication-capture-status.json'
    if not path.exists() and not path.is_symlink():
        return {}  # Communication capture was not enabled in historical recordings.
    try:
        if path.is_symlink() or path.stat().st_size > 1024 * 1024:
            raise ValueError('Unsafe communication capture status')
        value = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(value, dict) or value.get('recording_id') != recording_id or type(value.get('generation')) is not int or value['generation'] != generation:
            raise ValueError('Communication capture status belongs to another recording or connection')
        status, errors, uncertainty = value.get('status'), value.get('errors'), value.get('clock_uncertainty_ms')
        if status not in ('recording', 'stopped', 'error') or not isinstance(errors, list) or any(not isinstance(error, str) for error in errors):
            raise ValueError('Invalid communication capture status')
        if type(uncertainty) not in (int, float) or not math.isfinite(uncertainty) or uncertainty < 0:
            raise ValueError('Invalid communication capture clock uncertainty')
        issues = [error for error in errors if error]
        if status == 'recording':
            issues.insert(0, 'Communication capture did not close normally; trailing communication events may be missing')
        elif status == 'error' and not issues:
            issues.append('Communication capture reported an I/O failure')
        return {'communicationCaptureStatus': status, 'communicationCaptureErrors': issues,
                'communicationClockUncertaintyMs': uncertainty}
    except (OSError, ValueError, UnicodeError) as exc:
        return {'communicationCaptureStatus': 'invalid', 'communicationCaptureErrors': [str(exc)]}


def validate_communication(event, recording_id, generation):
    if not isinstance(event, dict):
        raise ValueError('Communication event must be an object')
    if event.get('recording_id') != recording_id or type(event.get('generation')) is not int or event['generation'] != generation:
        raise ValueError('Communication event belongs to another recording or connection')
    event_id, channel, text = event.get('event_id'), event.get('channel'), event.get('text')
    if not isinstance(event_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', event_id):
        raise ValueError('Invalid communication event id')
    if channel not in COMMUNICATION_CHANNELS:
        raise ValueError('Invalid communication channel')
    if not isinstance(text, str) or '\n' in text or '\r' in text or len(text) > 400000:
        raise ValueError('Communication text must be a single-line JSON envelope')
    try:
        envelope = json.loads(text)
        if not isinstance(envelope, dict) or set(envelope) != {'encoding', 'data'} or not isinstance(envelope['data'], str):
            raise ValueError('Invalid communication payload envelope')
        if envelope['encoding'] == 'utf-8':
            payload = envelope['data'].encode('utf-8', errors='strict')
        elif envelope['encoding'] == 'base64':
            payload = base64.b64decode(envelope['data'], validate=True)
            if base64.b64encode(payload).decode('ascii') != envelope['data']:
                raise ValueError('Communication base64 must be canonical')
        else:
            raise ValueError('Unsupported communication payload encoding')
        if len(payload) > 65536:
            raise ValueError('Communication payload exceeds 65536 bytes')
    except (ValueError, TypeError, UnicodeError) as exc:
        raise ValueError(f'Invalid communication payload envelope: {exc}') from exc
    stamp = event.get('video_time_ms')
    if type(stamp) not in (float, int) or not math.isfinite(stamp) or not 0 <= stamp <= 86400000:
        raise ValueError('Invalid communication video time')
    return {'recording_id': recording_id, 'generation': generation, 'event_id': event_id,
            'channel': channel, 'text': text, 'video_time_ms': stamp}


def append_communications(path, output, duration, recording_id, generation, source_origin_s, source_model='PupilCore'):
    path = Path(path)
    counts = {'communicationEvents': 0, 'communicationOutsideVideo': 0}
    counts.update(communication_capture_status(path.parent, recording_id, generation))
    writer = csv.DictWriter(output, fieldnames=CSV_FIELDS)
    seen = {}
    def entries():
        # Main owns the actual I/O journal; Python owns acknowledged events.
        # A command disconnect must not discard a durably captured packet.
        for journal_path in (path, path.with_name('communication-capture.jsonl')):
            if journal_path.is_symlink():
                raise ValueError('Communication journal must not be a symbolic link')
            if not journal_path.exists():
                continue  # Historical recordings have neither journal.
            with journal_path.open(encoding='utf-8') as journal:
                yield from journal
    for line in entries():
        if not line.endswith('\n'):
            continue  # Only a torn final record of either journal is ignored.
        event = validate_communication(json.loads(line), recording_id, generation)
        event_id = event['event_id']
        if event_id in seen:
            if event != seen[event_id]:
                raise ValueError('Conflicting communication event id in journal')
            continue
        seen[event_id] = event
        stamp = event['video_time_ms']
        if not 0 <= stamp < duration * 1000:
            counts['communicationOutsideVideo'] += 1
            continue
        row = dict.fromkeys(CSV_FIELDS, '')
        row.update(timestamp=stamp, video_time_ms=stamp, source_model=source_model,
                   source_event_type='communication', source_event_id=event_id,
                   source_generation=generation, source_timestamp_s=source_origin_s + stamp / 1000,
                   communication_recording_id=recording_id, communication_channel=event['channel'],
                   communication_text_encoding='json_envelope')
        row[event['channel']] = event['text']
        writer.writerow(row)
        counts['communicationEvents'] += 1
    return counts
