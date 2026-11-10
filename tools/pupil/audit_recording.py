"""Read-only native recording audit. Outputs go to a new, separate directory.

Replay consistency is not independent accuracy. Original gaze is never corrected.
"""
import argparse
from collections import Counter, defaultdict
import csv
from fractions import Fraction
import json
import math
from pathlib import Path
import subprocess

import msgpack
import numpy as np

from tools.pupil.rebuild_recording import rebuild, digest
from services.eye_tracking.adapters.pupil_native.gazer import NativeGazer, matched_calibration


def number(value):
    if value in ('', None):
        return None
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (ValueError, TypeError):
        return None


def equivalent(a, b):
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(equivalent(a[k], b[k]) for k in a)
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        return len(a) == len(b) and all(equivalent(x, y) for x, y in zip(a, b))
    if a in ('', None) or b in ('', None):
        return a in ('', None) and b in ('', None)
    x, y = number(a), number(b)
    return math.isclose(x, y, rel_tol=0, abs_tol=1e-8) if x is not None and y is not None else a == b


def json_lines(path):
    with path.open(encoding='utf-8') as stream:
        for line in stream:
            if not line.endswith('\n'):
                raise ValueError(f'Truncated JSONL: {path}')
            yield json.loads(line)


def rows(path):
    with path.open(encoding='utf-8-sig', newline='') as stream:
        return list(csv.DictReader(stream))


def write_csv(path, values, fields=None):
    values = list(values)
    with path.open('x', encoding='utf-8-sig', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=fields or list(values[0]))
        writer.writeheader()
        writer.writerows(values)


def stats(values):
    values = list(values)
    if not values:
        return {'count': 0}
    return dict(count=len(values), mean=float(np.mean(values)), median=float(np.median(values)),
                p95=float(np.percentile(values, 95)), maximum=float(max(values)), minimum=float(min(values)))


def kind(row):
    return row.get('source_event_type') or 'gaze'


def row_key(row):
    if kind(row) == 'gaze':
        return ('gaze', row['source_generation'], row['source_receive_sequence'])
    return (kind(row), row['source_generation'], row['source_event_id'],
            row['video_time_ms'], row['blink_phase'], row['blink_marker'])


def applicable(field, row):
    k = kind(row)
    if field == 'gaze_invalid_reason':
        return k == 'gaze' and row.get('pupil_valid') != '1'
    if field in ('blink_duration_ms', 'blink_index'):
        return k == 'blink' and row.get('blink_pair_status') == 'paired' and row.get('blink_phase') == 'onset'
    if field in ('left_blink', 'right_blink'):
        return k == 'gaze' or (k == 'blink' and row.get('blink_marker') == ('1' if field == 'left_blink' else '2'))
    if field in ('timestamp', 'video_time_ms', 'source_model', 'source_topic', 'source_generation',
                 'recom_gaze_bit_mask', 'pupil_confidence', 'stimulus'):
        return True
    if field in ('source_event_type', 'source_event_id'):
        return k != 'gaze' and (field != 'source_event_id' or k != 'blink')
    if field in ('blink', 'left_blink', 'right_blink'):
        return k in ('blink', 'gaze')
    if field.startswith('blink_'):
        return k == 'blink'
    if field == 'fixation_state' or field.startswith('fixation_center_'):
        return k in ('fixation', 'saccade')
    if field.startswith('fixation_'):
        return k == 'fixation'
    if field.startswith(('saccade_', 'average_saccade_', 'peak_saccade_')):
        return k == 'saccade'
    if field == 'source_timestamp_s':
        return k in ('gaze', 'blink')
    return k == 'gaze'


def blank_reason(field, row, expected, raw):
    if expected not in ('', None):
        return '转换或保存缺失'
    if 'smooth_point' in field:
        return '未实现独立平滑测量'
    if field in ('stimulus', 'triggerMark', 'customMarker'):
        return '本次未设置或未触发'
    if 'blink' in field:
        return '无已配对该眼眨眼状态或非适用阶段'
    if field in ('saccade_distance_px', 'saccade_distance_deg'):
        return '缺少满足时间条件的前后注视事件'
    if kind(row) != 'gaze':
        return '事件无对应测量'
    if field.startswith(('left_pupil_', 'right_pupil_')):
        eye = 1 if field.startswith('left') else 0
        contributors = [p for p in (raw or {}).get('base_data', []) if p.get('id') == eye]
        if not contributors:
            return '原始消息无该眼贡献'
        if contributors[0].get('confidence', 0) < .6:
            return '该眼置信度过滤'
        if field.endswith(('diameter_px', 'pupil_diameter', 'minor_axis')) and contributors[0].get('diameter') == 0:
            return '原始2D检测直径为零，未用3D投影伪填'
        return '原始属性缺失或模型质量过滤'
    if field.startswith(('left_', 'right_')):
        if row.get('pupil_valid') != '1':
            return '融合样本无效导致几何输出过滤'
        eye = '1' if field.startswith('left') else '0'
        single = (raw or {}).get('monocular', {}).get(eye)
        if single and any(not 0 <= v <= 1 for v in single.get('norm_pos', [])):
            return '原单眼投影超出场景范围'
        return '单眼模型无有效投影或质量过滤'
    if field in ('gaze_velocity_px_ms', 'gaze_velocity_deg_ms'):
        return '缺少连续有效前样本或几何方向'
    if row.get('pupil_valid') != '1':
        return '无效注视:' + row.get('gaze_invalid_reason', '')
    return '未归因，需人工复核'


def longest_blank_run(scope, field, end_ms):
    start = None
    longest = 0.
    for row in scope:
        t = number(row['video_time_ms'])
        if row.get(field) in ('', None):
            if start is None:
                start = t
        elif start is not None:
            longest, start = max(longest, t - start), None
    return max(longest, end_ms - start) if start is not None else longest


TEXT_FIELDS = {'source_topic', 'source_model', 'source_backend', 'geometry_space', 'pupil_center_space',
               'source_event_type', 'gaze_invalid_reason', 'gaze_model_quality', 'pupil_pairing',
               'left_pupil_model_quality', 'right_pupil_model_quality', 'blink_phase', 'blink_pair_status',
               'stimulus', 'triggerMark', 'customMarker'}


def value_problem(field, value):
    """Contract checks, not a claim that a measurement is scientifically accurate."""
    if value in ('', None) or field in TEXT_FIELDS:
        return None
    n = number(value)
    if n is None:
        return '非有限数值'
    normalized = {f'{eye}_gaze_{axis}' for eye in ('recom', 'left', 'right') for axis in 'xy'}
    normalized.update(f'{prefix}_{axis}' for prefix in ('fixation_center', 'saccade_start', 'saccade_end') for axis in 'xy')
    if (field in normalized or field.endswith(('_confidence', '_re'))) and not 0 <= n <= 1:
        return '超出0到1契约范围'
    if (field in ('pupil_valid', 'left_pupil_valid', 'right_pupil_valid', 'blink', 'left_blink', 'right_blink')
            and n not in (0, 1)):
        return '非0或1标记'
    if any(part in field for part in ('diameter', 'minor_axis', 'duration_ms')) and n <= 0:
        return '测量必须为正'
    if ('velocity' in field or 'distance_px' in field or 'distance_deg' in field) and n < 0:
        return '大小量不能为负'
    if '_direction_' in field and not -1.000001 <= n <= 1.000001:
        return '单位方向分量越界'
    return None


def pupil_center_problem(raw, eye):
    eye_id = 1 if eye == 'left' else 0
    pupil = next((p for p in raw.get('base_data', []) if p.get('id') == eye_id), None)
    if pupil is None:
        return '没有原始该眼贡献'
    ellipse = pupil.get('ellipse_2d', pupil.get('ellipse', {}))
    axes = ellipse.get('axes', [])
    if len(axes) != 2 or any(number(v) is None or float(v) <= 0 for v in axes):
        return '原始2D椭圆无有效轴长，中心不能确认为实测有效值'
    return None


def calibration_report(archive, output):
    from services.eye_tracking.adapters.pupil_core.angular_metrics import angular_errors, summarize_angles
    params = archive['result']['params']
    matches = matched_calibration(archive['ref_list'], archive['pupil_list'])
    size = np.array(params['intrinsics']['resolution'])
    models = {key: NativeGazer(params['intrinsics'], params) for key in ('原深度混用', '修复后模型深度')}
    for eye in models['原深度混用'].eyes:
        eye.binocular_model = models['原深度混用'].binocular
    detailed = []
    for name, model in models.items():
        group, previous = 0, -math.inf
        for ref, p0, p1 in matches:
            if ref['timestamp'] - previous > .5:
                group += 1
            previous = ref['timestamp']
            pred = model.predict([p0, p1])
            for eye, point in [('融合', pred), ('左眼', pred['monocular']['1']), ('右眼', pred['monocular']['0'])]:
                # Top-left image axes: positive vertical bias means below target.
                delta = (np.array(point['norm_pos']) - ref['norm_pos']) * size * [1, -1]
                detailed.append(dict(variant=name, target=group, eye=eye, source_timestamp_s=ref['timestamp'],
                                     reference_x=ref['norm_pos'][0], reference_y=1-ref['norm_pos'][1],
                                     predicted_x=point['norm_pos'][0], predicted_y=1-point['norm_pos'][1],
                                     error_px=float(np.linalg.norm(delta)), dx_px=float(delta[0]), dy_px=float(delta[1]),
                                     error_deg=angular_errors([ref['norm_pos']], [point['norm_pos']], model.intrinsics)[0]))
    write_csv(output / 'calibration-samples.csv', detailed)
    grouped = []
    for name in models:
        for target in sorted({r['target'] for r in detailed}) + ['全部']:
            for eye in ('融合', '左眼', '右眼'):
                selected = [r for r in detailed if r['variant'] == name and r['eye'] == eye and (target == '全部' or r['target'] == target)]
                grouped.append(dict(variant=name, target=target, eye=eye, **stats(r['error_px'] for r in selected),
                                    **{k: v for k, v in summarize_angles(r['error_deg'] for r in selected).items() if k != 'unit'},
                                    pixelStatisticsUnit='source_pixels', angularStatisticsUnit='degrees', independentValidationPerformed=False,
                                    horizontal_bias_px=float(np.mean([r['dx_px'] for r in selected])),
                                    vertical_bias_px=float(np.mean([r['dy_px'] for r in selected]))))
    write_csv(output / 'calibration-summary.csv', grouped)
    return grouped


def audit(source, output, ffprobe):
    source, output = source.resolve(), output.resolve()
    if source.parent == output or source.parent in output.parents or output in source.parents:
        raise ValueError('Audit output must be separate from the recordings directory')
    sidecar = source.with_suffix('.pupil')
    cache_paths = {name: source.with_suffix(suffix) for name, suffix in
                   [('analysis_events', '.analysis-events.csv'), ('playback_index', '.points.index.json')]}
    cache_checks = {name: 'checked' if path.exists() else 'not_available' for name, path in cache_paths.items()}
    inputs = [source, source.with_suffix('.mp4'), source.with_suffix('.meta.json'),
              *(p for p in cache_paths.values() if p.exists() or p.is_symlink()), *sorted(sidecar.iterdir())]
    if any(p.is_symlink() or not p.is_file() for p in inputs):
        raise ValueError('Expected regular, non-symlink recording files')
    hashes = {str(p): digest(p) for p in inputs}
    output.mkdir(parents=True, exist_ok=False)
    meta = json.loads(source.with_suffix('.meta.json').read_text())
    origin, duration = meta['sourceTimeOriginS'], meta['durationSeconds']
    original = rows(source)
    derived = rebuild(source, output / 'replay')
    replay = rows(Path(derived['csv_path']))
    differences = []
    def issue(stage, key, field, before, after):
        differences.append(dict(stage=stage, sample=str(key), field=field,
                                recorded=json.dumps(before, ensure_ascii=False), recomputed=json.dumps(after, ensure_ascii=False)))
    # Each raw envelope is identity-aligned by rebuild; compare every normalized
    # attribute and spool field against the saved journal as a separate stage.
    for filename in ('normalized-samples.jsonl', 'gaze-spool.jsonl', 'events-spool.jsonl'):
        old, new = list(json_lines(sidecar / filename)), list(json_lines(output / 'replay' / filename))
        if len(old) != len(new):
            issue(filename, 'count', 'rows', len(old), len(new))
        for i, (a, b) in enumerate(zip(old, new), 1):
            for field in a.keys() | b.keys():
                if not equivalent(a.get(field), b.get(field)):
                    issue(filename, i, field, a.get(field), b.get(field))
    maps = []
    for name, data in [('original', original), ('replay', replay)]:
        mapped = {}
        for i, row in enumerate(data, 2):
            key = row_key(row)
            if key in mapped:
                issue(name, key, 'duplicate_key', i, None)
            mapped[key] = row
        maps.append(mapped)
    for key in maps[0].keys() | maps[1].keys():
        a, b = maps[0].get(key), maps[1].get(key)
        if a is None or b is None:
            issue('CSV', key, 'row_missing', a, b)
            continue
        for field in a.keys() | b.keys():
            if not equivalent(a.get(field), b.get(field)):
                issue('CSV', key, field, a.get(field), b.get(field))
    normalized = list(json_lines(sidecar / 'normalized-samples.jsonl'))
    raw_gaze, topics, times = {}, Counter(), defaultdict(list)
    pairing = []
    with (sidecar / 'source-messages.msgpack').open('rb') as stream:
        selected = iter(normalized)
        for envelope in msgpack.Unpacker(stream, raw=False, strict_map_key=False):
            topic = envelope['parts'][0].decode()
            topics[topic] += 1
            if topic.startswith(('pupil.', 'gaze')) or topic in ('fixations', 'blinks', 'saccades'):
                n = next(selected)
                data = msgpack.unpackb(envelope['parts'][1], raw=False, strict_map_key=False)
                if topic.startswith(('pupil.', 'gaze')):
                    times[topic].append(data['timestamp'])
                if topic.startswith('gaze'):
                    raw_gaze[str(n['identity']['received_sequence'])] = data
                    if len(data.get('base_data', [])) == 2:
                        pairing.append(abs(data['base_data'][0]['timestamp']-data['base_data'][1]['timestamp']) * 1000)
    fields = []
    missing_rows = []
    value_issues = []
    for field in original[0]:
        scope = [r for r in original if applicable(field, r)]
        reasons = Counter()
        invalid_present = 0
        for row in scope:
            if row[field] in ('', None):
                expected = maps[1].get(row_key(row), {}).get(field)
                why = blank_reason(field, row, expected, raw_gaze.get(row['source_receive_sequence']))
                reasons[why] += 1
                missing_rows.append(dict(field=field, video_time_ms=row['video_time_ms'], row_type=kind(row),
                                         receive_sequence=row['source_receive_sequence'], reason=why))
            else:
                problem = value_problem(field, row[field])
                if field in ('left_pupil_center_x', 'left_pupil_center_y', 'right_pupil_center_x', 'right_pupil_center_y'):
                    problem = problem or pupil_center_problem(raw_gaze.get(row['source_receive_sequence'], {}), field.split('_')[0])
                if problem:
                    invalid_present += 1
                    value_issues.append(dict(field=field, video_time_ms=row['video_time_ms'], value=row[field], reason=problem))
        fields.append(dict(field=field, applicable_rows=len(scope), present=sum(r[field] not in ('', None) for r in scope),
                           contract_valid_present=sum(r[field] not in ('', None) for r in scope)-invalid_present,
                           questionable_present=invalid_present,
                           missing=sum(reasons.values()), missing_percent=100*sum(reasons.values())/len(scope) if scope else '',
                           expected_from_replay=sum(maps[1].get(row_key(r), {}).get(field) not in ('', None) for r in scope),
                           unexpected_missing=reasons['转换或保存缺失'],
                           longest_blank_observed_span_ms=longest_blank_run(scope, field, duration*1000) if scope and all(kind(r)=='gaze' for r in scope) else '',
                           missing_reasons=json.dumps(reasons, ensure_ascii=False)))
    write_csv(output / 'field-completeness.csv', fields)
    write_csv(output / 'questionable-values.csv', value_issues, ['field', 'video_time_ms', 'value', 'reason'])
    write_csv(output / 'missing-details.csv', missing_rows, ['field','video_time_ms','row_type','receive_sequence','reason'])
    checks = Counter()
    def check(condition, label, row, expected=None):
        checks[label] += 1
        if not condition:
            issue('独立规则检查', row.get('video_time_ms', ''), label, row, expected)
    gaze = [r for r in original if kind(r)=='gaze']
    size = (meta['encodedWidth'], meta['encodedHeight'])
    for row in gaze:
        t = float(row['source_timestamp_s'])
        check(equivalent((t-origin)*1000, row['video_time_ms']), '源时间到视频时间', row)
        check(row['pupil_valid'] in ('0','1'), '有效标记枚举', row)
        if row['pupil_valid']=='1':
            check(equivalent(row['recom_gaze_x'], row['source_norm_pos_x']) and
                  equivalent(float(row['recom_gaze_y']), 1-float(row['source_norm_pos_y'])), '场景坐标Y翻转', row)
            for eye in ('recom','left','right'):
                p=[number(row[f'{eye}_gaze_point_{a}']) for a in 'xyz']; o=[number(row[f'{eye}_origin_{a}']) for a in 'xyz']; d=[number(row[f'{eye}_direction_{a}']) for a in 'xyz']
                if all(v is not None for v in (*p,*o,*d)):
                    ray=np.array(p)-o; ray/=np.linalg.norm(ray)
                    check(np.allclose(ray,d,atol=1e-6), f'{eye}三维方向与点原点一致', row)
            for eye in ('left','right'):
                c=[number(row[f'{eye}_pupil_center_{a}']) for a in 'xy']
                if all(v is not None for v in c):
                    role = '1' if eye == 'left' else '0'
                    resolution = meta['sourceInfo']['cameras'][role]['intrinsics']['resolution']
                    check(all(0<=v<limit for v,limit in zip(c,resolution)), f'{eye}瞳孔中心在眼图内', row)
    # Recompute event geometry directly from persisted coordinates, without the
    # production event merger. A short I-VT interval need not join two fixations.
    fixations = [r for r in original if kind(r) == 'fixation']
    saccade_support = []
    for row in fixations:
        for axis, limit in zip('xy', size):
            check(equivalent(float(row[f'fixation_center_{axis}'])*limit, row[f'fixation_point_{axis}_px']),
                  '注视中心归一化与像素坐标一致', row)
    for row in (r for r in original if kind(r) == 'saccade'):
        t = float(row['video_time_ms'])
        end = t + float(row['saccade_duration_ms'])
        before = [r for r in fixations if r['source_generation'] == row['source_generation']
                  and -1 <= t-float(r['fixation_timestamp_ms'])-float(r['fixation_duration_ms']) <= 100]
        after = [r for r in fixations if r['source_generation'] == row['source_generation']
                 and -1 <= float(r['fixation_timestamp_ms'])-end <= 100]
        reason = '支持' if before and after else ('缺前后注视' if not before and not after else '缺前注视' if not before else '缺后注视')
        saccade_support.append(dict(video_time_ms=t, duration_ms=row['saccade_duration_ms'], reason=reason,
                                    before_count=len(before), after_count=len(after)))
        check(bool(before and after) == (row['saccade_distance_px'] != ''), '扫视前后注视距离可用性', row)
        endpoint = math.sqrt(sum(((float(row[f'saccade_end_{a}'])-float(row[f'saccade_start_{a}']))*limit)**2 for a,limit in zip('xy',size)))
        check(equivalent(endpoint, row['saccade_endpoint_distance_px']), '扫视端点像素位移', row)
    write_csv(output / 'saccade-support.csv', saccade_support, ['video_time_ms', 'duration_ms', 'reason', 'before_count', 'after_count'])
    # Persisted analysis consumer: compare event positions and measured timing,
    # not just counts. No assumption that an analysis event is ground truth.
    events=[r for r in original if kind(r) in ('fixation','saccade')]
    if cache_paths['analysis_events'].exists():
        analysis=rows(source.with_suffix('.analysis-events.csv'))
        lookup={(r['fixation_state'],round(float(r['video_time_ms']),6)):r for r in events}
        if len(lookup) != len(events):
            issue('分析缓存', 'source', 'ambiguous_event_keys', len(events), len(lookup))
        if len(analysis) != len(events):
            issue('分析缓存', 'count', 'rows', len(analysis), len(events))
        seen = set()
        for row in analysis:
            key = (row['fixationState'], round(float(row['timestamp']),6))
            if key in seen:
                issue('分析缓存', key, 'duplicate_key', key, None)
            seen.add(key)
            match=lookup.get(key)
            if match is None:
                issue('分析缓存',row['timestamp'],'event_missing',row,None);continue
            for a,b in [('x','fixation_center_x'),('y','fixation_center_y'),('fixationDurationMs','fixation_duration_ms'),
                        ('saccadeDurationMs','saccade_duration_ms'),('saccadeAmplitude','saccade_distance_px'),
                        ('saccadeVelocity','average_saccade_velocity_px_ms'),('saccadePeakVelocity','peak_saccade_velocity_px_ms')]:
                if not equivalent(row[a],match[b]):issue('分析缓存',row['timestamp'],a,row[a],match[b])
        for key in lookup.keys() - seen:
            issue('分析缓存', key, 'missing_cached_event', None, lookup[key])
    observed={'totalRows':len(original),'gazePointCount':sum(r['pupil_valid']=='1' for r in gaze),
              'fixationPointCount':sum(kind(r)=='fixation' for r in original),'analysisEventCount':len(events),
              'minVideoTimeMs':min(float(r['video_time_ms']) for r in original),
              'maxVideoTimeMs':max(float(r['video_time_ms']) for r in original),
              'sourceSizeBytes':source.stat().st_size}
    observed['durationMs'] = observed['maxVideoTimeMs']-observed['minVideoTimeMs']
    if cache_paths['playback_index'].exists():
        index=json.loads(cache_paths['playback_index'].read_text())
        for key,value in observed.items():
            if not equivalent(index[key],value):issue('回放索引',key,key,index[key],value)
    frame_map=rows(sidecar/'frame-map.csv')
    probe=json.loads(subprocess.check_output([ffprobe,'-v','error','-select_streams','v:0','-count_frames',
               '-show_entries','stream=width,height,nb_read_frames,avg_frame_rate,duration','-of','json',str(source.with_suffix('.mp4'))],text=True))['streams'][0]
    frame_errors=[]
    fps = float(Fraction(probe['avg_frame_rate']))
    for i,f in enumerate(frame_map):
        if int(f['output_index'])!=i or not math.isclose(float(f['pts_s']),i/fps,abs_tol=1e-6):frame_errors.append(i)
    if frame_errors:
        issue('视频', 'frame_map', 'frame_index_or_pts', frame_errors, [])
    video={'probe':probe,'frame_map_rows':len(frame_map),'repeated_frames':sum(r['repeated']=='1' for r in frame_map),
           'frame_index_or_pts_errors':frame_errors,
           'mapping_offset_ms':stats((float(r['source_timestamp_s'])-origin-float(r['pts_s']))*1000 for r in frame_map),
           'offset_meaning':'source frame mapped to encoded PTS, not independently measured sensor latency'}
    for key,a,b in [('frames',int(probe['nb_read_frames']),len(frame_map)),('metadata_frames',meta['outputFrames'],len(frame_map)),
                    ('repeats',meta['repeatedFrames'],video['repeated_frames'])]:
        if a!=b:issue('视频',key,key,a,b)
    clock={topic:{'count':len(stamps),'non_increasing':sum(b<=a for a,b in zip(stamps,stamps[1:])),
                  'interval_ms':stats((b-a)*1000 for a,b in zip(stamps,stamps[1:])),
                  'empirical_rate_hz':(len(stamps)-1)/(stamps[-1]-stamps[0]) if len(stamps)>1 else None}
           for topic,stamps in times.items()}
    for topic, data in clock.items():
        if data['non_increasing']:
            issue('时钟', topic, 'non_increasing', data['non_increasing'], 0)
    archive=msgpack.unpackb((sidecar/'calibration.msgpack').read_bytes(),raw=False,strict_map_key=False)
    calibration=calibration_report(archive,output)
    params=archive['result']['params']; model=NativeGazer(params['intrinsics'],params)
    changes=[]
    for row in gaze:
        raw=raw_gaze[row['source_receive_sequence']]; predicted=model.predict(raw.get('base_data',[]))
        if not predicted:continue
        for eye,eye_id in [('left','1'),('right','0')]:
            a=raw.get('monocular',{}).get(eye_id); b=predicted['monocular'].get(eye_id)
            if a and b:
                changes.append(dict(video_time_ms=row['video_time_ms'],eye=eye,
                    old_in_scene=all(0<=v<=1 for v in a['norm_pos']),new_in_scene=all(0<=v<=1 for v in b['norm_pos']),
                    displacement_px=float(np.linalg.norm((np.array(a['norm_pos'])-b['norm_pos'])*params['intrinsics']['resolution']))))
    write_csv(output/'monocular-comparison.csv',changes)
    changed={eye:{'samples':sum(r['eye']==eye for r in changes),'old_in_scene':sum(r['old_in_scene'] for r in changes if r['eye']==eye),
                  'new_in_scene':sum(r['new_in_scene'] for r in changes if r['eye']==eye),
                  'displacement_px':stats(r['displacement_px'] for r in changes if r['eye']==eye)} for eye in ('left','right')}
    summary={'recording':source.name,'rows':len(original),'fields':len(fields),'row_types':dict(Counter(map(kind,original))),
             'raw_topics':dict(topics),'normalized_samples':len(normalized),'valid_gaze':sum(r['pupil_valid']=='1' for r in gaze),
             'invalid_gaze_reasons':dict(Counter(r['gaze_invalid_reason'] for r in gaze if r['pupil_valid']!='1')),
             'difference_count':len(differences),'difference_categories':dict(Counter(d['stage'] for d in differences)),
             'questionable_value_count':len(value_issues),
             'questionable_value_fields':dict(Counter(r['field'] for r in value_issues)),
             'field_value_note':'contract_valid_present is not independent measurement accuracy; raw off-scene coordinates are intentionally preserved',
             'independent_rule_checks':dict(checks),'source_clocks':clock,'binocular_pair_delta_ms':stats(pairing),
             'saccade_fixation_support':dict(Counter(r['reason'] for r in saccade_support)),
             'video':video,'cache_checks':cache_checks,'index_recomputed':observed,'monocular_model_comparison':changed,'calibration':calibration,
             'independent_accuracy_available':False,'original_independent_validation':meta['independentValidationPerformed'],
             'replay_counts':{k:derived[k] for k in ('gazeRows','validGazeRows','gazeOutsideVideo','fixationEvents','saccadeEvents','blinkOnsets','blinkUnpairedPhases')},
             'comparison_tolerance':{'relative':0,'absolute':1e-8},
             'source_hashes':hashes,'software_audit_source_sha256':digest(Path(__file__)),
             'software_sources':{str(p):digest(p) for p in [Path(__file__), Path('tools/pupil/rebuild_recording.py'),
                 *Path('services/eye_tracking').rglob('*.py')] if '.venv' not in p.parts and '__pycache__' not in p.parts},
             'scope_limits':['Replay uses production conversion code, so consistency is not independent algorithm validation.',
                             'No independent validation targets or eye videos are available for this recording.',
                             'Available analysis caches are checked; missing caches are explicitly not_available. Live UI is not tested.']}
    write_csv(output/'differences.csv',differences,['stage','sample','field','recorded','recomputed'])
    if hashes!={str(p):digest(p) for p in inputs}:
        raise ValueError('Original files changed during audit; results are untrusted')
    summary['source_hashes_unchanged']=True
    (output/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2,allow_nan=False)+'\n')
    return summary


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source',type=Path);parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--ffprobe',default='ffprobe');args=parser.parse_args()
    report=audit(args.source,args.output,args.ffprobe)
    print(json.dumps({k:report[k] for k in ('rows','fields','row_types','valid_gaze','difference_count','difference_categories','source_hashes_unchanged')},ensure_ascii=False,indent=2))


if __name__=='__main__':main()
