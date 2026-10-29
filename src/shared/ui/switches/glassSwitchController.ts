import { createSwitchRenderer, readColor, readSurfaceColor, type SwitchPalette } from './glassSwitchRenderer';

type Drag = { id: number; x: number; start: number; value: number; moved: boolean; zoom: number };
const clamp = (v: number) => Math.min(1, Math.max(0, v));

/** Animates presentation only. The existing owner button remains the sole state owner. */
export function createGlassSwitch(root: HTMLElement, checked: boolean, disabled: boolean) {
  const owner = root.closest<HTMLButtonElement>('button');
  const canvas = root.querySelector<HTMLCanvasElement>('canvas');
  const painter = canvas && createSwitchRenderer(canvas);
  if (!owner || !painter) return null;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  // press: 0 resting thumb .. 1 full lens (springs slightly below 0 when it snaps back).
  // stretch: horizontal elongation from travel speed, as liquid glass does on iOS.
  let position = Number(checked), tint = position, press = 0, pressVelocity = 0, velocity = 0, stretch = 0;
  let drag: Drag | null = null;
  let releaseUntil = 0, frame = 0, previous = 0;
  let suppressClick = false, clickTimer = 0, disposed = false;
  let palette: SwitchPalette;
  function readPalette() {
    const style = getComputedStyle(root);
    palette = {
      on: readColor(getComputedStyle(root.querySelector('.mrt-switch-paint-on')!).backgroundColor),
      off: readColor(getComputedStyle(root.querySelector('.mrt-switch-paint-off')!).backgroundColor),
      surface: readSurfaceColor(root, style.getPropertyValue('--app-surface')),
      thumb: readColor(getComputedStyle(root.querySelector('.mrt-switch-thumb')!).backgroundColor),
    };
  }
  const paint = () => painter!.draw(position, press, tint, palette, stretch);
  function tick(time: number) {
    if (disposed) return;
    const dt = Math.min((time - previous) / 1000 || 1 / 60, 1 / 30);
    previous = time;
    const target = drag ? drag.value : Number(checked);
    // The lens stays fully formed for the whole slide and only snaps back on arrival.
    const sliding = !drag && Math.abs(target - position) > 0.03;
    const targetPress = !disabled && (drag || time < releaseUntil || sliding) ? 1 : 0;
    if (reduced.matches) {
      position = target; velocity = 0; press = 0; pressVelocity = 0; tint = target; stretch = 0;
    } else {
      if (drag?.moved) {
        // Follow the pointer; keep a smoothed speed so a fast drag still stretches.
        velocity += ((target - position) / dt - velocity) * Math.min(1, dt * 20);
        position = target;
      } else { velocity += (350 * (target - position) - 29 * velocity) * dt; position += velocity * dt; }
      if (targetPress) {
        // Swell almost at once (~17 ms), so a quick tap slides as a full lens.
        press += (1 - press) * (1 - Math.exp(-dt * 60)); pressVelocity = 0;
      } else {
        // Snap back with a small undershoot, like the iOS knob settling.
        pressVelocity += (380 * -press - 24 * pressVelocity) * dt; press += pressVelocity * dt;
      }
      stretch += (Math.min(0.22, Math.abs(velocity) * 0.035) - stretch) * (1 - Math.exp(-dt * 30));
      tint += (target - tint) * (1 - Math.exp(-dt * 16));
    }
    paint();
    const moving = !reduced.matches && (time < releaseUntil || Math.abs(position - target) > 0.0005 ||
      Math.abs(velocity) > 0.004 || Math.abs(press - targetPress) > 0.0005 || Math.abs(pressVelocity) > 0.004 ||
      stretch > 0.001 || Math.abs(tint - target) > 0.001);
    if (moving) frame = requestAnimationFrame(tick);
    else { frame = 0; previous = 0; }
  }
  const wake = () => { if (!frame && !disposed) frame = requestAnimationFrame(tick); };
  const blocked = () => disabled || owner!.disabled || owner!.getAttribute('aria-disabled') === 'true';
  function cancelDrag() {
    const current = drag; drag = null;
    if (current && root.hasPointerCapture(current.id)) root.releasePointerCapture(current.id);
    releaseUntil = 0; wake();
  }
  function down(event: PointerEvent) {
    if (blocked() || event.button !== 0 || drag) return;
    const scale = root.getBoundingClientRect().width / (root.offsetWidth || 1);
    drag = { id: event.pointerId, x: event.clientX, start: Number(checked), value: Number(checked), moved: false, zoom: scale };
    root.setPointerCapture(event.pointerId);
    readPalette(); wake();
  }
  function move(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.id) return;
    if (blocked()) { cancelDrag(); return; }
    const delta = (event.clientX - drag.x) / drag.zoom;
    if (Math.abs(delta) > 3) drag.moved = true;
    const travel = Number.parseFloat(getComputedStyle(root).getPropertyValue('--mrt-switch-scale')) * 24;
    if (drag.moved) drag.value = clamp(drag.start + delta / travel);
    event.preventDefault(); wake();
  }
  function finish(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.id) return;
    const current = drag; drag = null;
    if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId);
    if (event.type === 'pointerup' && !blocked()) {
      releaseUntil = performance.now() + 120;
      if (current.moved) {
        // Swallow only the following native click on this owner. Dispatch exactly
        // one business click if the chosen end differs from the controlled state.
        suppressClick = true;
        window.clearTimeout(clickTimer);
        clickTimer = window.setTimeout(() => { suppressClick = false; }, 0);
        if ((current.value >= 0.5) !== checked) owner!.click();
      }
    } else releaseUntil = 0;
    wake();
  }
  function click(event: MouseEvent) {
    if (suppressClick && event.isTrusted) {
      suppressClick = false; event.preventDefault(); event.stopPropagation(); return;
    }
    if (!blocked()) { releaseUntil = performance.now() + 120; wake(); }
  }
  const lostCapture = () => { if (drag) cancelDrag(); };
  const visibility = () => {
    if (!document.hidden) return;
    cancelDrag(); cancelAnimationFrame(frame); frame = 0; previous = 0;
    position = tint = Number(checked); press = pressVelocity = velocity = stretch = 0; paint();
  };
  const resize = () => { readPalette(); paint(); };
  readPalette(); paint(); root.dataset.canvasReady = 'true';
  // Option rows only drag from the switch; standalone switch buttons use their full hit area.
  const hit = owner.matches('[role="switch"]') ? owner : root;
  hit.addEventListener('pointerdown', down);
  root.addEventListener('pointermove', move);
  root.addEventListener('pointerup', finish);
  root.addEventListener('pointercancel', finish);
  root.addEventListener('lostpointercapture', lostCapture);
  owner.addEventListener('click', click, true);
  window.addEventListener('blur', cancelDrag);
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', visibility);
  reduced.addEventListener('change', cancelDrag);
  return {
    update(next: boolean, nextDisabled: boolean) {
      checked = next; disabled = nextDisabled;
      if (disabled) cancelDrag();
      readPalette(); wake();
    },
    dispose() {
      disposed = true; cancelDrag(); cancelAnimationFrame(frame); window.clearTimeout(clickTimer);
      hit.removeEventListener('pointerdown', down);
      root.removeEventListener('pointermove', move);
      root.removeEventListener('pointerup', finish);
      root.removeEventListener('pointercancel', finish);
      root.removeEventListener('lostpointercapture', lostCapture);
      owner.removeEventListener('click', click, true);
      window.removeEventListener('blur', cancelDrag);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', visibility);
      reduced.removeEventListener('change', cancelDrag);
      delete root.dataset.canvasReady;
    },
  };
}
