import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { shell } from 'electron';
import type { LicenseService } from '../licensing/licenseService';

function safeFilename(value: string, fallback: string): string {
  const cleaned = path.basename(value.replace(/["']/g, '').trim());
  return cleaned && cleaned.length <= 180 ? cleaned : fallback;
}

function filenameFromDisposition(value: string | null, fallback: string): string {
  if (!value) return fallback;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1];
  if (encoded) {
    try { return safeFilename(decodeURIComponent(encoded), fallback); } catch {}
  }
  return safeFilename(/filename="?([^";]+)"?/i.exec(value)?.[1] || '', fallback);
}

function powershellQuote(value: string): string {
  return value.replace(/'/g, "''");
}

function verifyAuthenticode(filePath: string, expectedPublisher: string): { ok: boolean; message?: string } {
  if (process.platform !== 'win32') return { ok: false, message: '当前平台暂不支持自动安装。' };
  if (!expectedPublisher.trim()) return { ok: false, message: '正式包尚未配置预期的 Windows 代码签名发布者。' };
  const script = [
    `$signature = Get-AuthenticodeSignature -LiteralPath '${powershellQuote(filePath)}'`,
    `if ($signature.Status -ne 'Valid') { Write-Error ('SIGNATURE_' + $signature.Status); exit 2 }`,
    `$subject = $signature.SignerCertificate.Subject`,
    `if ($subject -notlike '*${powershellQuote(expectedPublisher)}*') { Write-Error 'PUBLISHER_MISMATCH'; exit 3 }`,
  ].join('; ');
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 },
  );
  if (result.status !== 0) {
    return { ok: false, message: result.status === 3 ? '安装包发布者与预期不一致。' : '安装包代码签名无效。' };
  }
  return { ok: true };
}

export function createUpdateService(deps: {
  licenseService: LicenseService;
  tempPath: string;
  clientVersion: string;
  apiOrigin: string;
  expectedWindowsPublisher: string;
  quitApplication: () => void;
}) {
  async function downloadAndInstall(channel: 'stable' | 'beta' = 'stable') {
    const update = await deps.licenseService.checkUpdate(channel);
    if (!update.ok) return update;
    if (!update.updateAvailable || !update.release) {
      return { ok: false, code: 'UPDATE_NOT_AVAILABLE', message: '当前已经是最新版本。' };
    }
    const release = update.release;
    const url = new URL(release.download_url);
    if (url.origin !== new URL(deps.apiOrigin).origin || !url.pathname.startsWith('/api/v1/client/releases/')) {
      return { ok: false, code: 'UNTRUSTED_DOWNLOAD_URL', message: '安装包下载地址不属于已配置的 UST 后台。' };
    }
    url.searchParams.set('machine_hash', deps.licenseService.getMachineHash());
    url.searchParams.set('client_version', deps.clientVersion);
    const response = await fetch(url, { headers: { Accept: 'application/octet-stream', 'X-Request-ID': randomUUID() } });
    if (!response.ok || !response.body) {
      return { ok: false, code: `HTTP_${response.status}`, message: '下载安装包失败。' };
    }
    const fallback = `UST-${release.version}-setup.exe`;
    const filename = filenameFromDisposition(response.headers.get('content-disposition'), fallback);
    if (!/\.(exe|msi)$/i.test(filename)) {
      return { ok: false, code: 'UNSUPPORTED_INSTALLER', message: '自动更新只允许签名后的 EXE 或 MSI 安装包。' };
    }
    const directory = path.join(deps.tempPath, 'ust-updates');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filePath = path.join(directory, `${randomUUID()}-${filename}`);
    const stream = fs.createWriteStream(filePath, { mode: 0o600 });
    const reader = response.body.getReader();
    const digest = createHash('sha256');
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const buffer = Buffer.from(chunk.value);
        size += buffer.length;
        if (size > release.file_size + 1024) throw new Error('安装包大小超过后台声明值。');
        digest.update(buffer);
        if (!stream.write(buffer)) await once(stream, 'drain');
      }
      stream.end();
      await once(stream, 'finish');
      if (size !== release.file_size || digest.digest('hex').toLowerCase() !== release.file_sha256.toLowerCase()) {
        throw new Error('安装包 SHA-256 或文件大小校验失败。');
      }
      const signature = verifyAuthenticode(filePath, deps.expectedWindowsPublisher);
      if (!signature.ok) throw new Error(signature.message);
      const openError = await shell.openPath(filePath);
      if (openError) throw new Error(`无法启动安装器：${openError}`);
      setTimeout(() => deps.quitApplication(), 500);
      return { ok: true, version: release.version };
    } catch (error) {
      stream.destroy();
      try { fs.unlinkSync(filePath); } catch {}
      return { ok: false, code: 'UPDATE_INSTALL_FAILED', message: error instanceof Error ? error.message : '更新安装失败。' };
    }
  }

  return { downloadAndInstall };
}

export type UpdateService = ReturnType<typeof createUpdateService>;
