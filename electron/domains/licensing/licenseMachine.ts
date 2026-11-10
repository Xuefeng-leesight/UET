import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const INVALID_VALUES = new Set([
  '', 'UNKNOWN', 'DEFAULT', 'TO BE FILLED BY O.E.M.',
  '00000000-0000-0000-0000-000000000000',
  'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF',
]);

function normalizeIdentifier(value: string): string {
  const normalized = value.trim().toUpperCase().split(/\s+/).join(' ');
  return INVALID_VALUES.has(normalized) ? '' : normalized;
}

function windowsMachineGuid(): string {
  if (process.platform !== 'win32') return '';
  const result = spawnSync(
    'reg.exe',
    ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
    { encoding: 'utf8', windowsHide: true, timeout: 5_000 },
  );
  const match = String(result.stdout || '').match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i);
  return normalizeIdentifier(match?.[1] || '');
}

function windowsBiosUuid(): string {
  if (process.platform !== 'win32') return '';
  const command = '(Get-CimInstance Win32_ComputerSystemProduct).UUID';
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'utf8', windowsHide: true, timeout: 8_000 },
  );
  return normalizeIdentifier(String(result.stdout || '').split(/\r?\n/)[0] || '');
}

function seedFilePath(userDataPath: string): string {
  return path.join(userDataPath, 'licensing', 'machine-seed.bin');
}

function loadSeed(userDataPath: string): string {
  if (!safeStorage.isEncryptionAvailable()) return '';
  try {
    return safeStorage.decryptString(fs.readFileSync(seedFilePath(userDataPath)));
  } catch {
    return '';
  }
}

function saveSeed(userDataPath: string, seed: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统安全存储不可用，无法生成受保护的机器标识。');
  }
  fs.mkdirSync(path.dirname(seedFilePath(userDataPath)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(seedFilePath(userDataPath), safeStorage.encryptString(seed), { mode: 0o600 });
}

function loadOrCreateFallbackSeed(userDataPath: string): string {
  const existing = loadSeed(userDataPath);
  if (existing) return existing;
  const seed = randomBytes(32).toString('base64url');
  saveSeed(userDataPath, seed);
  return seed;
}

export function buildMachineCode(userDataPath: string): string {
  const machineGuid = windowsMachineGuid();
  const biosUuid = windowsBiosUuid();

  // 硬件标识优先，保证机器码稳定可复现。
  // 仅当存在「轮换 seed」（解绑时写入）时，才附加 SEED 段——正常情况机器码不变，
  // 解绑轮换 seed 后机器码改变，使已解绑设备的旧 License（device_hash 不匹配）失效。
  const hardwareParts: string[] = [];
  if (machineGuid) hardwareParts.push(`MG=${machineGuid}`);
  if (biosUuid) hardwareParts.push(`BIOS=${biosUuid}`);
  const seed = loadSeed(userDataPath);

  let descriptor: string;
  if (hardwareParts.length > 0) {
    descriptor = `UST-MACHINE-V1|WINDOWS|${hardwareParts.join('|')}`;
    if (seed) descriptor += `|SEED=${seed}`;
  } else {
    descriptor = `UST-MACHINE-V1|${process.platform.toUpperCase()}|SEED=${seed || loadOrCreateFallbackSeed(userDataPath)}`;
  }

  const digest = createHash('sha256').update(descriptor, 'utf8').digest('hex');
  return `UST-MACHINE-V1|SHA256=${digest}`;
}

export function rotateMachineSeed(userDataPath: string): void {
  // 解绑时轮换本地 seed，使下次 buildMachineCode 产出不同机器码，
  // 从而让旧的离线 License（内嵌旧 device_hash）无法再导入本机。
  saveSeed(userDataPath, randomBytes(32).toString('base64url'));
}
