import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';
import path from 'path';
import { readFileSync } from 'fs';
import { ENABLE_LICENSE_AUTHORIZATION, DEFAULT_API_ORIGIN, DEFAULT_TRUSTED_SIGNING_KEYS } from './src/app/config';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    const packageJsonPath = path.resolve(__dirname, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version?: string };
    const appVersion = packageJson.version ?? '0.0.0';
    const disableElectron = env.VITE_DISABLE_ELECTRON === '1' || process.env.VITE_DISABLE_ELECTRON === '1';
    const electronDefine = {
      __ENABLE_LICENSE_AUTHORIZATION__: JSON.stringify(ENABLE_LICENSE_AUTHORIZATION),
      __UST_API_ORIGIN__: JSON.stringify(env.UST_API_ORIGIN || DEFAULT_API_ORIGIN),
      __UST_TRUSTED_SIGNING_KEYS__: JSON.stringify(
        env.UST_TRUSTED_SIGNING_KEYS || JSON.stringify(DEFAULT_TRUSTED_SIGNING_KEYS)
      ),
      __UST_EXPECTED_WINDOWS_PUBLISHER__: JSON.stringify(env.UST_EXPECTED_WINDOWS_PUBLISHER || ''),
    };
    return {
      server: {
        port: 31873,
        host: '0.0.0.0',
      },
      plugins: [
        react(),
        !disableElectron
          ? electron({
              main: {
                entry: 'electron/main.ts',
                vite: { define: electronDefine, build: { rollupOptions: { external: ['serialport'] } } },
              },
              preload: {
                input: 'electron/preload.ts',
              },
              renderer: {},
            })
          : undefined,
      ].filter(Boolean),
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        __APP_VERSION__: JSON.stringify(appVersion),
        ...electronDefine,
      },
      // The calibration worker imports OpenCV lazily. Prebundle it at startup
      // so first calibration does not discover a new dependency and reload UI.
      optimizeDeps: { include: ['@techstark/opencv-js'] },
      worker: {
        format: 'es',
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, 'src'),
          '@shared': path.resolve(__dirname, 'shared'),
        }
      }
    };
});
