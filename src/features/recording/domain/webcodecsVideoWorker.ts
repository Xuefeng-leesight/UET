type WorkerInitMessage = {
  type: 'init';
  url: string;
};

type WorkerCloseMessage = {
  type: 'close';
};

type EncodedHeader = {
  codec: 'avc' | 'hevc';
  width: number;
  height: number;
  seq: number;
  timestamp: number;
  keyframe: boolean;
  streamGeneration: number;
  payloadLength: number;
  headerLength: number;
};

type WebCodecsWorkerContext = {
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
  onmessage: ((event: MessageEvent<WorkerInitMessage | WorkerCloseMessage>) => void) | null;
  VideoDecoder?: typeof VideoDecoder;
  EncodedVideoChunk?: typeof EncodedVideoChunk;
  VideoFrame?: typeof VideoFrame;
};

const ctx = self as unknown as WebCodecsWorkerContext;

let ws: WebSocket | null = null;
let decoder: VideoDecoder | null = null;
let configuredCodec = '';
let configuredWidth = 0;
let configuredHeight = 0;
let waitForKeyframe = true;
let keyframeWaitPackets = 0;
let dropped = 0;
let decoded = 0;
let packets = 0;
let badPackets = 0;
let decodeErrors = 0;
let lastSeq: number | null = null;
let lastStreamGeneration: number | null = null;
let closed = false;
let lifecycleGeneration = 0;
let packetChain: Promise<void> = Promise.resolve();
let diagnosticTimer: ReturnType<typeof setInterval> | null = null;
let pendingPackets = 0;
let maxPendingPackets = 0;
let maxPacketWaitMs = 0;
let maxArrivalGapMs = 0;
let lastArrivalAt = 0;
let maxDecodeMs = 0;
let maxDecodeQueue = 0;
const decodeStarted = new Map<number, number>();

const MAGIC_0 = 0x4d; // M
const MAGIC_1 = 0x52; // R
const MAGIC_2 = 0x54; // T
const MAGIC_3 = 0x56; // V
const HEADER_LENGTH = 32;
// A short scheduling spike is not a decoder failure. Closing and immediately
// recreating a Media Foundation HEVC decoder while GPU work is still queued can
// destabilize some Windows display drivers. Fall back once a genuinely stale
// queue is observed instead of repeatedly churning hardware decoder contexts.
const MAX_DECODE_QUEUE_SIZE = 24;
const MAX_KEYFRAME_WAIT_PACKETS = 420;

function postStatus(status: string, extra: Record<string, unknown> = {}) {
  ctx.postMessage({ type: 'status', status, ...extra });
}

function postFallback(reason: string) {
  ctx.postMessage({ type: 'fallback', reason });
}

function closeDecoder(options: { resetDecodeErrors?: boolean } = {}) {
  const { resetDecodeErrors = true } = options;
  try {
    decoder?.close?.();
  } catch {}
  decoder = null;
  decodeStarted.clear();
  configuredCodec = '';
  configuredWidth = 0;
  configuredHeight = 0;
  waitForKeyframe = true;
  keyframeWaitPackets = 0;
  if (resetDecodeErrors) decodeErrors = 0;
}

function invalidateDecoder() {
  // A reset decoder is unconfigured and cannot be reused. Close it completely,
  // but preserve the consecutive-error count so repeated failures can still
  // activate the fallback threshold.
  closeDecoder({ resetDecodeErrors: false });
}

function closeAll() {
  closed = true;
  if (diagnosticTimer !== null) clearInterval(diagnosticTimer);
  diagnosticTimer = null;
  lifecycleGeneration += 1;
  lastSeq = null;
  lastStreamGeneration = null;
  try {
    ws?.close();
  } catch {}
  ws = null;
  closeDecoder();
}

function parseHeader(buffer: ArrayBuffer): EncodedHeader | null {
  if (buffer.byteLength < HEADER_LENGTH) return null;
  const view = new DataView(buffer);
  if (
    view.getUint8(0) !== MAGIC_0 ||
    view.getUint8(1) !== MAGIC_1 ||
    view.getUint8(2) !== MAGIC_2 ||
    view.getUint8(3) !== MAGIC_3
  ) {
    return null;
  }

  const version = view.getUint8(4);
  if (version !== 1) return null;

  const codecId = view.getUint8(5);
  const flags = view.getUint8(6);
  const width = view.getUint16(8, true);
  const height = view.getUint16(10, true);
  const seq = view.getUint32(12, true);
  const timestamp = view.getFloat64(16, true);
  const payloadLength = view.getUint32(24, true);
  const streamGeneration = view.getUint32(28, true);
  if (payloadLength <= 0 || HEADER_LENGTH + payloadLength > buffer.byteLength) {
    return null;
  }

  return {
    codec: codecId === 1 ? 'avc' : 'hevc',
    width,
    height,
    seq,
    timestamp,
    keyframe: (flags & 0x01) === 0x01,
    streamGeneration,
    payloadLength,
    headerLength: HEADER_LENGTH,
  };
}

async function chooseConfig(header: EncodedHeader) {
  const VideoDecoderCtor = ctx.VideoDecoder;
  if (!VideoDecoderCtor || !ctx.EncodedVideoChunk) {
    throw new Error('WebCodecs VideoDecoder is not available');
  }

  const candidates =
    header.codec === 'avc'
      ? ['avc1.42E01F', 'avc1.4D401F', 'avc1.640028']
      : ['hev1.1.6.L120.B0', 'hev1.1.6.L93.B0', 'hvc1.1.6.L120.B0', 'hvc1.1.6.L93.B0'];

  const probeResults: Array<{ codec: string; supported: boolean; error?: string }> = [];

  for (const codec of candidates) {
    const config: VideoDecoderConfig = {
      codec,
      codedWidth: Math.max(1, header.width || 1280),
      codedHeight: Math.max(1, header.height || 720),
      hardwareAcceleration: 'prefer-hardware',
      optimizeForLatency: true,
    };
    if (typeof VideoDecoderCtor.isConfigSupported !== 'function') {
      postStatus('decoder-config-probe-skipped', { codec, reason: 'isConfigSupported is not available' });
      return config;
    }
    try {
      const support = await VideoDecoderCtor.isConfigSupported(config);
      probeResults.push({ codec, supported: Boolean(support?.supported) });
      if (support?.supported) {
        postStatus('decoder-config-supported', { codec, width: config.codedWidth, height: config.codedHeight });
        return support.config || config;
      }
    } catch (error: unknown) {
      probeResults.push({ codec, supported: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  postStatus('decoder-config-unsupported', { codec: header.codec, probes: probeResults });
  throw new Error(`${header.codec.toUpperCase()} is not supported by this browser`);
}

async function ensureDecoder(header: EncodedHeader, generation: number) {
  const width = Math.max(1, header.width || 1280);
  const height = Math.max(1, header.height || 720);
  if (decoder && configuredWidth === width && configuredHeight === height) return;

  postStatus('decoder-reconfigure', { previousWidth: configuredWidth, previousHeight: configuredHeight, width, height });
  const configureStarted = performance.now();
  closeDecoder({ resetDecodeErrors: false });
  const config = await chooseConfig({ ...header, width, height });
  if (closed || generation !== lifecycleGeneration) return;

  const nextDecoder = new ctx.VideoDecoder({
    output(frame: VideoFrame) {
      if (closed || generation !== lifecycleGeneration || decoder !== nextDecoder) {
        try {
          frame.close();
        } catch {}
        return;
      }
      const submittedAt = decodeStarted.get(frame.timestamp);
      if (submittedAt !== undefined) maxDecodeMs = Math.max(maxDecodeMs, performance.now() - submittedAt);
      decodeStarted.delete(frame.timestamp);
      decoded += 1;
      decodeErrors = 0;
      ctx.postMessage(
        {
          type: 'frame',
          outputEpochMs: performance.timeOrigin + performance.now(),
          frame,
          width: frame.displayWidth || frame.codedWidth || width,
          height: frame.displayHeight || frame.codedHeight || height,
          decoded,
          dropped,
        },
        [frame as unknown as Transferable],
      );
    },
    error(error: Error) {
      if (closed || generation !== lifecycleGeneration || decoder !== nextDecoder) return;
      decodeErrors += 1;
      postStatus('decode-error', { message: error?.message || String(error), decoded, dropped });
      if (decodeErrors >= 8) {
        postFallback('too many WebCodecs decode errors');
        closeAll();
        return;
      }
      invalidateDecoder();
    },
  });
  decoder = nextDecoder;
  try {
    nextDecoder.configure(config);
  } catch (error) {
    if (decoder === nextDecoder) invalidateDecoder();
    throw error;
  }
  configuredCodec = config.codec;
  configuredWidth = width;
  configuredHeight = height;
  waitForKeyframe = true;
  keyframeWaitPackets = 0;
  postStatus('decoder-configured', { codec: configuredCodec, width, height, configureMs: performance.now() - configureStarted, hardwareAccelerationRequested: config.hardwareAcceleration, actualDecoderBackend: 'not-exposed-by-webcodecs' });
}

async function handleEncodedPacket(buffer: ArrayBuffer, generation: number) {
  if (closed || generation !== lifecycleGeneration) return;
  const header = parseHeader(buffer);
  if (!header) {
    badPackets += 1;
    if (badPackets >= 8) {
      postFallback('encoded stream header is invalid');
      closeAll();
    }
    return;
  }

  badPackets = 0;
  packets += 1;
  if (packets === 1 || packets % 120 === 0 || header.keyframe) {
    postStatus('packet', {
      codec: header.codec,
      seq: header.seq,
      streamGeneration: header.streamGeneration,
      width: header.width,
      height: header.height,
      keyframe: header.keyframe,
      packets,
      decoded,
      dropped,
    });
  }

  const expectedSeq = lastSeq === null ? null : (lastSeq + 1) >>> 0;
  const streamGenerationChanged =
    lastStreamGeneration !== null && header.streamGeneration !== lastStreamGeneration;
  const seqGap = expectedSeq !== null && header.seq !== expectedSeq;
  if (streamGenerationChanged || seqGap) {
    postStatus(streamGenerationChanged ? 'stream-generation-reset' : 'packet-gap-reset', {
      codec: header.codec,
      seq: header.seq,
      expectedSeq,
      streamGeneration: header.streamGeneration,
      previousStreamGeneration: lastStreamGeneration,
      packets,
      decoded,
      dropped,
      keyframe: header.keyframe,
    });
    closeDecoder();
  }
  lastSeq = header.seq;
  lastStreamGeneration = header.streamGeneration;

  await ensureDecoder(header, generation);
  if (closed || generation !== lifecycleGeneration) return;
  if (!decoder) return;

  if (decoder.decodeQueueSize > MAX_DECODE_QUEUE_SIZE) {
    dropped += 1;
    postStatus('decode-queue-overflow', {
      codec: header.codec,
      seq: header.seq,
      packets,
      decoded,
      dropped,
      decodeQueueSize: decoder.decodeQueueSize,
      keyframe: header.keyframe,
    });
    postFallback('WebCodecs decode queue remained overloaded');
    closeAll();
    return;
  }

  if (waitForKeyframe && !header.keyframe) {
    dropped += 1;
    keyframeWaitPackets += 1;
    if (keyframeWaitPackets === 1 || keyframeWaitPackets % 30 === 0) {
      postStatus('waiting-keyframe', {
        codec: header.codec,
        seq: header.seq,
        packets,
        keyframeWaitPackets,
        dropped,
      });
    }
    if (keyframeWaitPackets >= MAX_KEYFRAME_WAIT_PACKETS) {
      postFallback('encoded stream did not provide a decodable keyframe');
      closeAll();
    }
    return;
  }
  waitForKeyframe = false;
  keyframeWaitPackets = 0;

  const chunkData = buffer.slice(header.headerLength, header.headerLength + header.payloadLength);
  const chunk = new ctx.EncodedVideoChunk({
    type: header.keyframe ? 'key' : 'delta',
    timestamp: Math.max(0, Math.round(header.timestamp || performance.now() * 1000)),
    data: chunkData,
  });
  try {
    // Bound diagnostics even if a decoder stops producing output.
    if (decodeStarted.size >= 240) decodeStarted.delete(decodeStarted.keys().next().value!);
    decodeStarted.set(chunk.timestamp, performance.now());
    decoder.decode(chunk);
    maxDecodeQueue = Math.max(maxDecodeQueue, decoder.decodeQueueSize);
  } catch (error: unknown) {
    decodeErrors += 1;
    postStatus('decode-error', {
      message: error instanceof Error ? error.message : String(error),
      decoded,
      dropped,
      packets,
      seq: header.seq,
      keyframe: header.keyframe,
    });
    invalidateDecoder();
    if (decodeErrors >= 8) {
      postFallback('too many WebCodecs decode errors');
      closeAll();
    }
  }
}

function init(url: string) {
  if (!ctx.VideoDecoder || !ctx.EncodedVideoChunk || !ctx.VideoFrame) {
    postFallback('WebCodecs is not available');
    return;
  }

  closed = false;
  lifecycleGeneration += 1;
  const generation = lifecycleGeneration;
  packetChain = Promise.resolve();
  pendingPackets = maxPendingPackets = maxPacketWaitMs = maxArrivalGapMs = lastArrivalAt = maxDecodeMs = maxDecodeQueue = 0;
  let previousPackets = packets;
  let previousDecoded = decoded;
  let previousAt = performance.now();
  diagnosticTimer = setInterval(() => {
    const now = performance.now();
    postStatus('pipeline-metrics', {
      windowMs: now - previousAt, receivedPackets: packets - previousPackets,
      outputFrames: decoded - previousDecoded, pendingPackets, maxPendingPackets,
      maxPacketWaitMs, maxArrivalGapMs, lastPacketAgeMs: lastArrivalAt ? now - lastArrivalAt : null,
      maxDecodeMs, maxDecodeQueue, decodeQueueSize: decoder?.decodeQueueSize ?? null,
      waitForKeyframe, dropped,
    });
    previousAt = now; previousPackets = packets; previousDecoded = decoded;
    maxPendingPackets = pendingPackets;
    maxPacketWaitMs = maxArrivalGapMs = maxDecodeMs = maxDecodeQueue = 0;
  }, 2000);
  const socket = new WebSocket(url);
  ws = socket;
  socket.binaryType = 'arraybuffer';
  socket.onopen = () => {
    if (!closed && generation === lifecycleGeneration && ws === socket) postStatus('ws-open');
  };
  socket.onclose = () => {
    if (!closed && generation === lifecycleGeneration && ws === socket) {
      postStatus('ws-closed');
      closeDecoder();
    }
  };
  socket.onerror = () => {
    if (!closed && generation === lifecycleGeneration && ws === socket) {
      postFallback('encoded WebSocket failed');
    }
  };
  socket.onmessage = (event) => {
    if (typeof event.data === 'string') {
      return;
    }
    const receivedAt = performance.now();
    if (lastArrivalAt) maxArrivalGapMs = Math.max(maxArrivalGapMs, receivedAt - lastArrivalAt);
    lastArrivalAt = receivedAt;
    pendingPackets += 1;
    maxPendingPackets = Math.max(maxPendingPackets, pendingPackets);
    const buffer = event.data as ArrayBuffer;
    packetChain = packetChain.then(async () => {
      if (closed || generation !== lifecycleGeneration || ws !== socket) return;
      pendingPackets -= 1;
      maxPacketWaitMs = Math.max(maxPacketWaitMs, performance.now() - receivedAt);
      await handleEncodedPacket(buffer, generation);
    }).catch((error) => {
      if (closed || generation !== lifecycleGeneration || ws !== socket) return;
      const message = error?.message || String(error);
      postStatus('packet-error', { message });
      if (/not supported|not available/i.test(message)) {
        postFallback(message);
        closeAll();
      }
    });
  };
}

ctx.onmessage = (event: MessageEvent<WorkerInitMessage | WorkerCloseMessage>) => {
  const msg = event.data;
  if (msg?.type === 'init') {
    closeAll();
    init(msg.url);
  } else if (msg?.type === 'close') {
    closeAll();
  }
};
