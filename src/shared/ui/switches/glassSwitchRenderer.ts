type Color = [number, number, number];
export type SwitchPalette = { on: Color; off: Color; surface: Color; thumb: Color };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const distance = (x: number, y: number, cx: number, cy: number, w: number, h: number) =>
  Math.hypot(Math.max(Math.abs(x - cx) - (w - h) / 2, 0), y - cy) - h / 2;

let colorProbe: CanvasRenderingContext2D | null | undefined;
function colorChannels(value: string): [number, number, number, number] {
  // Chromium may return color(srgb ...) for color-mix surfaces. Let its color
  // engine resolve both that 0..1 notation and rgb() / hex, including alpha.
  if (colorProbe === undefined) {
    const probe = document.createElement('canvas'); probe.width = probe.height = 1;
    colorProbe = probe.getContext('2d', { willReadFrequently: true });
  }
  if (!colorProbe) return [255, 255, 255, 255];
  colorProbe.clearRect(0, 0, 1, 1);
  colorProbe.fillStyle = value;
  colorProbe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = colorProbe.getImageData(0, 0, 1, 1).data;
  return [r, g, b, a];
}
export const readColor = (value: string): Color => colorChannels(value).slice(0, 3) as Color;

export function readSurfaceColor(element: HTMLElement, fallback: string): Color {
  const layers: Array<[number, number, number, number]> = [];
  for (let node: HTMLElement | null = element.parentElement; node; node = node.parentElement) {
    layers.push(colorChannels(getComputedStyle(node).backgroundColor));
  }
  const result = readColor(fallback);
  for (const layer of layers.reverse()) {
    for (let c = 0; c < 3; c++) result[c] = mix(result[c], layer[c], layer[3] / 255);
  }
  return result;
}

/** Same capsule optics as the approved preview; all positions use its 64×28 track. */
export function createSwitchRenderer(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d');
  const buffer = document.createElement('canvas');
  const bufferCtx = buffer.getContext('2d');
  if (!ctx || !bufferCtx) return null;
  let dpr = 0;
  let pixels: ImageData;
  const resize = () => {
    const next = Math.min(window.devicePixelRatio || 1, 2);
    if (next === dpr) return;
    dpr = next;
    canvas.width = buffer.width = Math.round(110 * dpr);
    canvas.height = buffer.height = Math.round(76 * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    pixels = bufferCtx.createImageData(buffer.width, buffer.height);
  };
  resize();
  return {
    draw(position: number, press: number, tint: number, palette: SwitchPalette, stretch = 0) {
      resize();
      // Size may dip slightly below rest as the lens snaps back; optics never go negative.
      const size = clamp(press, -0.12, 1), p = clamp(press, 0, 1), q = clamp(position, 0, 1);
      const s = clamp(stretch, 0, 0.25);
      const cx = 42 + q * 24, cy = 38, w = (36 + 24 * size) * (1 + s), h = (24 + 14 * size) * (1 - s * 0.35);
      const color = palette.on.map((v, i) => mix(palette.off[i], v, clamp(tint, 0, 1)));
      ctx.clearRect(0, 0, 110, 76);
      // The track and lens share one canvas, so track tint and refraction never diverge.
      ctx.fillStyle = `rgb(${color.join(',')})`;
      ctx.beginPath(); ctx.roundRect(22, 24, 64, 28, 14); ctx.fill();
      ctx.save();
      ctx.shadowColor = `rgba(0,0,0,${0.025 + p * 0.17})`;
      ctx.shadowBlur = 2 + p * 9; ctx.shadowOffsetY = 1 + p * 5;
      ctx.fillStyle = `rgb(${palette.thumb.join(',')})`;
      ctx.beginPath(); ctx.roundRect(cx - w / 2, cy - h / 2, w, h, h / 2); ctx.fill();
      ctx.restore();
      // Resting thumbs use the fast vector path; only interaction needs pixel optics.
      if (p < 0.001) return;
      const { data, width, height } = pixels;
      const radius = h / 2, halfStraight = (w - h) / 2;
      for (let iy = 0; iy < height; iy++) {
        const y = (iy + 0.5) / dpr;
        for (let ix = 0; ix < width; ix++) {
          const x = (ix + 0.5) / dpr, k = (iy * width + ix) * 4;
          const dx = x - cx, dy = y - cy;
          const ex = Math.max(Math.abs(dx) - halfStraight, 0), length = Math.hypot(ex, dy);
          const dist = length - radius, alpha = clamp(0.5 - dist * dpr, 0, 1);
          if (!alpha) { data[k + 3] = 0; continue; }
          const nx = length ? Math.sign(dx) * ex / length : 0, ny = length ? dy / length : 0;
          const edge = Math.exp(-Math.max(0, -dist) / 2.4);
          const sx = cx + dx * (1 + 0.10 * p) + nx * 3.2 * edge * p + 1.3 * p;
          const sy = cy + dy * (1 + 0.48 * p) + ny * 2 * edge * p;
          const inTrack = clamp(0.5 - distance(sx, sy, 54, 38, 64, 28) * dpr, 0, 1);
          const shade = p * (edge * 35 + clamp((dy / radius + 0.2) / 1.2, 0, 1) * 5);
          const rim = Math.exp(-Math.pow((-dist - 0.65) / 0.55, 2));
          const highlight = p * rim * (0.22 + 0.70 * clamp(-ny * 0.8 + nx * 0.25, 0, 1));
          for (let c = 0; c < 3; c++) {
            const through = mix(palette.surface[c], color[c], inTrack);
            const body = mix(palette.thumb[c], through, p * 0.94) - shade;
            data[k + c] = mix(body, 255, highlight);
          }
          data[k + 3] = Math.round(alpha * 255);
        }
      }
      bufferCtx.putImageData(pixels, 0, 0);
      ctx.drawImage(buffer, 0, 0, width, height, 0, 0, 110, 76);
    },
  };
}
