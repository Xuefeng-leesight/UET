import type { BlinkInterval, BlinkIntervalData } from '../../../shared/contracts/domain/analysis';

/** Read the recorder's explicit pairs. Never infer a pair across eyes/sessions. */
export function createRecordedBlinkCollector(headers: string[]) {
  const indexes = new Map(headers.map((header, index) => [header.replace(/^\uFEFF/, '').trim().toLowerCase(), index]));
  const required = ['source_model', 'source_event_type', 'blink_phase', 'blink_pair_id', 'blink_pair_status', 'source_generation', 'video_time_ms'];
  const hasSchema = required.every((name) => indexes.has(name));
  let observedSource = false;
  let unpairedPhaseCount = 0;
  const pairs = new Map<string, { eye: BlinkInterval['eye']; generation: string; onset?: number; offset?: number; stimulusName?: string; invalid: boolean }>();
  const read = (parts: string[], name: string) => String(parts[indexes.get(name) ?? -1] ?? '').trim();
  return {
    addRow(parts: string[]) {
      if (read(parts, 'source_model') !== 'PupilCore') return;
      observedSource = true;
      // Old Pupil CSVs have no explicit pair schema. Their coverage stays
      // unknown rather than falling back to a synthetic zero/point duration.
      if (!hasSchema) return;
      if (read(parts, 'source_event_type') !== 'blink') return;
      const rawTime = read(parts, 'video_time_ms');
      const timestamp = rawTime ? Number(rawTime) : NaN;
      const phase = read(parts, 'blink_phase');
      const pairId = read(parts, 'blink_pair_id');
      const generation = read(parts, 'source_generation');
      if (read(parts, 'blink_pair_status') !== 'paired' || !pairId || !generation
        || !Number.isFinite(timestamp) || timestamp < 0 || (phase !== 'onset' && phase !== 'offset')) {
        unpairedPhaseCount += 1;
        return;
      }
      const marker = read(parts, 'blink_marker');
      if (marker && marker !== '1' && marker !== '2') {
        unpairedPhaseCount += 1;
        return;
      }
      const eye: BlinkInterval['eye'] = marker === '1' ? 'left' : marker === '2' ? 'right' : 'unspecified';
      const key = JSON.stringify([generation, eye, pairId]);
      const pair = pairs.get(key) || { eye, generation, invalid: false };
      if (pair[phase] !== undefined && pair[phase] !== timestamp) pair.invalid = true;
      pair[phase] = timestamp;
      if (phase === 'onset') pair.stimulusName = read(parts, 'stimulus') || undefined;
      pairs.set(key, pair);
      if (pairs.size > 100_000) throw new Error('眨眼区间超过 10 万个读取上限；未生成不完整统计。');
    },
    finish(): BlinkIntervalData | undefined {
      if (!observedSource) return undefined;
      const intervals: BlinkInterval[] = [];
      let incomplete = unpairedPhaseCount;
      for (const [id, pair] of pairs) {
        if (pair.invalid || pair.onset === undefined || pair.offset === undefined || pair.offset <= pair.onset) {
          incomplete += Number(pair.onset !== undefined) + Number(pair.offset !== undefined);
          continue;
        }
        intervals.push({ id, startTimeMs: pair.onset, endTimeMs: pair.offset, eye: pair.eye,
          sourceGeneration: pair.generation, stimulusName: pair.stimulusName });
      }
      intervals.sort((a, b) => a.startTimeMs - b.startTimeMs || a.id.localeCompare(b.id));
      return { intervals, unpairedPhaseCount: incomplete };
    },
  };
}
