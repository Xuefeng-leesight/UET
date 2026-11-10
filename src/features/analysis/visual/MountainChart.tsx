import React, { useRef, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { HeatmapPoint } from '@/shared/types/mrt';
import type { MountainChartHandle, MountainChartSettings } from '@/features/analysis/visual/mountainChartContract';

interface Props {
  videoElement: HTMLVideoElement | null;
  imageUrl?: string | null;
  videoSize: { w: number; h: number } | null;
  points: HeatmapPoint[];
  currentTime: number;  // milliseconds, cumulative filter threshold
  settings: MountainChartSettings;
  backgroundColor?: string;
}

// 热力配色：蓝(冷/零) → 青 → 绿 → 黄 → 橙 → 红(热/峰)
const COLOR_MAP: [number, number, number][] = [
  [0.0, 0.0, 0.2],
  [0.0, 0.3, 0.8],
  [0.0, 0.7, 0.3],
  [0.8, 0.8, 0.0],
  [1.0, 0.4, 0.0],
  [1.0, 0.0, 0.0],
];

function sampleColor(colors: [number, number, number][], t: number): [number, number, number] {
  const clamped = Math.max(0, Math.min(1, t));
  const idx = clamped * (colors.length - 1);
  const i0 = Math.min(Math.floor(idx), colors.length - 1);
  const i1 = Math.min(i0 + 1, colors.length - 1);
  const frac = idx - i0;
  const c0 = colors[i0];
  const c1 = colors[i1];
  return [
    c0[0] + (c1[0] - c0[0]) * frac,
    c0[1] + (c1[1] - c0[1]) * frac,
    c0[2] + (c1[2] - c0[2]) * frac,
  ];
}

function computeDensityGrid(
  points: HeatmapPoint[],
  resolution: number,
  smoothing: number,
): Float32Array {
  const size = resolution;
  const grid = new Float32Array(size * size);
  if (points.length === 0) return grid;

  const kernelRadius = smoothing * resolution * 0.15;
  const sigma = Math.max(kernelRadius / 2, 1);

  for (const p of points) {
    const cx = Math.round(p.x * (size - 1));
    // Eye-tracking coordinates use a top-left origin, while PlaneGeometry's
    // local Y axis grows from bottom to top. Flip Y so peaks align with video.
    const cy = Math.round((1 - p.y) * (size - 1));
    if (cx < 0 || cx >= size || cy < 0 || cy >= size) continue;
    const weight = typeof p.weight === 'number' && p.weight > 0 ? p.weight : 1;

    const kernelR = Math.ceil(kernelRadius);
    for (let dx = -kernelR; dx <= kernelR; dx++) {
      for (let dy = -kernelR; dy <= kernelR; dy++) {
        const gx = cx + dx;
        const gy = cy + dy;
        if (gx < 0 || gx >= size || gy < 0 || gy >= size) continue;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const gauss = Math.exp(-(dist * dist) / (2 * sigma * sigma));
        grid[gy * size + gx] += gauss * weight;
      }
    }
  }

  let maxVal = 0;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] > maxVal) maxVal = grid[i];
  }
  if (maxVal > 0) {
    for (let i = 0; i < grid.length; i++) {
      grid[i] /= maxVal;
    }
  }

  return grid;
}

const MountainChart = forwardRef<MountainChartHandle, Props>(
  ({ videoElement, imageUrl, videoSize, points, currentTime, settings, backgroundColor }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const controlsRef = useRef<OrbitControls | null>(null);
    const videoPlaneRef = useRef<THREE.Mesh | null>(null);
    const mountainMeshRef = useRef<THREE.Mesh | null>(null);
    const gridHelperRef = useRef<THREE.GridHelper | null>(null);
    const videoTextureRef = useRef<THREE.VideoTexture | null>(null);
    const imageTextureRef = useRef<THREE.Texture | null>(null);
    const animFrameRef = useRef<number>(0);
    const densityGridRef = useRef<Float32Array | null>(null);
    const lastPointsHashRef = useRef<string>('');

    const planeW = videoSize && videoSize.w > 0 ? videoSize.w : 640;
    const planeH = videoSize && videoSize.h > 0 ? videoSize.h : 360;

    const maxDim = Math.max(planeW, planeH);
    const scale = 10 / maxDim;
    const worldW = planeW * scale;
    const worldH = planeH * scale;

    // Parse background color
    const bgColor = backgroundColor || '#1a1a2e';

    // Setup scene (runs once)
    useEffect(() => {
      if (!containerRef.current) return;

      const container = containerRef.current;
      const w = container.clientWidth;
      const h = container.clientHeight;

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      renderer.setSize(w, h);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      container.appendChild(renderer.domElement);
      rendererRef.current = renderer;

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(bgColor);
      sceneRef.current = scene;

      const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
      camera.position.set(0, worldH * 1.8, worldH * 0.5);
      camera.lookAt(0, 0, 0);
      cameraRef.current = camera;

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.target.set(0, 0, 0);
      controls.minDistance = 1;
      controls.maxDistance = 30;
      controls.maxPolarAngle = Math.PI * 0.6;
      controlsRef.current = controls;

      const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
      scene.add(ambientLight);
      const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
      directionalLight.position.set(5, 5, 10);
      scene.add(directionalLight);
      const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.3);
      dirLight2.position.set(-5, -2, -5);
      scene.add(dirLight2);

      const gridHelper = new THREE.GridHelper(Math.max(worldW, worldH) * 1.5, 20, 0x444466, 0x222244);
      gridHelper.visible = false;
      gridHelperRef.current = gridHelper;
      scene.add(gridHelper);

      // Video plane — rotated 90° to lay flat on XZ plane
      const videoPlaneGeo = new THREE.PlaneGeometry(worldW, worldH);
      const videoPlaneMat = new THREE.MeshBasicMaterial({ color: 0x333333, side: THREE.DoubleSide });
      const videoPlane = new THREE.Mesh(videoPlaneGeo, videoPlaneMat);
      videoPlane.rotation.x = -Math.PI / 2;
      videoPlane.position.y = -0.01;
      videoPlaneRef.current = videoPlane;
      scene.add(videoPlane);

      // Mountain mesh — same rotation, peaks go upward
      const mountainGeo = new THREE.PlaneGeometry(worldW, worldH, 2, 2);
      const mountainMat = new THREE.MeshPhongMaterial({
        color: 0xff4444,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.7,
        depthWrite: true,
      });
      const mountainMesh = new THREE.Mesh(mountainGeo, mountainMat);
      mountainMesh.rotation.x = -Math.PI / 2;
      mountainMesh.position.y = 0.01;
      mountainMeshRef.current = mountainMesh;
      scene.add(mountainMesh);

      const animate = () => {
        animFrameRef.current = requestAnimationFrame(animate);
        controls.update();
        renderer.render(scene, camera);
      };
      animate();

      const handleResize = () => {
        if (!containerRef.current || !rendererRef.current || !cameraRef.current) return;
        const cw = containerRef.current.clientWidth;
        const ch = containerRef.current.clientHeight;
        rendererRef.current.setSize(cw, ch);
        cameraRef.current.aspect = cw / ch;
        cameraRef.current.updateProjectionMatrix();
      };
      window.addEventListener('resize', handleResize);

      return () => {
        cancelAnimationFrame(animFrameRef.current);
        window.removeEventListener('resize', handleResize);
        renderer.dispose();
        if (container.contains(renderer.domElement)) {
          container.removeChild(renderer.domElement);
        }
        scene.clear();
      };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Update background color when it changes
    useEffect(() => {
      if (sceneRef.current) {
        sceneRef.current.background = new THREE.Color(bgColor);
      }
    }, [bgColor]);

    // Handle background texture. Mapping visualizations use a static image,
    // while regular record visualizations continue to use the video element.
    useEffect(() => {
      const videoPlane = videoPlaneRef.current;
      if (!videoPlane) return;

      // Cleanup previous texture
      if (videoTextureRef.current) {
        videoTextureRef.current.dispose();
        videoTextureRef.current = null;
      }
      if (imageTextureRef.current) {
        imageTextureRef.current.dispose();
        imageTextureRef.current = null;
      }

      const material = videoPlane.material as THREE.MeshBasicMaterial;

      if (imageUrl && settings.showVideo) {
        let cancelled = false;
        new THREE.TextureLoader().load(imageUrl, (texture) => {
          if (cancelled) {
            texture.dispose();
            return;
          }
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.minFilter = THREE.LinearFilter;
          texture.magFilter = THREE.LinearFilter;
          imageTextureRef.current = texture;
          material.map = texture;
          material.color.set(0xffffff);
          material.needsUpdate = true;
        });
        return () => {
          cancelled = true;
          if (imageTextureRef.current) {
            imageTextureRef.current.dispose();
            imageTextureRef.current = null;
          }
        };
      }

      if (!videoElement || !settings.showVideo) {
        material.map = null;
        material.color.set(0x222233);
        material.needsUpdate = true;
        return;
      }

      const texture = new THREE.VideoTexture(videoElement);
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.colorSpace = THREE.SRGBColorSpace;
      videoTextureRef.current = texture;

      material.map = texture;
      material.color.set(0xffffff);
      material.needsUpdate = true;
    }, [imageUrl, videoElement, settings.showVideo]);

    // Video plane visibility
    useEffect(() => {
      if (videoPlaneRef.current) {
        videoPlaneRef.current.visible = settings.showVideo && Boolean(imageUrl || videoElement);
      }
    }, [imageUrl, settings.showVideo, videoElement]);

    // Grid visibility
    useEffect(() => {
      if (gridHelperRef.current) {
        gridHelperRef.current.visible = settings.showGrid;
      }
    }, [settings.showGrid]);

    // Mountain mesh update — dynamic, filters points by currentTime
    useEffect(() => {
      const mountainMesh = mountainMeshRef.current;
      if (!mountainMesh) return;

      // Filter points cumulatively up to currentTime
      const activePoints = currentTime > 0
        ? points.filter((p) => (p.timestamp || 0) <= currentTime)
        : [];

      const pointsHash = `${activePoints.length}_${currentTime.toFixed(2)}_${settings.gridResolution}_${settings.peakSmoothing}`;
      const needRebuild = pointsHash !== lastPointsHashRef.current;

      if (needRebuild) {
        lastPointsHashRef.current = pointsHash;
        densityGridRef.current = computeDensityGrid(activePoints, settings.gridResolution, settings.peakSmoothing);
      }

      const densityGrid = densityGridRef.current || new Float32Array(settings.gridResolution * settings.gridResolution);
      const res = settings.gridResolution;

      mountainMesh.geometry.dispose();

      // Build geometry with vertex displacement + per-vertex color
      const geo = new THREE.PlaneGeometry(worldW, worldH, res - 1, res - 1);
      const positions = geo.attributes.position;
      const colorsArr = new Float32Array(positions.count * 3);

      for (let i = 0; i < positions.count; i++) {
        const x = positions.getX(i);
        const y = positions.getY(i);

        const gx = Math.round(((x / worldW) + 0.5) * (res - 1));
        const gy = Math.round(((y / worldH) + 0.5) * (res - 1));

        let density = 0;
        if (gx >= 0 && gx < res && gy >= 0 && gy < res) {
          density = densityGrid[gy * res + gx];
        }

        const smoothD = density * density * (3 - 2 * density);
        positions.setZ(i, smoothD * settings.heightScale * worldH * 0.5);

        const [r, g, b] = sampleColor(COLOR_MAP, density);
        colorsArr[i * 3] = r;
        colorsArr[i * 3 + 1] = g;
        colorsArr[i * 3 + 2] = b;
      }

      geo.setAttribute('color', new THREE.BufferAttribute(colorsArr, 3));
      geo.computeVertexNormals();

      const mat = mountainMesh.material as THREE.MeshPhongMaterial;
      mat.opacity = settings.opacity;
      mat.transparent = settings.opacity < 1;
      mat.wireframe = settings.wireframe;
      mat.vertexColors = true;
      mat.map = null;

      mountainMesh.geometry = geo;
    }, [points, currentTime, settings, worldW, worldH]);

    const resetCamera = useCallback(() => {
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      if (!camera || !controls) return;
      camera.position.set(0, worldH * 1.8, worldH * 0.5);
      controls.target.set(0, 0, 0);
      controls.update();
    }, [worldH]);

    const getCanvas = useCallback(() => rendererRef.current?.domElement ?? null, []);

    useImperativeHandle(
      ref,
      () => ({ resetCamera, getCanvas }),
      [getCanvas, resetCamera],
    );

    return (
      <div
        ref={containerRef}
        className="absolute inset-0 w-full h-full"
        style={{ touchAction: 'none' }}
      />
    );
  },
);

MountainChart.displayName = 'MountainChart';

export default MountainChart;
