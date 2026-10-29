import React from 'react';

/**
 * Liquid glass selection lens for the glass theme: a glass pill that glides to the
 * navigation item marked aria-current="page" and can be dragged up and down to pick
 * another item.
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
// Displacement range the map is encoded against (feDisplacementMap scale).
const MAP_RANGE_PX = 64;

// Glide between items: a short liquid stretch along the direction of travel.
const GLIDE_MS = 520;
const STRETCH = 0.18;
// Pointer travel before a press on the lens counts as a drag.
const DRAG_THRESHOLD_PX = 3;

type LensRect = { x: number; y: number; width: number; height: number };

const mapCache = new Map<string, string>();

function signedDistance(x: number, y: number, width: number, height: number): number {
  const radius = Math.min(RADIUS_PX, width / 2, height / 2);
  const qx = Math.abs(x - width / 2) - (width / 2 - radius);
  const qy = Math.abs(y - height / 2) - (height / 2 - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/**
 * Each pixel stores the offset (R = x, G = y, 128 = none) the glass samples the
 * backdrop at. Pixels deeper than BEVEL_PX from the edge keep a zero offset.
 */
function displacementMap(width: number, height: number): string {
  const key = `${width}x${height}`;
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
      const distance = signedDistance(px, py, width, height);
      let offsetX = 0;
      let offsetY = 0;
      if (distance < 0 && distance > -BEVEL_PX) {
        const t = 1 + distance / BEVEL_PX; // 1 at the rim, 0 at the inner end of the band
        const ease = t * t * (3 - 2 * t);
        const gradientX = signedDistance(px + 1, py, width, height) - signedDistance(px - 1, py, width, height);
        const gradientY = signedDistance(px, py + 1, width, height) - signedDistance(px, py - 1, width, height);
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
}: {
  /** Positioned scroll container that holds the navigation items (marked data-nav-id). */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Changes whenever the selected item changes; triggers the glide. */
  activeKey: string;
  /** Called with the data-nav-id of the item the lens is dropped on. */
  onSelect: (id: string) => void;
}) {
  const filterId = `mrt-glass-lens-${React.useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const glassRef = React.useRef<HTMLDivElement>(null);
  const inkRef = React.useRef<HTMLDivElement>(null);
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const mapRef = React.useRef<SVGFEImageElement>(null);
  const rectRef = React.useRef<LensRect | null>(null);
  const dragRef = React.useRef<{ pointerY: number; startY: number; lastY: number; lastTime: number; moved: boolean } | null>(null);
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

  const place = React.useCallback((animate: boolean) => {
    const container = containerRef.current;
    const map = mapRef.current;
    if (!container || !map || dragRef.current) return;

    const active = container.querySelector<HTMLElement>('[aria-current="page"]');
    const next = active ? rectOf(active, container) : null;
    if (!next) {
      for (const layer of layers()) layer.style.opacity = '0';
      rectRef.current = null;
      return;
    }
    const previous = rectRef.current;
    rectRef.current = next;
    map.setAttribute('width', String(next.width));
    map.setAttribute('height', String(next.height));
    map.setAttribute('href', displacementMap(next.width, next.height));
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
    const keyframes: Keyframe[] = [
      { transform: transformOf(previous), width: `${previous.width}px`, height: `${previous.height}px` },
      { transform: transformOf(middle, 1 - STRETCH * 0.35, 1 + STRETCH), offset: 0.45 },
      { transform: transformOf(next, 1 + STRETCH * 0.12, 1 - STRETCH * 0.25), offset: 0.8 },
      { transform: transformOf(next), width: `${next.width}px`, height: `${next.height}px` },
    ];
    setRefracting(true);
    const animations = layers().map((layer) =>
      layer.animate(keyframes, { duration: GLIDE_MS, easing: 'cubic-bezier(.32,.72,.24,1)' }));
    animations[0]?.finished.then(() => setRefracting(false), () => undefined);
  }, [containerRef, layers, setRefracting, setTransform]);

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
    const reflow = () => place(false);
    const resizeObserver = new ResizeObserver(reflow);
    resizeObserver.observe(container);
    const mutationObserver = new MutationObserver(reflow);
    mutationObserver.observe(container, { childList: true, subtree: true });
    return () => {
      container.classList.remove('mrt-glass-lens-host');
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [containerRef, place]);

  // Vertical drag: the glass follows the pointer, stretches with speed, and on release
  // selects the item under its centre.
  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const glass = glassRef.current;
    const rect = rectRef.current;
    if (!glass || !rect || event.button !== 0) return;
    for (const layer of layers()) layer.getAnimations().forEach((animation) => animation.cancel());
    glass.setPointerCapture(event.pointerId);
    dragRef.current = { pointerY: event.clientY, startY: rect.y, lastY: event.clientY, lastTime: performance.now(), moved: false };
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const glass = glassRef.current;
    const container = containerRef.current;
    const rect = rectRef.current;
    if (!drag || !glass || !container || !rect) return;
    const delta = event.clientY - drag.pointerY;
    if (!drag.moved && Math.abs(delta) < DRAG_THRESHOLD_PX) return;
    if (!drag.moved) {
      drag.moved = true;
      glass.classList.add('is-dragging');
      setRefracting(true);
    }

    const now = performance.now();
    const speed = Math.abs(event.clientY - drag.lastY) / Math.max(1, now - drag.lastTime);
    drag.lastY = event.clientY;
    drag.lastTime = now;
    const stretch = Math.min(STRETCH, speed * 0.08);
    const y = Math.max(0, Math.min(container.scrollHeight - rect.height, drag.startY + delta));
    rectRef.current = { ...rect, y };
    setTransform(rectRef.current, 1 - stretch * 0.35, 1 + stretch);
  };

  const handlePointerUp = () => {
    const drag = dragRef.current;
    const container = containerRef.current;
    dragRef.current = null;
    glassRef.current?.classList.remove('is-dragging');
    if (!drag || !container || !drag.moved) return;

    // Pick the item whose centre is closest to the glass centre.
    const dropped = rectRef.current;
    let targetId: string | undefined;
    let best = Infinity;
    container.querySelectorAll<HTMLElement>('[data-nav-id]').forEach((item) => {
      const rect = rectOf(item, container);
      if (!rect || !dropped) return;
      const distance = Math.abs(rect.y + rect.height / 2 - (dropped.y + dropped.height / 2));
      if (distance < best) {
        best = distance;
        targetId = item.dataset.navId;
      }
    });
    if (!targetId || targetId === activeKey) {
      place(true);
      return;
    }
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
      <div ref={bodyRef} className="mrt-glass-lens-body" aria-hidden="true" />
      <div ref={inkRef} className="mrt-glass-lens-ink" aria-hidden="true" />
      <div
        ref={glassRef}
        className="mrt-glass-lens"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        aria-hidden="true"
        title="拖动切换页面"
      />
    </>
  );
}
