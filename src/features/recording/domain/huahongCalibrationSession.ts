type CalibrationResetReason = 'start' | 'cancel' | 'disconnect' | 'failure' | 'timeout' | 'stop';
type Session = { model: string; epoch: number; active: string | null;
  point: { index: unknown; attempt: unknown } | null; reset: (reason: CalibrationResetReason) => void };
export type PreparedCalibrationCommand = {
  id: string;
  args: Record<string, unknown>;
  calibration?: { epoch: number; session: string | null; cancelling: boolean };
};

const sessions = new WeakMap<WebSocket, Session>();
let sequence = 0;
const calibrationCommands = new Set(['start_calibration', 'start_calibration_point', 'complete_calibration',
  'finish_calibration', 'cancel_calibration', 'cancel_calibration_point']);

function isValidCalibrationResponse(message: Record<string, unknown>): boolean {
  if (message.error !== 0) return true;
  if (message.id === 'start_calibration_point') return message.point_pending === true;
  if (message.id === 'complete_calibration' && message.result_pending !== true) {
    return typeof message.coe === 'string' && message.coe.trim().length > 0 &&
      typeof message.tracking_error === 'number' && Number.isFinite(message.tracking_error);
  }
  return true;
}

export function registerHuahongCalibrationSession(socket: WebSocket, model: string | undefined,
  reset: (reason: CalibrationResetReason) => void): void {
  if (model === 'HH_ET10C' || model === 'HH_ET28') sessions.set(socket, { model, epoch: 0, active: null, point: null, reset });
}

export function invalidateHuahongCalibrationSession(socket: WebSocket, reason: CalibrationResetReason = 'disconnect'): void {
  const state = sessions.get(socket);
  if (!state) return;
  state.epoch++;
  state.active = null;
  state.point = null;
  state.reset(reason);
}

// Prepare at the caller's intent, before any request queue: cancellation must
// reject in-flight results even while another command is awaiting its response.
export function prepareCalibrationCommand(socket: WebSocket, id: string, args: Record<string, unknown>): PreparedCalibrationCommand {
  const state = sessions.get(socket);
  if (!state) return { id, args };
  if (id === 'stop') invalidateHuahongCalibrationSession(socket, 'stop');
  if (!calibrationCommands.has(id)) return { id, args };
  let session = state.active;
  const cancelling = id === 'cancel_calibration' || id === 'cancel_calibration_point';
  if (id === 'start_calibration') {
    invalidateHuahongCalibrationSession(socket, 'start');
    session = `huahong-${Date.now().toString(36)}-${++sequence}`;
    state.active = session;
  } else if (cancelling) {
    invalidateHuahongCalibrationSession(socket, 'cancel');
  } else if (id === 'start_calibration_point' && session) {
    state.point = { index: args.index, attempt: args.attempt };
  }
  return { id, args: session ? { ...args, calibration_session: session } : args,
    calibration: { epoch: state.epoch, session, cancelling } };
}

export function isCurrentCalibrationCommand(socket: WebSocket, command: PreparedCalibrationCommand): boolean {
  if (!command.calibration) return true;
  const state = sessions.get(socket);
  return Boolean(state && state.epoch === command.calibration.epoch &&
    (command.calibration.cancelling || (command.calibration.session && state.active === command.calibration.session)));
}

export function invalidateCalibrationCommand(socket: WebSocket, command: PreparedCalibrationCommand,
  reason: 'failure' | 'timeout'): void {
  if (command.calibration && isCurrentCalibrationCommand(socket, command)) invalidateHuahongCalibrationSession(socket, reason);
}

export function matchesCalibrationCommandResponse(socket: WebSocket, command: PreparedCalibrationCommand,
  message: Record<string, unknown>): boolean {
  if (!command.calibration) return true;
  const state = sessions.get(socket);
  if (!state || state.epoch !== command.calibration.epoch || message.calibration_provider !== state.model) return false;
  if (!isValidCalibrationResponse(message)) return false;
  if (command.calibration.session && message.calibration_session !== command.calibration.session) return false;
  if (command.id === 'start_calibration_point' &&
      (message.index !== command.args.index || message.attempt !== command.args.attempt)) return false;
  // A failure consumed by the main listener invalidates live results but can
  // still settle the matching request. A cancelled/old epoch cannot settle it.
  return command.calibration.cancelling || state.active === command.calibration.session || message.error !== 0;
}

export function acceptHuahongCalibrationMessage(socket: WebSocket, message: Record<string, unknown>): boolean {
  const state = sessions.get(socket);
  if (!state) return true;
  if (message.type === 'notify_device_error' && message.source === state.model) {
    invalidateHuahongCalibrationSession(socket, 'failure');
    return true;
  }
  const isResponse = message.type === 'rsp_cmd' && calibrationCommands.has(String(message.id));
  const isPoint = message.type === 'notify_finish' || message.type === 'notify_progress';
  if (!isResponse && !isPoint) return true;
  if (isResponse && !isValidCalibrationResponse(message)) return false;
  if (!state.active || message.calibration_session !== state.active ||
      (isResponse ? message.calibration_provider : message.source) !== state.model) return false;
  if ((isPoint || message.id === 'start_calibration_point') &&
      (!state.point || message.index !== state.point.index || message.attempt !== state.point.attempt)) return false;
  if (isResponse && (message.id === 'start_calibration' || message.id === 'complete_calibration') && message.error !== 0) {
    // Preserve the epoch for this error's response listener, while rejecting any
    // subsequent success/point result until a fresh start creates a new session.
    state.active = null;
    state.point = null;
    state.reset('failure');
  }
  return true;
}
