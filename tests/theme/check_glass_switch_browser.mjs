// Run against Vite with VITE_DISABLE_ELECTRON=1; production components, no devices.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MRT_PLAYWRIGHT_MODULE || 'playwright');
const base = process.argv[2] || 'http://127.0.0.1:31874';
const browser = await chromium.launch({ headless: true, executablePath: process.env.MRT_BROWSER_BINARY });
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, deviceScaleFactor: 1.5 });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.addInitScript(() => {
  const stats = window.switchStats = { draws: 0, optical: 0 };
  const draw = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (...args) { stats.draws++; return draw.apply(this, args); };
  const pixels = CanvasRenderingContext2D.prototype.putImageData;
  CanvasRenderingContext2D.prototype.putImageData = function (...args) { stats.optical++; return pixels.apply(this, args); };
});
const settle = () => page.waitForTimeout(650);
const state = (element) => element.getAttribute('aria-checked');
const shot = async name => { if (process.env.MRT_UI_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.MRT_UI_SCREENSHOTS, name + '.png') }); };
async function dragSwitch(element, startOn, wantOn) {
  const b = await element.boundingBox();
  await page.mouse.move(b.x + b.width / 2 + (startOn ? 10 : -10), b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + (wantOn ? 35 : -35), b.y + b.height / 2, { steps: 8 });
  await page.mouse.up(); await settle();
}
try {
  await page.goto(base + '/tests/theme/glass_switch.html');
  const toggle = page.getByRole('switch', { name: '测试开关', exact: true });
  await toggle.waitFor(); await settle();
  const readDraws = () => page.evaluate(() => window.switchStats.draws);
  const idle = await readDraws(); await page.waitForTimeout(150); assert.equal(await readDraws(), idle, 'idle must not redraw');
  await toggle.click(); await settle(); assert.equal(await state(toggle), 'true');
  const afterSingle = await page.getByTestId('calls').textContent(); assert.equal(afterSingle, '1');
  const b = await toggle.boundingBox();
  await page.mouse.move(b.x + b.width / 2 + 10, b.y + b.height / 2); await page.mouse.down();
  await page.waitForTimeout(300);
  const lensColor = await toggle.locator('canvas').evaluate(c => {
    const dpr = c.width / 110;
    return [...c.getContext('2d').getImageData(Math.round(66*dpr), Math.round(23*dpr), 1, 1).data];
  });
  assert.ok(lensColor[0] > 180 && lensColor[1] > 180 && lensColor[2] > 180, 'color-mix surface must not turn the lens black: ' + lensColor);
  assert.equal(await toggle.evaluate(e => getComputedStyle(e).outlineStyle), 'none', 'pointer focus must not outline the large hit area');
  await shot('app-glass-pressed');
  // Another switch must not redraw while this one is held.
  await page.mouse.up(); await settle(); assert.equal(await state(toggle), 'false');
  await dragSwitch(toggle, false, true); assert.equal(await state(toggle), 'true');
  assert.equal(await page.getByTestId('calls').textContent(), '3', 'drag must call business action once');
  await dragSwitch(toggle, true, false); assert.equal(await state(toggle), 'false');
  await toggle.press('Space'); await settle(); assert.equal(await state(toggle), 'true');
  await toggle.press('Enter'); await settle(); assert.equal(await state(toggle), 'false');
  const rejected = page.getByRole('switch', { name: '拒绝切换' });
  await dragSwitch(rejected, false, true); assert.equal(await state(rejected), 'false', 'rejected state must win');
  const delayed = page.getByRole('switch', { name: '延迟切换' });
  await delayed.click(); await settle(); assert.equal(await state(delayed), 'true', 'delayed business state must be reflected');
  await page.getByRole('button', { name: '禁用测试开关', exact: true }).click();
  assert.equal(await toggle.isDisabled(), true);
  const countDisabled = await page.getByTestId('calls').textContent();
  await toggle.dispatchEvent('pointerdown', { button: 0, pointerId: 10, clientX: b.x, clientY: b.y });
  assert.equal(await page.getByTestId('calls').textContent(), countDisabled);
  await page.getByRole('button', { name: '禁用测试开关', exact: true }).click();
  // Pointer cancellation restores the controlled value and does not toggle.
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down();
  await toggle.locator('[data-switch-track]').dispatchEvent('pointercancel', { pointerId: 1 });
  await page.mouse.move(10, 10); await page.mouse.up(); await settle();
  assert.equal(await state(toggle), 'false');
  // Platform / theme changes include a pressed switch and cleanly stop the renderer.
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down();
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.mouse.move(10, 10); await page.mouse.up(); await settle();
  assert.equal(await toggle.locator('canvas').isVisible(), false);
  for (const theme of ['modern-light', 'dark', 'glass']) {
    for (const platform of ['windows', 'other']) {
      await page.evaluate(({theme,platform}) => Object.assign(document.documentElement.dataset, {theme,platform}), {theme,platform});
      await settle();
      await shot('app-' + theme + '-' + platform);
      const dims = await toggle.locator('[data-switch-track]').evaluate(e => ({ w: e.offsetWidth, h: e.offsetHeight }));
      assert.deepEqual(dims, { w: theme === 'glass' ? 70 : 36, h: 28 });
      assert.equal(await toggle.locator('canvas').isVisible(), theme === 'glass');
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await toggle.click(); await page.waitForTimeout(80);
  const reducedDraws = await readDraws(); await page.waitForTimeout(150); assert.equal(await readDraws(), reducedDraws);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // Actual project dropdown: text clicks do not toggle, last modality stays disabled.
  const project = page.getByTestId('project');
  await project.getByRole('button', { name: '眼动模块', exact: true }).click();
  const eye = project.getByRole('option', { name: /眼动模块/ });
  const facial = project.getByRole('option', { name: /表情模块/ });
  assert.equal(await eye.isDisabled(), true);
  await facial.locator('span.block').first().click(); assert.equal(await facial.getAttribute('aria-selected'), 'false');
  await facial.locator('[data-switch-track]').click(); await settle(); assert.equal(await facial.getAttribute('aria-selected'), 'true');
  await facial.focus(); await facial.press('Space'); await settle(); assert.equal(await facial.getAttribute('aria-selected'), 'false');
  await facial.locator('[data-switch-track]').click(); await settle();
  await shot('app-project-dropdown');
  // Every lens fits horizontally within the real clipped dropdown panel, even pressed.
  const bb = await facial.locator('[data-switch-track]').boundingBox();
  await page.mouse.move(bb.x + bb.width / 2 + 10, bb.y + bb.height / 2); await page.mouse.down(); await page.waitForTimeout(250);
  const bounds = await facial.evaluate(e => { const c=e.querySelector('canvas').getBoundingClientRect(), p=e.parentElement.getBoundingClientRect(); return {left:c.left-p.left,right:p.right-c.right}; });
  assert.ok(bounds.left >= 0 && bounds.right >= 0, JSON.stringify(bounds));
  await shot('app-project-dropdown-pressed'); await page.mouse.up(); await settle();
  await page.getByRole('button', { name: '打开新建工程' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '眼动模块', exact: true }).click();
  await dialog.getByRole('option', { name: /表情模块/ }).locator('[data-switch-track]').click(); await settle();
  assert.equal(await dialog.getByRole('option', { name: /表情模块/ }).getAttribute('aria-selected'), 'true');
  await shot('app-new-project'); await dialog.getByRole('button', { name: '取消', exact: true }).click();
  // Actual 300px visualization sidebar: compact and standard sizes.
  const visual = page.getByTestId('visual');
  const marker = visual.getByRole('switch', { name: '显示标记', exact: true });
  await marker.scrollIntoViewIfNeeded(); await marker.click(); await settle(); assert.equal(await state(marker), 'true');
  assert.equal(await visual.evaluate(e => e.scrollWidth > e.clientWidth), false);
  const aoi = page.getByTestId('aoi');
  const aoiMarker = aoi.getByRole('switch', { name: '显示标记', exact: true });
  await aoiMarker.scrollIntoViewIfNeeded(); await aoiMarker.click(); await settle(); assert.equal(await state(aoiMarker), 'false');
  assert.equal(await aoi.evaluate(e => e.scrollWidth > e.clientWidth), false);
  // Unmount during a press: no ghost animation or late action remains.
  await toggle.scrollIntoViewIfNeeded();
  const ub = await toggle.boundingBox(); await page.mouse.move(ub.x+ub.width/2,ub.y+ub.height/2); await page.mouse.down();
  await page.getByRole('button', { name: '挂载测试开关' }).evaluate(e => e.click());
  await page.mouse.up(); await settle();
  const unmountedDraws = await readDraws(); await page.waitForTimeout(150); assert.equal(await readDraws(), unmountedDraws);
  assert.deepEqual(errors, []);
  console.log('Glass switch browser checks passed: click/hold/drag, controlled rejection, keyboard, disabled/cancel, theme/platform, reduced motion, dropdowns, sidebar and idle/unmount.');
} finally { await browser.close(); }
