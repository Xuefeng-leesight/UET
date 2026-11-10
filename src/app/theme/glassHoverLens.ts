/**
 * Glass theme: a hover lens for button capsules (top-bar button groups, and groups
 * marked .mrt-glass-capsule such as the project settings action bar). A glass pill
 * glides between the buttons under the pointer and fades out when the pointer leaves
 * the capsule, like a macOS 26 toolbar group.
 *
 * Capsules are found by selector and re-scanned as they re-render, so pages keep
 * their own markup. Outside the glass theme nothing is attached. With
 * prefers-reduced-motion the lens jumps instead of gliding.
 */

const CAPSULE_SELECTOR = 'header .flex.gap-2:has(> button.mrt-button), .mrt-glass-capsule';
// Containers whose changes can add or remove capsules.
const CAPSULE_SCOPE = 'header, .mrt-glass-capsule';
const GLIDE_MS = 420;
const STRETCH = 0.14;
const SCAN_INTERVAL_MS = 250;

type Rect = { x: number; y: number; width: number; height: number };
type Capsule = { lens: HTMLDivElement; rect: Rect | null; cleanup: () => void };

const capsules = new Map<HTMLElement, Capsule>();
let observer: MutationObserver | null = null;
let scanTimer: number | null = null;

const isGlass = () => document.documentElement.dataset.theme === 'glass';
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function moveLens(capsule: Capsule, next: Rect | null) {
  const { lens } = capsule;
  const from = capsule.rect;
  lens.getAnimations().forEach((animation) => animation.cancel());
  capsule.rect = next;
  if (!next) {
    lens.style.opacity = '0';
    return;
  }
  lens.style.opacity = '1';
  lens.style.left = `${next.x}px`;
  lens.style.top = `${next.y}px`;
  lens.style.width = `${next.width}px`;
  lens.style.height = `${next.height}px`;
  // Fade in where it appears; glide only between buttons.
  if (!from || reduceMotion() || from.x === next.x) return;
  lens.animate([
    { left: `${from.x}px`, width: `${from.width}px`, transform: 'none' },
    { left: `${(from.x + next.x) / 2}px`, width: `${(from.width + next.width) / 2}px`, transform: `scale(${1 + STRETCH}, ${1 - STRETCH * 0.4})`, offset: 0.45 },
    { left: `${next.x}px`, width: `${next.width}px`, transform: 'none' },
  ], { duration: GLIDE_MS, easing: 'cubic-bezier(.32,.72,.24,1)' });
}

function attach(element: HTMLElement) {
  const lens = document.createElement('div');
  lens.className = 'mrt-hover-lens';
  lens.setAttribute('aria-hidden', 'true');
  lens.style.opacity = '0';
  element.prepend(lens);
  const capsule: Capsule = { lens, rect: null, cleanup: () => undefined };
  const onOver = (event: PointerEvent) => {
    const button = (event.target as Element).closest('button');
    if (!button || button.parentElement !== element || button.disabled || button.classList.contains('mrt-button-muted')) return;
    // Destructive buttons get a faint red lens, so the danger reads before the click.
    lens.classList.toggle('is-danger', button.classList.contains('mrt-button-danger'));
    moveLens(capsule, { x: button.offsetLeft, y: button.offsetTop, width: button.offsetWidth, height: button.offsetHeight });
  };
  const onLeave = () => moveLens(capsule, null);
  element.addEventListener('pointerover', onOver);
  element.addEventListener('pointerleave', onLeave);
  capsule.cleanup = () => {
    element.removeEventListener('pointerover', onOver);
    element.removeEventListener('pointerleave', onLeave);
    lens.remove();
  };
  capsules.set(element, capsule);
}

function scan() {
  scanTimer = null;
  for (const [element, capsule] of capsules) {
    // React may reuse the element for another top-bar group that is not a capsule.
    if (element.isConnected && element.contains(capsule.lens) && element.matches(CAPSULE_SELECTOR)) continue;
    capsule.cleanup();
    capsules.delete(element);
  }
  document.querySelectorAll<HTMLElement>(CAPSULE_SELECTOR).forEach((element) => {
    if (!capsules.has(element)) attach(element);
  });
}

// Only changes in or around capsules matter; recording and charts churn the rest of
// the page constantly.
function touchesCapsules(record: MutationRecord): boolean {
  const target = record.target instanceof Element ? record.target : null;
  if (target?.closest(CAPSULE_SCOPE)) return true;
  const changed = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
  return changed.some((node) =>
    node instanceof Element && (node.matches(CAPSULE_SCOPE) || node.querySelector(CAPSULE_SCOPE) !== null));
}

function onMutations(records: MutationRecord[]) {
  if (scanTimer === null && records.some(touchesCapsules)) scanTimer = window.setTimeout(scan, SCAN_INTERVAL_MS);
}

function start() {
  if (observer) return;
  observer = new MutationObserver(onMutations);
  observer.observe(document.body, { subtree: true, childList: true });
  scan();
}

function stop() {
  observer?.disconnect();
  observer = null;
  if (scanTimer !== null) window.clearTimeout(scanTimer);
  scanTimer = null;
  for (const capsule of capsules.values()) capsule.cleanup();
  capsules.clear();
}

/** Call once at startup; follows theme switches on <html data-theme>. */
export function installGlassHoverLens() {
  const sync = () => (isGlass() ? start() : stop());
  new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  sync();
}
