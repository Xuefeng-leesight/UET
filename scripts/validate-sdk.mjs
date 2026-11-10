import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = process.cwd();
const sdkBase = path.resolve(process.env.MRT_SDK_ROOT || path.join(root, 'SDK'));
const vendorBase = path.join(sdkBase, 'invensun_7');
const sdkRoot = path.basename(sdkBase) === 'invensun_7' ? sdkBase : vendorBase;
const manifestPath = process.env.MRT_SDK_MANIFEST
  ? path.resolve(process.env.MRT_SDK_MANIFEST)
  : null;
const required = [
  'A8/include/_7i_sdk.h',
  'A8/bin/windows/x64/A8_Release/USERSDK.dll',
  'A8/bin/windows/x64/A8_Release/aSeeX.dll',
  'A8/bin/windows/x64/A8_Release/config.ini',
  'A8/samples/A8/python3/_7i_types.py',
  'Pro/include/_7i_sdk.h',
  'Pro/bin/windows/x64/Pro200_Release/USERSDK.dll',
  'Pro/bin/windows/x64/Pro200_Release/aSeeX.dll',
  'Pro/bin/windows/x64/Pro200_Release/config.ini',
  'Pro/samples/Pro200/python3/_7i_types.py',
  'aSeeGlassesPlus/include/_7i_sdk.h',
  'aSeeGlassesPlus/bin/USERSDK.dll',
  'aSeeGlassesPlus/bin/aSeeX.dll',
  'aSeeGlassesPlus/bin/config/config.ini',
  'aSeeGlassesPlus/samples/python3/sdk_types.py',
];

const missing = required.filter((relative) => !fs.existsSync(path.join(sdkRoot, relative)));
if (missing.length > 0) {
  console.error(missing.map((relative) => `${relative}: required SDK release file is missing`).join('\n'));
  process.exit(1);
}

const manifest = {
  generatedAt: new Date().toISOString(),
  sdkRoot,
  files: required.map((relative) => {
    const absolute = path.join(sdkRoot, relative);
    const contents = fs.readFileSync(absolute);
    return {
      path: relative,
      size: contents.byteLength,
      sha256: crypto.createHash('sha256').update(contents).digest('hex'),
    };
  }),
};

if (manifestPath) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

console.log(`SDK validation passed (${required.length} release files${manifestPath ? `; manifest: ${manifestPath}` : ''}).`);
