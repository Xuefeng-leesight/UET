import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

function load(file, globals, dependencies) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(source, {
    exports, console, ...globals,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename: file });
  return exports;
}

for (const [stored, expected] of [
  ['deep-blue', 'dark'], ['bright', 'modern-light'], ['dark', 'dark'],
  ['modern-light', 'modern-light'], ['unknown', 'modern-light'], [null, 'modern-light'],
]) {
  let current = stored;
  let writes = 0;
  const sent = [];
  const document = { documentElement: { dataset: {} } };
  const theme = load('src/app/theme/theme.ts', {
    document,
    localStorage: { getItem: () => current, setItem: (_key, value) => { current = value; writes++; } },
  }, { '@/infrastructure/electron/ipcEvents': { ipcEvents: { send: (...args) => sent.push(args) } } });
  theme.migrateLegacyTheme();
  const effective = theme.getStoredTheme() || theme.DEFAULT_THEME;
  assert.equal(effective, expected, `Startup preference: ${stored}`);
  if (stored === 'deep-blue' || stored === 'bright') assert.equal(current, expected, 'Legacy migration persists');
  const previousWrites = writes;
  theme.migrateLegacyTheme();
  assert.equal(writes, previousWrites, 'Migration is idempotent');
  theme.applyTheme(effective);
  assert.equal(current, expected);
  assert.equal(document.documentElement.dataset.theme, expected);
  assert.equal(sent.at(-1)[0], 'set-main-window-theme');
  assert.equal(sent.at(-1)[1].theme, expected, 'Native window gets the normalized preference');
  assert.deepEqual(Object.keys(theme.THEME_LABELS), ['modern-light', 'dark', 'glass']);
}

for (const failingOperation of ['getItem', 'setItem']) {
  const theme = load('src/app/theme/theme.ts', {
    document: { documentElement: { dataset: {} } },
    localStorage: {
      getItem() { if (failingOperation === 'getItem') throw Error('Storage unavailable'); return 'deep-blue'; },
      setItem() { if (failingOperation === 'setItem') throw Error('Storage unavailable'); },
    },
  }, { '@/infrastructure/electron/ipcEvents': { ipcEvents: { send() {} } } });
  assert.doesNotThrow(() => theme.migrateLegacyTheme());
  assert.equal(theme.getStoredTheme() || theme.DEFAULT_THEME, failingOperation === 'getItem' ? 'modern-light' : 'dark');
}

// Execute the real window controller against the BrowserWindow boundary. This
// verifies retired IPC values, native light/dark source, and masked title bars.
for (const platform of ['win32', 'linux', 'darwin']) {
  const nativeTheme = {};
  class Window {
    constructor(options) { this.options = options; this.webContents = { on() {} }; }
    maximize() {} getBounds() { return {}; } setMenuBarVisibility() {} setAutoHideMenuBar() {}
    on() {} once() {} loadFile() {} isDestroyed() { return false; }
    setBackgroundColor(value) { this.background = value; }
    setTitleBarOverlay(value) { this.overlay = value; }
  }
  const { createMainWindowController } = load('electron/app/mainWindow.ts', {
    process: { platform }, setTimeout, clearTimeout,
  }, {
    electron: { BrowserWindow: Window, nativeTheme, screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1600, height: 1000 } }) } },
    'node:path': path,
    '../platform/logging/performanceLogger': { logPerfEvent() {} },
  });
  const controller = createMainWindowController({ appDir: '/tmp', indexHtmlPath: '/tmp/index.html', resolveAppWindowIconPath() {}, closeParticipantWindow() {} });
  controller.createWindow();
  const win = controller.getMainWindow();
  assert.equal(win.options.backgroundColor, '#f5f6f7');
  assert.equal(nativeTheme.themeSource, 'light');
  for (const value of ['dark', 'deep-blue']) {
    controller.setMainWindowTheme(value);
    assert.equal(win.background, '#1e1f22');
    assert.equal(nativeTheme.themeSource, 'dark');
    if (platform !== 'darwin') {
      assert.equal(win.overlay.color, '#1e1f22');
      controller.setMainWindowModalMask(true);
      assert.equal(win.overlay.color, '#121314');
      controller.setMainWindowModalMask(false);
      assert.equal(win.overlay.color, '#1e1f22');
    }
  }
  controller.setMainWindowTheme('unknown');
  assert.equal(win.background, '#f5f6f7');
  assert.equal(nativeTheme.themeSource, 'light');
}

console.log('Theme migration and native window appearance checks passed.');
