declare const __UST_API_ORIGIN__: string | undefined;
declare const __UST_TRUSTED_SIGNING_KEYS__: string | undefined;
declare const __UST_EXPECTED_WINDOWS_PUBLISHER__: string | undefined;

function buildValue(compiled: string | undefined, runtime: string | undefined): string {
  return String(runtime || compiled || '').trim();
}

export function getLicenseClientConfig(isPackaged: boolean): {
  apiOrigin: string;
  trustedSigningKeys: Record<string, string>;
  expectedWindowsPublisher: string;
} {
  const compiledOrigin = typeof __UST_API_ORIGIN__ === 'string' ? __UST_API_ORIGIN__ : '';
  const compiledKeys = typeof __UST_TRUSTED_SIGNING_KEYS__ === 'string'
    ? __UST_TRUSTED_SIGNING_KEYS__
    : '';
  const apiOrigin = buildValue(compiledOrigin, process.env.UST_API_ORIGIN).replace(/\/$/, '')
    || (isPackaged ? '' : 'http://127.0.0.1:8000');
  const rawKeys = buildValue(compiledKeys, process.env.UST_TRUSTED_SIGNING_KEYS);
  const compiledPublisher = typeof __UST_EXPECTED_WINDOWS_PUBLISHER__ === 'string'
    ? __UST_EXPECTED_WINDOWS_PUBLISHER__
    : '';
  const expectedWindowsPublisher = buildValue(compiledPublisher, process.env.UST_EXPECTED_WINDOWS_PUBLISHER);
  let trustedSigningKeys: Record<string, string> = {};
  if (rawKeys) {
    try {
      const parsed = JSON.parse(rawKeys) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        trustedSigningKeys = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>)
            .filter(([, value]) => typeof value === 'string' && value.trim())
            .map(([key, value]) => [key, String(value).trim()]),
        );
      }
    } catch {
      trustedSigningKeys = {};
    }
  }
  return { apiOrigin, trustedSigningKeys, expectedWindowsPublisher };
}
