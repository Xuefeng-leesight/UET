import { ENABLE_DEBUG_TESTING } from '@/app/config';

type PerfDetails = Record<string, unknown>;

type PerfPayload = {
  event: string;
  sinceRendererStartMs: number;
  details?: PerfDetails;
};

const longTaskWindowMs = 5000;
const rendererBootMs = typeof performance !== 'undefined' ? performance.now() : 0;
const hasIpcPerfChannel =
  typeof window !== 'undefined' &&
  !!window.ipcRenderer &&
  typeof window.ipcRenderer.send === 'function';

let lastLcpEntry: PerformanceEntry | null = null;
let lcpSent = false;
let longTaskFlushTimer: number | null = null;
let longTaskCount = 0;
let longTaskTotalDuration = 0;
let longTaskMaxDuration = 0;
let longTaskWindowStart = rendererBootMs;

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function sendPerfLog(event: string, details?: PerfDetails): void {
  if (!ENABLE_DEBUG_TESTING || !hasIpcPerfChannel) return;

  const payload: PerfPayload = {
    event,
    sinceRendererStartMs: roundMs(performance.now() - rendererBootMs),
    details,
  };

  try {
    window.ipcRenderer?.send('perf-log', payload);
  } catch (error) {
    console.error('[perf] renderer log send failed:', error);
  }
}

function trackNavigationTiming(): void {
  const navEntries = performance.getEntriesByType('navigation');
  const nav = navEntries[0] as PerformanceNavigationTiming | undefined;
  if (!nav) return;

  sendPerfLog('renderer-navigation-timing', {
    domContentLoadedEventEndMs: roundMs(nav.domContentLoadedEventEnd),
    loadEventEndMs: roundMs(nav.loadEventEnd),
    responseStartMs: roundMs(nav.responseStart),
    responseEndMs: roundMs(nav.responseEnd),
    transferSize: nav.transferSize ?? null,
  });
}

function observePaintEntries(): void {
  if (typeof PerformanceObserver === 'undefined') return;

  try {
    const paintObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === 'first-contentful-paint') {
          sendPerfLog('renderer-fcp', { startTimeMs: roundMs(entry.startTime) });
        }
      }
    });

    paintObserver.observe({ type: 'paint', buffered: true });
  } catch {
    // Unsupported observer type on some environments.
  }
}

function observeLcp(): void {
  if (typeof PerformanceObserver === 'undefined') return;

  try {
    const observer = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      if (!entries.length) return;
      lastLcpEntry = entries[entries.length - 1];
    });

    observer.observe({ type: 'largest-contentful-paint', buffered: true });

    const flushLcp = (reason: string) => {
      if (lcpSent || !lastLcpEntry) return;
      lcpSent = true;
      const lcpLike = lastLcpEntry as PerformanceEntry & { size?: number };
      sendPerfLog('renderer-lcp', {
        reason,
        startTimeMs: roundMs(lastLcpEntry.startTime),
        size: typeof lcpLike.size === 'number' ? lcpLike.size : null,
      });
      observer.disconnect();
    };

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        flushLcp('visibility-hidden');
      }
    });

    window.addEventListener(
      'pagehide',
      () => {
        flushLcp('pagehide');
      },
      { once: true },
    );

    window.setTimeout(() => {
      flushLcp('timeout-10s');
    }, 10000);
  } catch {
    // Unsupported observer type on some environments.
  }
}

function flushLongTaskSummary(reason: string): void {
  if (longTaskCount <= 0) return;

  const windowDurationMs = roundMs(performance.now() - longTaskWindowStart);
  sendPerfLog('renderer-longtask-summary', {
    reason,
    count: longTaskCount,
    totalDurationMs: roundMs(longTaskTotalDuration),
    maxDurationMs: roundMs(longTaskMaxDuration),
    windowDurationMs,
  });

  longTaskCount = 0;
  longTaskTotalDuration = 0;
  longTaskMaxDuration = 0;
  longTaskWindowStart = performance.now();
}

function observeLongTasks(): void {
  if (typeof PerformanceObserver === 'undefined') return;

  try {
    const longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTaskCount += 1;
        longTaskTotalDuration += entry.duration;
        longTaskMaxDuration = Math.max(longTaskMaxDuration, entry.duration);
      }
    });

    longTaskObserver.observe({ type: 'longtask', buffered: true });

    longTaskFlushTimer = window.setInterval(() => {
      flushLongTaskSummary('periodic');
    }, longTaskWindowMs);

    window.addEventListener(
      'beforeunload',
      () => {
        flushLongTaskSummary('beforeunload');
        if (longTaskFlushTimer !== null) {
          clearInterval(longTaskFlushTimer);
          longTaskFlushTimer = null;
        }
        longTaskObserver.disconnect();
      },
      { once: true },
    );
  } catch {
    // Unsupported observer type on some environments.
  }
}

export function initRendererPerformanceLogging(): void {
  if (!ENABLE_DEBUG_TESTING) return;

  sendPerfLog('renderer-bootstrap', {
    href: window.location.href,
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
  });

  trackNavigationTiming();
  observePaintEntries();
  observeLcp();
  observeLongTasks();
}

export function markRendererPerfCheckpoint(name: string, details?: PerfDetails): void {
  if (!ENABLE_DEBUG_TESTING || !name) return;
  sendPerfLog(name, details);
}
