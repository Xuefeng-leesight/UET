import React from 'react';

/**
 * Liquid glass selection lens for the glass theme: a glass pill that glides to the
 * selected item (by default the navigation item marked aria-current="page") and can
 * be dragged along the list to pick another item. The main sidebar uses it vertically;
 * horizontal switches (tab bars, mode switches) use it through GlassSegmentLens.
 *
 * Three stacked layers follow the same position:
 * - body: the white glass, drawn under the menu labels so they stay readable.
 * - ink: a screen-blended primary fill over the labels. Dark labels under it turn blue
 *   while the white body and light menu background stay light, so the colour change
 *   follows the glass edge as it slides instead of switching when the selection changes.
 * - glass: an invisible top layer that takes the drag. While it moves it also refracts
 *   what is behind it, through an SVG displacement filter used as a backdrop-filter;
 *   only a thin band along the rim bends, the inside is never distorted. At rest it
 *   does not refract.
 * The refraction needs Chromium (Electron); elsewhere the glass stays a plain pill.
 */

// Rim refraction while moving: only this band along the edge bends, pulled inwards.
const RIM_PX = 4;
const BEVEL_PX = 10;
const RADIUS_PX = 10; // keep in sync with the border-radius in index.css
// Horizontal segments are capsules: their radius is half the lens height.
const PILL_RADIUS_PX = 999;
// Displacement range the map is encoded against (feDisplacementMap scale).
const MAP_RANGE_PX = 64;

// Glide between items: a short liquid stretch along the direction of travel.
const GLIDE_MS = 520;
const STRETCH = 0.18;
// Items on one row share the widest width only while the widest is within this ratio of the narrowest.
const UNIFORM_WIDTH_TOLERANCE = 1.3;
// Pointer travel before a press on the lens counts as a drag.
const DRAG_THRESHOLD_PX = 3;

type LensRect = { x: number; y: number; width: number; height: number };
type Axis = 'x' | 'y';

const mapCache = new Map<string, string>();
/** Last resting rect per memoryKey, so a switch that is re-rendered still glides. */
const rememberedRects = new Map<string, LensRect>();

function signedDistance(x: number, y: number, width: number, height: number, cornerRadius: number): number {
  const radius = Math.min(cornerRadius, width / 2, height / 2);
  const qx = Math.abs(x - width / 2) - (width / 2 - radius);
  const qy = Math.abs(y - height / 2) - (height / 2 - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/**
 * Each pixel stores the offset (R = x, G = y, 128 = none) the glass samples the
 * backdrop at. Pixels deeper than BEVEL_PX from the edge keep a zero offset.
 */
function displacementMap(width: number, height: number, cornerRadius: number): string {
  const key = `${width}x${height}r${cornerRadius}`;
  const cached = mapCache.get(key);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return '';
  const image = context.createImageData(width, height);
  const encode = (offset: number) => Math.max(0, Math.min(255, Math.round(128 + (offset / MAP_RANGE_PX) * 255)));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const distance = signedDistance(px, py, width, height, cornerRadius);
      let offsetX = 0;
      let offsetY = 0;
      if (distance < 0 && distance > -BEVEL_PX) {
        const t = 1 + distance / BEVEL_PX; // 1 at the rim, 0 at the inner end of the band
        const ease = t * t * (3 - 2 * t);
        const gradientX = signedDistance(px + 1, py, width, height, cornerRadius) - signedDistance(px - 1, py, width, height, cornerRadius);
        const gradientY = signedDistance(px, py + 1, width, height, cornerRadius) - signedDistance(px, py - 1, width, height, cornerRadius);
        const length = Math.hypot(gradientX, gradientY) || 1;
        offsetX = -(gradientX / length) * ease * RIM_PX;
        offsetY = -(gradientY / length) * ease * RIM_PX;
      }
      const index = (y * width + x) * 4;
      image.data[index] = encode(offsetX);
      image.data[index + 1] = encode(offsetY);
      image.data[index + 2] = 128;
      image.data[index + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  const url = canvas.toDataURL();
  mapCache.set(key, url);
  return url;
}

function rectOf(element: HTMLElement, container: HTMLElement): LensRect | null {
  const box = element.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return null;
  const containerBox = container.getBoundingClientRect();
  return {
    x: box.left - containerBox.left + container.scrollLeft,
    y: box.top - containerBox.top + container.scrollTop,
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
}

const transformOf = (rect: LensRect, scaleX = 1, scaleY = 1) =>
  `translate(${rect.x}px, ${rect.y}px) scale(${scaleX}, ${scaleY})`;

export function LiquidGlassLens({
  containerRef,
  activeKey,
  onSelect,
  axis = 'y',
  activeSelector = '[aria-current="page"]',
  uniformWidth = false,
  maxHeight,
  memoryKey,
  dragTitle = '拖动切换页面',
}: {
  /** Positioned scroll container that holds the navigation items (marked data-nav-id). */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Changes whenever the selected item changes; triggers the glide. */
  activeKey: string;
  /** Called with the data-nav-id of the item the lens is dropped on. */
  onSelect: (id: string) => void;
  /** Direction the items run in; the lens glides and drags along it. */
  axis?: Axis;
  /** Selector of the selected item inside the container. */
  activeSelector?: string;
  /** Give the lens the width of the widest item, centred on the selected one. */
  uniformWidth?: boolean;
  /** Cap the lens height (centred on the item), for tall tab bars. */
  maxHeight?: number;
  /** Remember the resting position under this key; a re-rendered switch glides on from it. */
  memoryKey?: string;
  dragTitle?: string;
}) {
  const cornerRadius = axis === 'x' ? PILL_RADIUS_PX : RADIUS_PX;
  const filterId = `mrt-glass-lens-${React.useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const glassRef = React.useRef<HTMLDivElement>(null);
  const inkRef = React.useRef<HTMLDivElement>(null);
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const mapRef = React.useRef<SVGFEImageElement>(null);
  const rectRef = React.useRef<LensRect | null>(null);
  const dragRef = React.useRef<{ pointer: number; start: number; last: number; lastTime: number; moved: boolean } | null>(null);
  const pendingRef = React.useRef<string | null>(null);

  const layers = React.useCallback(
    () => [bodyRef.current, inkRef.current, glassRef.current].filter((layer): layer is HTMLDivElement => layer !== null),
    [],
  );

  // Refraction is only on while the glass moves; at rest the content behind is untouched.
  const setRefracting = React.useCallback((on: boolean) => {
    const glass = glassRef.current;
    if (glass) glass.style.backdropFilter = on ? `url(#${filterId})` : 'none';
  }, [filterId]);

  const setTransform = React.useCallback((rect: LensRect, scaleX = 1, scaleY = 1) => {
    for (const layer of layers()) layer.style.transform = transformOf(rect, scaleX, scaleY);
  }, [layers]);

  // Stretch along the direction of travel, squeeze across it.
  const stretchTransform = React.useCallback((rect: LensRect, along: number, across: number) => {
    if (axis === 'x') setTransform(rect, along, across);
    else setTransform(rect, across, along);
  }, [axis, setTransform]);

  /** Lens rect for an item: optionally the widest item's width and a capped height, centred. */
  const lensRectOf = React.useCallback((item: HTMLElement, container: HTMLElement): LensRect | null => {
    const rect = rectOf(item, container);
    if (!rect) return null;
    let { x, y, width, height } = rect;
    if (uniformWidth) {
      // Share one width only among items on the same row of similar size; one long label
      // (common after translation) must not stretch the lens over its short neighbours.
      const itemTop = item.getBoundingClientRect().top;
      let widest = width;
      let narrowest = width;
      container.querySelectorAll<HTMLElement>('[data-nav-id]').forEach((other) => {
        const box = other.getBoundingClientRect();
        if (Math.abs(box.top - itemTop) > 4) return;
        widest = Math.max(widest, Math.round(box.width));
        narrowest = Math.min(narrowest, Math.round(box.width));
      });
      if (widest <= narrowest * UNIFORM_WIDTH_TOLERANCE) {
        x += (width - widest) / 2;
        width = widest;
      }
    }
    if (maxHeight && height > maxHeight) {
      y += (height - maxHeight) / 2;
      height = maxHeight;
    }
    return { x, y, width, height };
  }, [maxHeight, uniformWidth]);

  const place = React.useCallback((animate: boolean) => {
    const container = containerRef.current;
    const map = mapRef.current;
    if (!container || !map || dragRef.current) return;

    const active = container.querySelector<HTMLElement>(activeSelector);
    const next = active ? lensRectOf(active, container) : null;
    if (!next) {
      for (const layer of layers()) layer.style.opacity = '0';
      rectRef.current = null;
      return;
    }
    // A reflow that leaves the lens where it is must not cancel a glide in progress:
    // the resize observer fires once right after mounting, while a re-rendered switch
    // is still gliding on from its remembered place.
    const current = rectRef.current;
    if (!animate && current && current.x === next.x && current.y === next.y
      && current.width === next.width && current.height === next.height) {
      return;
    }
    const previous = current ?? (memoryKey ? rememberedRects.get(memoryKey) ?? null : null);
    rectRef.current = next;
    if (memoryKey) rememberedRects.set(memoryKey, next);
    map.setAttribute('width', String(next.width));
    map.setAttribute('height', String(next.height));
    map.setAttribute('href', displacementMap(next.width, next.height, cornerRadius));
    for (const layer of layers()) {
      layer.style.opacity = '1';
      layer.style.width = `${next.width}px`;
      layer.style.height = `${next.height}px`;
      layer.getAnimations().forEach((animation) => animation.cancel());
    }
    setTransform(next);

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!animate || !previous || reduceMotion || (previous.x === next.x && previous.y === next.y)) {
      setRefracting(false);
      return;
    }

    const middle: LensRect = { ...next, x: (previous.x + next.x) / 2, y: (previous.y + next.y) / 2 };
    // [scaleX, scaleY] for a stretch along the axis and a squeeze across it.
    const scaled = (along: number, across: number): [number, number] => (axis === 'x' ? [along, across] : [across, along]);
    // Size is animated only when it really changes. A transform-only glide runs on the
    // compositor, so it still plays while the page is busy rendering what the switch
    // just opened (e.g. the single-record report building its charts); animating
    // width/height ties it to the main thread, and a busy one skips it entirely.
    const resized = previous.width !== next.width || previous.height !== next.height;
    const sizeOf = (rect: LensRect): Keyframe => (resized ? { width: `${rect.width}px`, height: `${rect.height}px` } : {});
    const keyframes: Keyframe[] = [
      { transform: transformOf(previous), ...sizeOf(previous) },
      { transform: transformOf(middle, ...scaled(1 + STRETCH, 1 - STRETCH * 0.35)), offset: 0.45 },
      { transform: transformOf(next, ...scaled(1 - STRETCH * 0.25, 1 + STRETCH * 0.12)), offset: 0.8 },
      { transform: transformOf(next), ...sizeOf(next) },
    ];
    setRefracting(true);
    const animations = layers().map((layer) =>
      layer.animate(keyframes, { duration: GLIDE_MS, easing: 'cubic-bezier(.32,.72,.24,1)' }));
    animations[0]?.finished.then(() => setRefracting(false), () => undefined);
  }, [activeSelector, axis, containerRef, cornerRadius, layers, lensRectOf, memoryKey, setRefracting, setTransform]);

  // Glide when the selection changes.
  React.useLayoutEffect(() => {
    pendingRef.current = null;
    place(true);
  }, [activeKey, place]);

  // Snap (no glide) when the menu reflows: groups folding, window resizing, language width.
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // The ink screen-blends against the container's own opaque fill. Without it, an
    // ancestor that fades in (a modal opening) leaves the ink over transparency, and
    // the lens flashes solid blue.
    container.classList.add('mrt-glass-lens-host');
    if (axis === 'x') container.classList.add('mrt-glass-segment');
    const reflow = () => place(false);
    const resizeObserver = new ResizeObserver(reflow);
    // Items are observed too: translated labels or late fonts change an item's width
    // without resizing the container.
    const observeItems = () => {
      resizeObserver.disconnect();
      resizeObserver.observe(container);
      container.querySelectorAll<HTMLElement>('[data-nav-id]').forEach((item) => resizeObserver.observe(item));
    };
    observeItems();
    const mutationObserver = new MutationObserver((records) => {
      if (records.some((record) => record.type === 'childList')) observeItems();
      reflow();
    });
    mutationObserver.observe(container, { childList: true, subtree: true, characterData: true });
    return () => {
      container.classList.remove('mrt-glass-lens-host', 'mrt-glass-segment');
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [axis, containerRef, place]);

  // Drag along the axis: the glass follows the pointer, stretches with speed, and on
  // release selects the item under its centre.
  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const glass = glassRef.current;
    const rect = rectRef.current;
    if (!glass || !rect || event.button !== 0) return;
    for (const layer of layers()) layer.getAnimations().forEach((animation) => animation.cancel());
    glass.setPointerCapture(event.pointerId);
    const pointer = axis === 'x' ? event.clientX : event.clientY;
    dragRef.current = { pointer, start: axis === 'x' ? rect.x : rect.y, last: pointer, lastTime: performance.now(), moved: false };
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const glass = glassRef.current;
    const container = containerRef.current;
    const rect = rectRef.current;
    if (!drag || !glass || !container || !rect) return;
    const pointer = axis === 'x' ? event.clientX : event.clientY;
    const delta = pointer - drag.pointer;
    if (!drag.moved && Math.abs(delta) < DRAG_THRESHOLD_PX) return;
    if (!drag.moved) {
      drag.moved = true;
      glass.classList.add('is-dragging');
      setRefracting(true);
    }

    const now = performance.now();
    const speed = Math.abs(pointer - drag.last) / Math.max(1, now - drag.lastTime);
    drag.last = pointer;
    drag.lastTime = now;
    const stretch = Math.min(STRETCH, speed * 0.08);
    if (axis === 'x') {
      // Keep the glass between the first and the last item.
      let min = Infinity;
      let max = -Infinity;
      container.querySelectorAll<HTMLElement>('[data-nav-id]').forEach((item) => {
        const itemRect = lensRectOf(item, container);
        if (!itemRect) return;
        min = Math.min(min, itemRect.x);
        max = Math.max(max, itemRect.x);
      });
      const x = Math.max(min, Math.min(max, drag.start + delta));
      rectRef.current = { ...rect, x };
    } else {
      const y = Math.max(0, Math.min(container.scrollHeight - rect.height, drag.start + delta));
      rectRef.current = { ...rect, y };
    }
    stretchTransform(rectRef.current, 1 + stretch, 1 - stretch * 0.35);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const container = containerRef.current;
    dragRef.current = null;
    glassRef.current?.classList.remove('is-dragging');
    if (!drag || !container) return;
    if (!drag.moved) {
      // The glass covers the selected item. On a horizontal switch a tap on it acts
      // like a click on that item (e.g. a tab that reloads its list when clicked again).
      if (axis === 'x' && event.type === 'pointerup') onSelect(activeKey);
      return;
    }

    // Pick the item whose centre is closest to the glass centre.
    const dropped = rectRef.current;
    let targetId: string | undefined;
    let best = Infinity;
    container.querySelectorAll<HTMLElement>('[data-nav-id]').forEach((item) => {
      const rect = rectOf(item, container);
      if (!rect || !dropped) return;
      const distance = axis === 'x'
        ? Math.abs(rect.x + rect.width / 2 - (dropped.x + dropped.width / 2))
        : Math.abs(rect.y + rect.height / 2 - (dropped.y + dropped.height / 2));
      if (distance < best) {
        best = distance;
        targetId = item.dataset.navId;
      }
    });
    if (!targetId || targetId === activeKey) {
      place(true);
      return;
    }
    // A switch that is re-rendered by the selection glides on from the drop point.
    if (memoryKey && dropped) rememberedRects.set(memoryKey, dropped);
    // The page switch can be refused (e.g. unsaved changes); then glide back.
    pendingRef.current = targetId;
    onSelect(targetId);
    window.setTimeout(() => {
      if (pendingRef.current === targetId) {
        pendingRef.current = null;
        place(true);
      }
    }, 300);
  };

  return (
    <>
      <svg width="0" height="0" className="absolute" aria-hidden="true" focusable="false">
        <filter id={filterId} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feImage ref={mapRef} x="0" y="0" preserveAspectRatio="none" result="map" />
          <feDisplacementMap in="SourceGraphic" in2="map" scale={MAP_RANGE_PX} xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </svg>
      <div ref={bodyRef} className={`mrt-glass-lens-body${axis === 'x' ? ' is-pill' : ''}`} aria-hidden="true" />
      <div ref={inkRef} className={`mrt-glass-lens-ink${axis === 'x' ? ' is-pill' : ''}`} aria-hidden="true" />
      <div
        ref={glassRef}
        className={`mrt-glass-lens${axis === 'x' ? ' is-pill' : ''}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        aria-hidden="true"
        title={dragTitle}
      />
    </>
  );
}
