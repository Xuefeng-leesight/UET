import React from 'react';

const WEB_STIMULUS_SANDBOX = [
  'allow-scripts',
  'allow-same-origin',
  'allow-forms',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
  'allow-pointer-lock',
  'allow-modals',
  'allow-downloads',
  'allow-presentation',
].join(' ');

const WEB_STIMULUS_ALLOW = [
  'autoplay',
  'fullscreen',
  'clipboard-read',
  'clipboard-write',
  'encrypted-media',
  'picture-in-picture',
  'accelerometer',
  'gyroscope',
].join('; ');

export const normalizeWebStimulusUrl = (value: unknown): string => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^\/\//.test(raw)) return `https:${raw}`;
  return `https://${raw}`;
};

export const isWebStimulusUrl = (value: unknown): boolean => /^(https?:)?\/\//i.test(String(value ?? '').trim());

interface WebStimulusFrameProps {
  url: unknown;
  title?: string;
  containerClassName?: string;
  iframeClassName?: string;
  showStatus?: boolean;
}

const WebStimulusFrame: React.FC<WebStimulusFrameProps> = ({
  url,
  title = 'Web stimulus',
  containerClassName = 'relative h-full w-full bg-white',
  iframeClassName = 'h-full w-full border-0 bg-white',
  showStatus = true,
}) => {
  const normalizedUrl = React.useMemo(() => normalizeWebStimulusUrl(url), [url]);
  const [reloadKey, setReloadKey] = React.useState(0);
  const [loaded, setLoaded] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [timedOut, setTimedOut] = React.useState(false);
  const loadedRef = React.useRef(false);

  React.useEffect(() => {
    loadedRef.current = false;
    setLoaded(false);
    setFailed(false);
    setTimedOut(false);
    if (!normalizedUrl) return;
    const timeoutId = window.setTimeout(() => {
      if (!loadedRef.current) {
        setTimedOut(true);
      }
    }, 10000);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [normalizedUrl, reloadKey]);

  if (!normalizedUrl) {
    return (
      <div className={containerClassName}>
        <div className="absolute inset-0 flex items-center justify-center bg-white text-xs text-slate-500">
          网页地址为空
        </div>
      </div>
    );
  }

  const showLoadStatus = showStatus && !loaded && (failed || timedOut);

  return (
    <div className={containerClassName}>
      <iframe
        key={`${normalizedUrl}:${reloadKey}`}
        src={normalizedUrl}
        title={title}
        className={iframeClassName}
        sandbox={WEB_STIMULUS_SANDBOX}
        allow={WEB_STIMULUS_ALLOW}
        referrerPolicy="no-referrer-when-downgrade"
        loading="eager"
        onLoad={() => {
          loadedRef.current = true;
          setLoaded(true);
          setFailed(false);
          setTimedOut(false);
        }}
        onError={() => {
          setFailed(true);
        }}
      />
      {showLoadStatus && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-white/85 px-6 text-center">
          <div className="max-w-sm rounded-md border border-slate-200 bg-white px-4 py-3 text-slate-700 shadow-sm">
            <div className="text-sm font-medium">网页加载较慢或站点禁止嵌入</div>
            <div className="mt-1 text-xs text-slate-500" data-i18n-skip="true">
              {normalizedUrl}
            </div>
            <button
              type="button"
              className="pointer-events-auto mt-3 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              onClick={() => setReloadKey((value) => value + 1)}
            >
              重新加载
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default WebStimulusFrame;
