import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

// Execute the actual backend payload builder, isolated from Django/database I/O.
const payloads = JSON.parse(execFileSync('python3', ['-c', `
import ast, json
from pathlib import Path
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
source = ast.parse(Path('backend/license_admin/apps/licensing/services.py').read_text())
functions = [n for n in source.body if isinstance(n, ast.FunctionDef) and n.name in ('iso_utc', 'license_payload')]
namespace = dict(datetime=datetime, timedelta=timedelta, datetime_timezone=timezone, License=object, LicenseDevice=object)
namespace['active_modules'] = lambda obj, now: [dict(code='eye_tracking', name='Eye tracking', expires_at=obj.expires_at.isoformat())]
exec(compile(ast.Module(body=functions, type_ignores=[]), '<production licensing services>', 'exec'), namespace)
start = datetime(2026, 10, 1, tzinfo=timezone.utc)
end = datetime(2027, 1, 1, tzinfo=timezone.utc)
license = SimpleNamespace(id='license', customer_id='customer', customer=SimpleNamespace(name='Test'), starts_at=start, expires_at=end, offline_grace_days=0)
device = SimpleNamespace(id='device', machine_hash='placeholder')
results = []
for mode in ('online', 'offline'):
    result = namespace['license_payload'](license, device, start, activation_mode=mode)
    assert result['offline_valid_until'] == result['expires_at']
    results.append(result)
license.offline_grace_days = 8
assert namespace['license_payload'](license, device, start)['offline_valid_until'] == '2026-10-09T00:00:00Z'
assert namespace['license_payload'](license, device, end-timedelta(days=1))['offline_valid_until'] == '2027-01-01T00:00:00Z'
print(json.dumps(results))
`], { encoding: 'utf8' }));
const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('electron/domains/licensing/licenseCrypto.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, Buffer, require: () => crypto });
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const trustedSigningKeys = { test: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url') };
function sign(payload) {
  return { schema_version: 1, algorithm: 'Ed25519', key_id: 'test', payload,
    signature: crypto.sign(null, Buffer.from(exports.canonicalJson(payload)), privateKey).toString('base64url') };
}
for (const payload of payloads) {
  payload.device_hash = exports.hashMachineCode('test-machine');
  const envelope = sign(payload);
  const evaluate = (date, extra = {}) => exports.evaluateEnvelope({ envelope, trustedSigningKeys, machineCode: 'test-machine', now: new Date(date), ...extra }).state;
  assert.equal(evaluate('2026-11-01T00:00:00Z'), 'valid', 'Unused for a month, no network required');
  assert.equal(evaluate('2026-12-31T23:59:59.999Z'), 'valid');
  assert.equal(evaluate('2027-01-01T00:00:00Z'), 'expired');
  assert.equal(evaluate('2026-09-30T00:00:00Z'), 'not-started');
  assert.equal(evaluate('2026-11-01T00:00:00Z', { machineCode: 'other' }), 'device-mismatch');
  assert.equal(evaluate('2026-11-01T00:00:00Z', { maxTrustedTime: '2026-12-01T00:00:00Z' }), 'clock-rollback');
  assert.equal(evaluate('2026-11-01T00:00:00Z', { envelope: { ...envelope, payload: { ...payload, expires_at: '2030-01-01T00:00:00Z' } } }), 'invalid-signature');
}
console.log('License validity: backend zero/positive grace, both activation modes, offline month, expiry, binding, signature and clock checks passed.');

// Keep one production service instance alive across expiry, with no network.
let clock = new Date('2026-11-01T00:00:00Z');
let stored = { schemaVersion: 1, envelope: sign(payloads[0]), maxTrustedTime: payloads[0].issued_at };
let publishedModules;
const serviceExports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('electron/domains/licensing/licenseService.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, { exports: serviceExports, Buffer, require: name => {
  if (name === 'node:os') return { hostname: () => 'test' };
  if (name === './licenseApi') return { checkLicenseStatus: async () => { throw new Error('offline'); } };
  if (name === './licenseCrypto') return { ...exports, evaluateEnvelope: params => exports.evaluateEnvelope({ ...params, now: clock }) };
  if (name === './licenseMachine') return { buildMachineCode: () => 'test-machine' };
  if (name === './licenseStorage') return { createLicenseStorage: () => ({ load: () => stored, save: value => { stored = value; } }) };
  throw new Error(name);
}});
const service = serviceExports.createLicenseService({ apiOrigin: 'https://unused.invalid', trustedSigningKeys,
  userDataPath: '/unused', clientVersion: 'test', onModulesChanged: modules => { publishedModules = modules; } });
await service.initialize();
assert.equal(service.getState().canUseApp, true);
assert.equal(service.hasModule('eye_tracking'), true);
clock = new Date('2027-01-01T00:00:00Z');
assert.equal(service.hasModule('eye_tracking'), false, 'Core operations must not use cached authorization after expiry');
assert.equal(service.getState().state, 'expired');
assert.equal(publishedModules.length, 0);
console.log('Running service revalidates expiry and removes module access without network.');
