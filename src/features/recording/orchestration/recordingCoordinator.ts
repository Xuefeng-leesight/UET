import type { ModalityId } from '@shared/contracts/domain/models';

export type ModalityRecordingAdapter = {
  id: ModalityId;
  required: boolean;
  prepare(): Promise<void>;
  start(sessionId: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
};

export type CoordinatedRecordingSession = {
  id: string;
  startedAt: string;
  modalities: ModalityId[];
};

export async function startCoordinatedRecording(
  sessionId: string,
  adapters: ModalityRecordingAdapter[],
): Promise<CoordinatedRecordingSession> {
  const prepared: ModalityRecordingAdapter[] = [];
  for (const adapter of adapters) {
    try {
      await adapter.prepare();
      prepared.push(adapter);
    } catch (error) {
      if (adapter.required) throw error;
    }
  }
  const started: ModalityRecordingAdapter[] = [];
  try {
    for (const adapter of prepared) {
      try {
        await adapter.start(sessionId);
        started.push(adapter);
      } catch (error) {
        if (adapter.required) throw error;
      }
    }
  } catch (error) {
    await Promise.allSettled(started.reverse().map((adapter) => adapter.stop(sessionId)));
    throw error;
  }
  return { id: sessionId, startedAt: new Date().toISOString(), modalities: started.map((adapter) => adapter.id) };
}

export async function stopCoordinatedRecording(
  session: CoordinatedRecordingSession,
  adapters: ModalityRecordingAdapter[],
): Promise<Partial<Record<ModalityId, { status: 'complete' | 'failed'; message?: string }>>> {
  const active = adapters.filter((adapter) => session.modalities.includes(adapter.id));
  const settled = await Promise.allSettled(active.map((adapter) => adapter.stop(session.id)));
  const result: Partial<Record<ModalityId, { status: 'complete' | 'failed'; message?: string }>> = {};
  settled.forEach((item, index) => {
    const id = active[index].id;
    result[id] = item.status === 'fulfilled'
      ? { status: 'complete' }
      : { status: 'failed', message: item.reason instanceof Error ? item.reason.message : String(item.reason) };
  });
  return result;
}

