/** Pupil's custom display scores are separate from legacy pixel/vendor values. */
export type PupilScoreMetric = {
  qualityScore: number | null;
  scoringPolicy: 'mrt_angular_linear_v1';
  scoreInputMetric: 'pupilCoreAccuracyDeg';
  scoreIsOfficial: false;
  pupilCoreAccuracyDeg: number | null;
  meanErrorDeg: number | null;
  p95ErrorDeg: number | null;
  samples: number;
  pupilCoreUsedSamples: number;
  excludedSamples: number;
  outlierThresholdDeg: number;
  targetsWithSamples?: number;
  validityPercent?: number;
};
type PupilEye = 'left' | 'right' | 'binocular';
export type PupilScoreReport = {
  metrics: Partial<Record<PupilEye, PupilScoreMetric>>;
  angularAccuracyAvailable: boolean;
  intrinsicsIndividuallyCalibrated: boolean | null;
};
export type CalibrationScores = {
  left: number;
  right: number;
  pupilScores?: { training?: PupilScoreReport; validation?: PupilScoreReport };
  et28Quality?: Et28CalibrationQuality;
};

type Et28EyeQuality = {
  count: number;
  points: { index: number; status: number; score: number; bias: [number | null, number | null] }[];
  truncated: false;
};
export type Et28CalibrationQuality = {
  version: 1;
  provider: 'HH_ET28';
  aggregation: 'arithmetic_mean';
  left: Et28EyeQuality;
  right: Et28EyeQuality;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function count(value: unknown): value is number {
  return finite(value) && Number.isSafeInteger(value) && value >= 0;
}
function angle(value: unknown): value is number | null {
  return value === null || (finite(value) && value >= 0 && value <= 180);
}

/** SDK scores are uint32 point values (including values above 100), not percentages. */
export function parseEt28CalibrationQuality(value: unknown): Et28CalibrationQuality | null {
  const raw = record(value);
  if (!raw || raw.version !== 1 || raw.provider !== 'HH_ET28' || raw.aggregation !== 'arithmetic_mean') return null;
  const eye = (value: unknown): Et28EyeQuality | null => {
    const rawEye = record(value);
    if (!rawEye || !count(rawEye.count) || ![1, 3, 5, 9].includes(rawEye.count) || rawEye.truncated !== false
        || !Array.isArray(rawEye.points) || rawEye.points.length !== rawEye.count) return null;
    const points: Et28EyeQuality['points'] = [];
    for (const [index, value] of rawEye.points.entries()) {
      const point = record(value);
      if (!point || point.index !== index + 1 || (point.status !== 0 && point.status !== 1)
          || !count(point.score) || point.score > 0xffffffff || !Array.isArray(point.bias) || point.bias.length !== 2
          || !point.bias.every((coordinate) => coordinate === null || finite(coordinate))) return null;
      points.push({ index: index + 1, status: point.status, score: point.score,
        bias: [point.bias[0] as number | null, point.bias[1] as number | null] });
    }
    return { count: rawEye.count, points, truncated: false };
  };
  const left = eye(raw.left);
  const right = eye(raw.right);
  return left && right && left.count === right.count
    ? { version: 1, provider: 'HH_ET28', aggregation: 'arithmetic_mean', left, right } : null;
}

export function et28CalibrationQualityScores(quality: Et28CalibrationQuality): { left: number; right: number } {
  const mean = (eye: Et28EyeQuality) => eye.points.reduce((sum, point) => sum + point.score, 0) / eye.count;
  return { left: mean(quality.left), right: mean(quality.right) };
}

function et28Scores(quality: Et28CalibrationQuality): CalibrationScores {
  return { ...et28CalibrationQualityScores(quality), et28Quality: quality };
}

function parseMetric(value: unknown): PupilScoreMetric | null {
  const raw = record(value);
  if (!raw || raw.scoringPolicy !== 'mrt_angular_linear_v1'
      || raw.scoreInputMetric !== 'pupilCoreAccuracyDeg' || raw.scoreIsOfficial !== false
      || !angle(raw.pupilCoreAccuracyDeg) || !angle(raw.meanErrorDeg) || !angle(raw.p95ErrorDeg)
      || !count(raw.samples) || !count(raw.pupilCoreUsedSamples) || !count(raw.excludedSamples)
      || raw.pupilCoreUsedSamples + raw.excludedSamples !== raw.samples
      || !finite(raw.outlierThresholdDeg) || raw.outlierThresholdDeg <= 0 || raw.outlierThresholdDeg > 180) return null;
  const error = raw.pupilCoreAccuracyDeg;
  const score = raw.qualityScore;
  // Reject invalid or contradictory scores rather than reinterpreting pixel data.
  if (error === null) {
    if (score !== null || raw.pupilCoreUsedSamples !== 0) return null;
  } else {
    const expected = Math.floor(Math.max(1, Math.min(10, 10 - 2 * error)) * 10 + 0.5 + 1e-12) / 10;
    if (!finite(score) || score < 1 || score > 10 || Math.abs(score - expected) > 1e-8
        || raw.pupilCoreUsedSamples === 0 || error >= raw.outlierThresholdDeg) return null;
  }
  if ((raw.samples === 0) !== (raw.meanErrorDeg === null)
      || (raw.samples === 0) !== (raw.p95ErrorDeg === null)) return null;
  const metric: PupilScoreMetric = {
    qualityScore: score as number | null, scoringPolicy: 'mrt_angular_linear_v1',
    scoreInputMetric: 'pupilCoreAccuracyDeg', scoreIsOfficial: false,
    pupilCoreAccuracyDeg: error, meanErrorDeg: raw.meanErrorDeg, p95ErrorDeg: raw.p95ErrorDeg,
    samples: raw.samples, pupilCoreUsedSamples: raw.pupilCoreUsedSamples,
    excludedSamples: raw.excludedSamples, outlierThresholdDeg: raw.outlierThresholdDeg,
  };
  if (count(raw.targetsWithSamples) && raw.targetsWithSamples <= 3) metric.targetsWithSamples = raw.targetsWithSamples;
  if (finite(raw.validityPercent) && raw.validityPercent >= 0 && raw.validityPercent <= 100) metric.validityPercent = raw.validityPercent;
  return metric;
}

function unavailableReport(): PupilScoreReport {
  return { metrics: {}, angularAccuracyAvailable: false, intrinsicsIndividuallyCalibrated: null };
}

function parseReport(value: unknown): PupilScoreReport | null {
  const raw = record(value);
  const metrics = record(raw?.metrics);
  if (!raw || !metrics) return null;
  const parsed: PupilScoreReport['metrics'] = {};
  for (const eye of ['left', 'right', 'binocular'] as const) {
    const metric = parseMetric(metrics[eye]);
    if (metric) parsed[eye] = metric;
  }
  if (!Object.keys(parsed).length) return raw.angularAccuracyAvailable === false ? unavailableReport() : null;
  return {
    metrics: parsed, angularAccuracyAvailable: true,
    intrinsicsIndividuallyCalibrated: typeof raw.intrinsicsIndividuallyCalibrated === 'boolean'
      ? raw.intrinsicsIndividuallyCalibrated : null,
  };
}

function legacyNumber(value: unknown): number | null {
  if (finite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export function parseCalibrationPayload(raw: unknown): { coe: string | null; scores: CalibrationScores | null } {
  const payload = record(raw);
  if (!payload) return { coe: null, scores: null };
  const coeRaw = payload.coe ?? payload.calibrationCoe;
  const coe = typeof coeRaw === 'string' && coeRaw.trim() ? coeRaw.trim() : null;
  const scores = record(payload.scores);
  const et28Quality = parseEt28CalibrationQuality(scores?.et28Quality);
  if (et28Quality) return { coe, scores: et28Scores(et28Quality) };
  if (scores && Object.hasOwn(scores, 'et28Quality')) return { coe, scores: null };
  const left = [scores?.left, scores?.leftScore, scores?.left_score, payload.calibrationLeftScore, payload.leftScore, payload.left_score]
    .map(legacyNumber).find((value) => value !== null) ?? null;
  const right = [scores?.right, scores?.rightScore, scores?.right_score, scores?.right_scroe,
    payload.calibrationRightScore, payload.rightScore, payload.right_score, payload.right_scroe]
    .map(legacyNumber).find((value) => value !== null) ?? null;
  const pupil = record(scores?.pupilScores);
  const training = parseReport(pupil?.training);
  const validation = parseReport(pupil?.validation);
  if (left === null && right === null && !training && !validation) return { coe, scores: null };
  return { coe, scores: {
    left: left ?? NaN, right: right ?? NaN,
    ...(training || validation ? { pupilScores: { ...(training ? { training } : {}), ...(validation ? { validation } : {}) } } : {}),
  } };
}

/** Read only a recording's own metadata/normalized snapshot, never the current session's calibration. */
export function parseRecordingCalibrationScores(raw: unknown, deviceModel?: string): CalibrationScores | null {
  const payload = record(raw);
  if (!payload) return null;
  const model = deviceModel ?? payload.deviceModel ?? payload.calibrationProvider;
  const savedPayload = record(payload.calibrationScores);
  const { et28Quality: normalizedQuality, ...otherScores } = savedPayload ?? {};
  const saved = parseCalibrationPayload({ ...payload,
    scores: model && model !== 'HH_ET28' ? otherScores : savedPayload }).scores;
  if (model === 'HH_ET28') {
    if (Object.hasOwn(payload, 'calibrationQuality')) {
      const quality = payload.calibrationVerified === true && payload.calibrationProvider === 'HH_ET28'
        ? parseEt28CalibrationQuality(payload.calibrationQuality) : null;
      return quality ? et28Scores(quality) : null;
    }
    if (saved?.et28Quality) return saved;
    if (normalizedQuality !== undefined) return null;
  }
  const left = saved?.left ?? NaN;
  const right = saved?.right ?? NaN;
  const pupil = deviceModel !== undefined ? deviceModel === 'PupilCore'
    : payload.deviceModel === 'PupilCore' || payload.calibrationProvider === 'PupilCore';
  if (!pupil) return finite(left) || finite(right) ? { left, right } : null;

  const training = parseReport(payload.calibrationTrainingAngular) ?? saved?.pupilScores?.training;
  const normalizedReports = record(record(payload.calibrationScores)?.pupilScores);
  const validationSnapshot = record(payload.calibrationValidation);
  const hasValidation = payload.independentValidationPerformed === true
    || Boolean(normalizedReports && Object.hasOwn(normalizedReports, 'validation'));
  let validation = saved?.pupilScores?.validation;
  if (validationSnapshot || (hasValidation && Object.hasOwn(payload, 'calibrationValidation'))) {
    validation = parseReport(validationSnapshot?.angular) ?? unavailableReport();
  } else if (hasValidation) {
    // An incomplete/rejected validation must not expose a training score under it.
    validation ??= unavailableReport();
  }
  if (!finite(left) && !finite(right) && !training && !validation) return null;
  return {
    left, right,
    ...(training || validation ? { pupilScores: {
      ...(training ? { training } : {}), ...(validation ? { validation } : {}),
    } } : {}),
  };
}

/** Called only after the command/session lifecycle has accepted completion. */
export function calibrationScoresFromCompletion(previous: CalibrationScores | null, value: unknown): CalibrationScores | null {
  const message = record(value);
  if (!message) return previous;
  if (message.calibration_provider === 'HH_ET28') {
    const quality = parseEt28CalibrationQuality(message.calibration_quality);
    if (quality) return et28Scores(quality);
    if (Object.hasOwn(message, 'calibration_quality')) return null;
  }
  const left = finite(message.left_score) ? message.left_score : NaN;
  const rightRaw = message.right_score ?? message.right_scroe;
  const right = finite(rightRaw) ? rightRaw : NaN;
  if (message.calibration_provider !== 'PupilCore') {
    return Number.isFinite(left) || Number.isFinite(right) ? { left, right } : null;
  }
  const validation = record(message.validation);
  if (validation) {
    return { left: previous?.left ?? NaN, right: previous?.right ?? NaN,
      pupilScores: { ...previous?.pupilScores, validation: parseReport(validation.angular) ?? unavailableReport() } };
  }
  const training = parseReport(message.training_angular);
  if (!training && !Number.isFinite(left) && !Number.isFinite(right)) return null;
  // A new fit invalidates validation performed against the preceding fit.
  return { left, right, ...(training ? { pupilScores: { training } } : {}) };
}

export function calibrationScorePresentation(scores: CalibrationScores | null, pupil: boolean, isEn: boolean) {
  const stage = scores?.pupilScores?.validation ? 'validation' : 'training';
  const report = pupil ? scores?.pupilScores?.[stage] : undefined;
  const title = report
    ? stage === 'validation' ? (isEn ? 'Independent validation score' : '独立验证分') : (isEn ? 'Calibration training score' : '校准训练分')
    : pupil ? (isEn ? 'Training error (px, lower is better)' : '校准训练误差（px，越小越好）') : (isEn ? 'Calibration result' : '校准结果');
  const eye = (side: 'left' | 'right') => {
    const metric = report?.metrics[side];
    const value = report ? (metric?.qualityScore != null ? `${metric.qualityScore.toFixed(1)}/10` : '---')
      : finite(scores?.[side]) ? scores[side].toFixed(2) : '---';
    if (!report) {
      const quality = !pupil ? scores?.et28Quality?.[side] : undefined;
      const tooltip = quality ? (isEn
        ? `Mean of ${quality.count} SDK point scores: ${quality.points.map((point) => point.score).join(', ')}. Software summary, not an SDK overall score or percentage; values are not capped at 100.`
        : `SDK ${quality.count} 个校准点原始分数的算术均值：${quality.points.map((point) => point.score).join('、')}。这是软件汇总值，非厂商整轮评分或百分比；不截断超过 100 的原始值。`) : undefined;
      return { value, tooltip };
    }
    const lines = [isEn ? 'Custom score: 10 − 2 × angular error (°), limited to 1–10; not an official Pupil score.'
      : '自定义分数：10 − 2 × 角度误差（°），限制在 1–10；非 Pupil 官方评分。'];
    if (metric) {
      const degrees = (v: number | null) => v === null ? '---' : `${v.toFixed(3)}°`;
      lines.push(isEn ? `Input angular error: ${degrees(metric.pupilCoreAccuracyDeg)}; mean: ${degrees(metric.meanErrorDeg)}; P95: ${degrees(metric.p95ErrorDeg)}.`
        : `换算角度误差：${degrees(metric.pupilCoreAccuracyDeg)}；平均：${degrees(metric.meanErrorDeg)}；P95：${degrees(metric.p95ErrorDeg)}。`);
      lines.push(isEn ? `Used ${metric.pupilCoreUsedSamples}/${metric.samples}; excluded ${metric.excludedSamples} (error ≥ ${metric.outlierThresholdDeg}°).`
        : `采用 ${metric.pupilCoreUsedSamples}/${metric.samples} 个样本；剔除 ${metric.excludedSamples} 个（误差 ≥ ${metric.outlierThresholdDeg}°）。`);
      if (metric.targetsWithSamples !== undefined) lines.push(isEn ? `Targets with samples: ${metric.targetsWithSamples}/3.` : `有样本目标：${metric.targetsWithSamples}/3。`);
      if (metric.validityPercent !== undefined) lines.push(isEn ? `Valid samples: ${metric.validityPercent.toFixed(1)}%.` : `有效样本比例：${metric.validityPercent.toFixed(1)}%。`);
    } else lines.push(isEn ? 'No usable angular score for this eye.' : '该眼暂无可用角度评分。');
    if (report.intrinsicsIndividuallyCalibrated === false) lines.push(isEn ? 'Camera uses default intrinsics.' : '相机使用默认内参。');
    lines.push(isEn ? 'No automatic pass/fail decision.' : '不自动判定合格。');
    return { value, tooltip: lines.join('\n') };
  };
  return { title, left: eye('left'), right: eye('right') };
}
