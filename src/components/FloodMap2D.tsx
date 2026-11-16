import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Home, Minus, Plus } from 'lucide-react';
import {
  DATUM_ASL_M,
  EXTENT_M,
  GRID,
  THRESHOLDS,
  clamp,
  elevationColor,
  worldToLatLon,
  type ThemeMode,
} from '../engine/terrainMath';
import {
  GAUGES,
  PAST_EVENTS,
  RES,
  RES_CELL_M,
  buildingFloodClass,
  pixToM,
  riverLine,
  sampleRaster,
  type Building,
  type DepthSet,
  type FineTerrain,
  type Gauge,
  type PastEvent,
  type Polyline,
} from '../engine/floodModel';
import {
  BUILDING_COLORS,
  DEPTH_RAMP,
  EXTENT_COLORS,
  LAYER_GROUPS,
  type Basemap,
  type LegendItem,
} from './layerCatalog';

/* ------------------------------------------------------------------------ */
/* Props                                                                     */
/* ------------------------------------------------------------------------ */

export interface MapCursor {
  x: number;
  z: number;
  lat: number;
  lon: number;
  elevationAsl: number;
}

interface FloodMap2DProps {
  fine: FineTerrain;
  elev: Float32Array;
  depths: DepthSet;
  riskGrid: Float32Array;
  riskKey: string;
  buildings: Building[];
  roads: Polyline[];
  activeLayers: string[];
  basemap: Basemap;
  onBasemap: (b: Basemap) => void;
  theme: ThemeMode;
  overlayOpacity: number;
  riverLevel: number;
  query: { x: number; z: number } | null;
  onQuery: (x: number, z: number) => void;
}

const HALF = EXTENT_M / 2;

const THEME_BG: Record<ThemeMode, string> = { light: '#EEF2F8', dark: '#050D1F' };
const THEME_INK: Record<ThemeMode, string> = { light: '#0B1F44', dark: '#F5F7FB' };

/* ------------------------------------------------------------------------ */
/* Raster builders                                                           */
/* ------------------------------------------------------------------------ */

const hexRGB = (h: string): [number, number, number] => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

function makeCanvas(): [HTMLCanvasElement, CanvasRenderingContext2D, ImageData] {
  const cv = document.createElement('canvas');
  cv.width = RES;
  cv.height = RES;
  const ctx = cv.getContext('2d')!;
  return [cv, ctx, ctx.createImageData(RES, RES)];
}

function hash(a: number, b: number): number {
  let h = Math.imul(a, 374761393) + Math.imul(b, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const IMAGERY_FIELDS = ['#7D9C55', '#93A85F', '#A8A86B', '#6F8F4A', '#B3A77A', '#89A35A'].map(hexRGB);

function buildBasemap(kind: Basemap, theme: ThemeMode, elev: Float32Array, fine: FineTerrain): HTMLCanvasElement {
  const [cv, ctx, img] = makeCanvas();
  const d = img.data;
  const tmp = new Float32Array(3);
  const L = [-0.5, 0.7071, -0.5]; // NW sun, 45° altitude
  const dark = theme === 'dark';
  const waterTopo = hexRGB(dark ? '#1E3A6A' : '#9CC3E6');
  const waterImg = hexRGB('#2B4A5E');

  for (let r = 0; r < RES; r++) {
    for (let c = 0; c < RES; c++) {
      const k = r * RES + c;
      const e = elev[k];
      const eR = elev[r * RES + Math.min(RES - 1, c + 1)];
      const eL = elev[r * RES + Math.max(0, c - 1)];
      const eD = elev[Math.min(RES - 1, r + 1) * RES + c];
      const eU = elev[Math.max(0, r - 1) * RES + c];
      const gx = (eR - eL) / (2 * RES_CELL_M);
      const gz = (eD - eU) / (2 * RES_CELL_M);
      const inv = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
      const shade = Math.max(0, (-gx * L[0] + L[1] - gz * L[2]) * inv);
      const asl = e + DATUM_ASL_M;
      const channel = fine.riverDist[k] < 32;
      let R = 0;
      let G = 0;
      let B = 0;

      if (kind === 'topographic') {
        if (channel) [R, G, B] = waterTopo;
        else {
          elevationColor(asl, 'light', tmp, 0);
          const s = (0.5 + 0.7 * shade) * (dark ? 0.62 : 1);
          R = tmp[0] * 255 * s;
          G = tmp[1] * 255 * s;
          B = tmp[2] * 255 * s;
          const band = Math.floor(asl / 50);
          if (band !== Math.floor((eR + DATUM_ASL_M) / 50) || band !== Math.floor((eD + DATUM_ASL_M) / 50)) {
            const idx = Math.floor(asl / 250) !== Math.floor((eR + DATUM_ASL_M) / 250) ||
              Math.floor(asl / 250) !== Math.floor((eD + DATUM_ASL_M) / 250);
            const m = idx ? 0.5 : 0.75;
            R *= m;
            G *= m;
            B *= m;
          }
        }
      } else if (kind === 'imagery') {
        if (channel) [R, G, B] = waterImg;
        else {
          const xm = pixToM(c);
          const zm = pixToM(r);
          const reliefShare = fine.relief[k];
          let base: [number, number, number];
          if (reliefShare < 0.03) {
            const f = IMAGERY_FIELDS[Math.floor(hash(Math.floor((xm + 0.3 * zm) / 210), Math.floor(zm / 150)) * IMAGERY_FIELDS.length)];
            const hedge = (Math.abs(((xm + 0.3 * zm) / 210) % 1) < 0.04 || Math.abs((zm / 150) % 1) < 0.05) ? 0.7 : 1;
            base = [f[0] * hedge, f[1] * hedge, f[2] * hedge];
          } else if (asl > 3400) base = [235, 236, 238];
          else if (asl > 2300) base = [128, 122, 114];
          else {
            const n = hash(c >> 1, r >> 1) * 0.25 + hash(c >> 3, r >> 3) * 0.2;
            base = [38 + 40 * n, 64 + 50 * n, 36 + 30 * n];
          }
          const s = 0.35 + 0.9 * shade;
          R = base[0] * s;
          G = base[1] * s;
          B = base[2] * s;
        }
      } else {
        if (channel) [R, G, B] = dark ? [30, 52, 92] : [196, 214, 236];
        else {
          const v = dark ? 14 + 40 * shade : 196 + 56 * shade;
          R = v * 0.97;
          G = v * 0.98;
          B = v * (dark ? 1.25 : 1.0);
        }
      }
      d[k * 4] = R;
      d[k * 4 + 1] = G;
      d[k * 4 + 2] = B;
      d[k * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

function buildOverlay(id: string, depths: DepthSet, riskGrid: Float32Array): HTMLCanvasElement | null {
  const [cv, ctx, img] = makeCanvas();
  const d = img.data;
  const [kind, scen, prob] = id.split(':');
  if (kind === 'extent' || kind === 'depth') {
    const raster = depths[`${prob}:${scen}` as keyof DepthSet];
    if (!raster) return null;
    const extentRGB = hexRGB(EXTENT_COLORS[prob as keyof typeof EXTENT_COLORS]);
    const ramp = DEPTH_RAMP.map((s) => hexRGB(s.color));
    for (let k = 0; k < raster.length; k++) {
      const v = raster[k];
      if (v <= 0) continue;
      let rgb = extentRGB;
      if (kind === 'depth') {
        let n = 0;
        while (v > DEPTH_RAMP[n].max) n++;
        rgb = ramp[n];
      }
      d[k * 4] = rgb[0];
      d[k * 4 + 1] = rgb[1];
      d[k * 4 + 2] = rgb[2];
      d[k * 4 + 3] = 255;
    }
  } else if (kind === 'landslide') {
    const warn = hexRGB('#EAB308');
    const crit = hexRGB('#DC2626');
    for (let r = 0; r < RES; r++) {
      const gz = ((r + 0.5) / RES) * (GRID - 1);
      const j0 = Math.min(GRID - 2, Math.floor(gz));
      const fz = gz - j0;
      for (let c = 0; c < RES; c++) {
        const gx = ((c + 0.5) / RES) * (GRID - 1);
        const i0 = Math.min(GRID - 2, Math.floor(gx));
        const fx = gx - i0;
        const a = riskGrid[j0 * GRID + i0];
        const b = riskGrid[j0 * GRID + i0 + 1];
        const cc = riskGrid[(j0 + 1) * GRID + i0];
        const dd = riskGrid[(j0 + 1) * GRID + i0 + 1];
        const v = (a * (1 - fx) + b * fx) * (1 - fz) + (cc * (1 - fx) + dd * fx) * fz;
        if (v < THRESHOLDS.warning) continue;
        const rgb = v >= THRESHOLDS.critical ? crit : warn;
        const k = r * RES + c;
        d[k * 4] = rgb[0];
        d[k * 4 + 1] = rgb[1];
        d[k * 4 + 2] = rgb[2];
        d[k * 4 + 3] = 235;
      }
    }
  } else return null;
  ctx.putImageData(img, 0, 0);
  return cv;
}

/** Raster draw order: landslide susceptibility, then depth, then extents (rarest underneath). */
function rasterOrder(id: string): number {
  const [kind, scen, prob] = id.split(':');
  const s = { highEnd: 0, midRange: 1, present: 2 }[scen as 'present'] ?? 0;
  const p = { low: 0, medium: 1, high: 2 }[prob as 'low'] ?? 0;
  if (kind === 'depth') return 10 + s * 3 + p;
  if (kind === 'extent') return 30 + s * 3 + p;
  return 0;
}

/* ------------------------------------------------------------------------ */
/* Component                                                                 */
/* ------------------------------------------------------------------------ */

type Feature = { kind: 'event'; data: PastEvent } | { kind: 'gauge'; data: Gauge };

export default function FloodMap2D(props: FloodMap2DProps) {
  const {
    fine,
    elev,
    depths,
    riskGrid,
    riskKey,
    buildings,
    roads,
    activeLayers,
    basemap,
    onBasemap,
    theme,
    overlayOpacity,
    riverLevel,
    query,
    onQuery,
  } = props;

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view = useRef({ cx: 0, cz: 0, s: 0, w: 1, h: 1, fit: 0.1 });
  const drawRef = useRef<() => void>(() => {});
  const rafRef = useRef(0);
  const [cursor, setCursor] = useState<MapCursor | null>(null);
  const [feature, setFeature] = useState<{ f: Feature; sx: number; sy: number } | null>(null);
  const [scaleBar, setScaleBar] = useState({ px: 100, label: '1 km' });
  const [legendOpen, setLegendOpen] = useState(true);

  const active = useMemo(() => new Set(activeLayers), [activeLayers]);
  const river = useMemo(() => riverLine(), []);

  /* --- Cached rasters ------------------------------------------------- */
  const basemapCanvas = useMemo(() => buildBasemap(basemap, theme, elev, fine), [basemap, theme, elev, fine]);
  const overlayCache = useRef(new Map<string, HTMLCanvasElement | null>());
  useEffect(() => {
    overlayCache.current.clear();
  }, [depths]);
  useEffect(() => {
    overlayCache.current.delete('landslide');
  }, [riskKey]);

  const buildingClasses = useMemo(
    () => buildings.map((b) => buildingFloodClass(depths, b, 'present')),
    [buildings, depths],
  );

  /* --- Draw ----------------------------------------------------------- */
  drawRef.current = () => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d')!;
    const { cx, cz, s, w, h } = view.current;
    const dpr = cv.width / w;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = THEME_BG[theme];
    ctx.fillRect(0, 0, w, h);
    const sx = (x: number) => (x - cx) * s + w / 2;
    const sy = (z: number) => (z - cz) * s + h / 2;
    const x0 = sx(-HALF);
    const y0 = sy(-HALF);
    const size = EXTENT_M * s;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(basemapCanvas, x0, y0, size, size);

    // raster overlays
    const rasters = activeLayers
      .filter((id) => id.startsWith('extent:') || id.startsWith('depth:') || id === 'landslide')
      .sort((a, b) => rasterOrder(a) - rasterOrder(b));
    ctx.globalAlpha = overlayOpacity;
    for (const id of rasters) {
      let c = overlayCache.current.get(id);
      if (c === undefined) {
        c = buildOverlay(id, depths, riskGrid);
        overlayCache.current.set(id, c);
      }
      if (c) ctx.drawImage(c, x0, y0, size, size);
    }
    ctx.globalAlpha = 1;

    // 1 km grid
    if (active.has('grid')) {
      ctx.strokeStyle = theme === 'dark' ? 'rgba(245,247,251,0.18)' : 'rgba(11,31,68,0.22)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let m = -HALF; m <= HALF; m += 1000) {
        ctx.moveTo(Math.round(sx(m)) + 0.5, y0);
        ctx.lineTo(Math.round(sx(m)) + 0.5, y0 + size);
        ctx.moveTo(x0, Math.round(sy(m)) + 0.5);
        ctx.lineTo(x0 + size, Math.round(sy(m)) + 0.5);
      }
      ctx.stroke();
    }

    // river centreline
    if (active.has('river')) {
      ctx.strokeStyle = '#2563EB';
      ctx.lineWidth = clamp(18 * s, 1.5, 10);
      ctx.lineJoin = 'round';
      ctx.beginPath();
      river.forEach(([x, z], n) => (n ? ctx.lineTo(sx(x), sy(z)) : ctx.moveTo(sx(x), sy(z))));
      ctx.stroke();
    }

    // roads
    if (active.has('roads')) {
      for (const pass of [0, 1]) {
        for (const r of roads) {
          const base = r.kind === 'primary' ? 3 : 2.2;
          const wpx = clamp(base * Math.sqrt(s / view.current.fit), base, base * 3);
          ctx.strokeStyle = pass === 0 ? (theme === 'dark' ? '#0B1730' : '#FFFFFF') : r.kind === 'primary' ? '#F59E0B' : '#FCD34D';
          ctx.lineWidth = pass === 0 ? wpx + 2 : wpx;
          ctx.lineCap = 'round';
          ctx.beginPath();
          r.pts.forEach(([x, z], n) => (n ? ctx.lineTo(sx(x), sy(z)) : ctx.moveTo(sx(x), sy(z))));
          ctx.stroke();
        }
      }
    }

    // buildings
    if (active.has('buildings')) {
      ctx.lineWidth = 0.75;
      ctx.strokeStyle = theme === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(11,31,68,0.55)';
      buildings.forEach((b, n) => {
        const cls = buildingClasses[n];
        ctx.fillStyle = BUILDING_COLORS[cls ?? 'none'];
        const px = sx(b.x);
        const py = sy(b.z);
        if (px < -40 || py < -40 || px > w + 40 || py > h + 40) return;
        const bw = Math.max(3, b.w * s);
        const bh = Math.max(3, b.h * s);
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(b.angle);
        ctx.fillRect(-bw / 2, -bh / 2, bw, bh);
        ctx.strokeRect(-bw / 2, -bh / 2, bw, bh);
        ctx.restore();
      });
    }

    // past flood events
    for (const e of PAST_EVENTS) {
      if (!active.has(`events:${e.type}`)) continue;
      const px = sx(e.x);
      const py = sy(e.z);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#FFFFFF';
      ctx.beginPath();
      if (e.type === 'single') {
        ctx.fillStyle = '#0EA5E9';
        ctx.arc(px, py, 6, 0, Math.PI * 2);
      } else {
        ctx.fillStyle = '#7C3AED';
        ctx.moveTo(px, py - 8);
        ctx.lineTo(px + 7, py);
        ctx.lineTo(px, py + 8);
        ctx.lineTo(px - 7, py);
        ctx.closePath();
      }
      ctx.fill();
      ctx.stroke();
    }

    // gauges
    if (active.has('gauges')) {
      ctx.font = '600 10px "JetBrains Mono", monospace';
      for (const g of GAUGES) {
        const px = sx(g.x);
        const py = sy(g.z);
        const stage = Math.max(0, riverLevel + g.offset);
        const over = stage >= THRESHOLDS.floodStage;
        ctx.fillStyle = over ? '#C8102E' : '#0F766E';
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 1.5;
        ctx.fillRect(px - 6, py - 6, 12, 12);
        ctx.strokeRect(px - 6, py - 6, 12, 12);
        const label = `${g.id} ${stage.toFixed(1)} m`;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = theme === 'dark' ? 'rgba(11,23,48,0.92)' : 'rgba(255,255,255,0.94)';
        ctx.fillRect(px + 10, py - 8, tw + 10, 16);
        ctx.strokeStyle = over ? '#C8102E' : theme === 'dark' ? '#1E2E50' : '#D9E1EC';
        ctx.lineWidth = 1;
        ctx.strokeRect(px + 10.5, py - 7.5, tw + 9, 15);
        ctx.fillStyle = over ? '#C8102E' : THEME_INK[theme];
        ctx.fillText(label, px + 15, py + 3.5);
      }
    }

    // query marker
    if (query) {
      const px = sx(query.x);
      const py = sy(query.z);
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(px - 8, py - 8);
      ctx.lineTo(px + 8, py + 8);
      ctx.moveTo(px + 8, py - 8);
      ctx.lineTo(px - 8, py + 8);
      ctx.stroke();
      ctx.strokeStyle = '#C8102E';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(px, py, 2500 * s, 0, Math.PI * 2);
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.25;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // tile frame
    ctx.strokeStyle = theme === 'dark' ? '#1E2E50' : '#94A3B8';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(size), Math.round(size));

    // graticule labels on the frame
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillStyle = theme === 'dark' ? '#9AA8C2' : '#4A5B78';
    for (let m = -HALF; m <= HALF; m += 2000) {
      const { lon } = worldToLatLon((m / EXTENT_M) * 160, 0);
      const { lat } = worldToLatLon(0, (m / EXTENT_M) * 160);
      const lx = sx(m);
      const ly = sy(m);
      if (lx > 0 && lx < w) ctx.fillText(`${lon.toFixed(3)}°E`, lx - 26, Math.min(h - 6, y0 + size + 14));
      if (ly > 0 && ly < h) ctx.fillText(`${lat.toFixed(3)}°N`, Math.max(4, x0 - 76), ly + 3);
    }
  };

  const requestDraw = () => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => drawRef.current());
  };

  const updateScaleBar = () => {
    const s = view.current.s;
    const target = 110 / s; // metres represented by ~110 px
    const steps = [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000];
    const m = steps.reduce((best, v) => (Math.abs(v - target) < Math.abs(best - target) ? v : best), steps[0]);
    setScaleBar({ px: m * s, label: m >= 1000 ? `${m / 1000} km` : `${m} m` });
  };

  // redraw whenever inputs change
  useEffect(requestDraw);

  /* --- Sizing & initial fit ------------------------------------------- */
  useEffect(() => {
    const wrap = wrapRef.current!;
    const cv = canvasRef.current!;
    const ro = new ResizeObserver(() => {
      const w = Math.max(1, wrap.clientWidth);
      const h = Math.max(1, wrap.clientHeight);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      const v = view.current;
      const fit = Math.max(Math.min(w - (w > 900 ? 640 : 80), h - 140), Math.min(w, h) * 0.6) / EXTENT_M;
      if (v.s === 0) {
        v.s = fit;
        v.cz = 0;
        v.cx = 0;
      }
      v.fit = fit;
      v.w = w;
      v.h = h;
      updateScaleBar();
      drawRef.current();
    });
    ro.observe(wrap);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(rafRef.current);
    };
  }, []);

  /* --- Interaction ---------------------------------------------------- */
  const drag = useRef<{ x: number; y: number; cx: number; cz: number; moved: boolean } | null>(null);

  const toWorld = (clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const v = view.current;
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    return { px, py, x: (px - v.w / 2) / v.s + v.cx, z: (py - v.h / 2) / v.s + v.cz };
  };

  const clampView = () => {
    const v = view.current;
    v.s = clamp(v.s, v.fit * 0.6, v.fit * 24);
    v.cx = clamp(v.cx, -HALF, HALF);
    v.cz = clamp(v.cz, -HALF, HALF);
  };

  const zoomAt = (factor: number, px: number, py: number) => {
    const v = view.current;
    const wx = (px - v.w / 2) / v.s + v.cx;
    const wz = (py - v.h / 2) / v.s + v.cz;
    v.s *= factor;
    clampView();
    v.cx = wx - (px - v.w / 2) / v.s;
    v.cz = wz - (py - v.h / 2) / v.s;
    clampView();
    setFeature(null);
    updateScaleBar();
    requestDraw();
  };

  useEffect(() => {
    const cv = canvasRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { px, py } = toWorld(e.clientX, e.clientY);
      zoomAt(Math.exp(-e.deltaY * 0.0015), px, py);
    };
    cv.addEventListener('wheel', onWheel, { passive: false });
    return () => cv.removeEventListener('wheel', onWheel);
  }, []);

  const hitFeature = (px: number, py: number): Feature | null => {
    const v = view.current;
    const sx = (x: number) => (x - v.cx) * v.s + v.w / 2;
    const sy = (z: number) => (z - v.cz) * v.s + v.h / 2;
    if (active.has('gauges'))
      for (const g of GAUGES) if (Math.hypot(sx(g.x) - px, sy(g.z) - py) < 10) return { kind: 'gauge', data: g };
    for (const e of PAST_EVENTS)
      if (active.has(`events:${e.type}`) && Math.hypot(sx(e.x) - px, sy(e.z) - py) < 10) return { kind: 'event', data: e };
    return null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, cx: view.current.cx, cz: view.current.cz, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d) {
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) > 3) {
        d.moved = true;
        setFeature(null);
      }
      if (d.moved) {
        view.current.cx = d.cx - dx / view.current.s;
        view.current.cz = d.cz - dy / view.current.s;
        clampView();
        requestDraw();
      }
    }
    const w = toWorld(e.clientX, e.clientY);
    if (Math.abs(w.x) <= HALF && Math.abs(w.z) <= HALF) {
      const { lat, lon } = worldToLatLon((w.x / EXTENT_M) * 160, (w.z / EXTENT_M) * 160);
      setCursor({ x: w.x, z: w.z, lat, lon, elevationAsl: sampleRaster(elev, w.x, w.z) + DATUM_ASL_M });
    } else setCursor(null);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    const w = toWorld(e.clientX, e.clientY);
    const f = hitFeature(w.px, w.py);
    if (f) {
      setFeature({ f, sx: w.px, sy: w.py });
      return;
    }
    setFeature(null);
    if (Math.abs(w.x) <= HALF && Math.abs(w.z) <= HALF) onQuery(w.x, w.z);
  };

  const home = () => {
    const v = view.current;
    v.s = v.fit;
    v.cx = 0;
    v.cz = 0;
    setFeature(null);
    updateScaleBar();
    requestDraw();
  };

  /* --- Legend content ------------------------------------------------- */
  const legendEntries = useMemo(
    () =>
      LAYER_GROUPS.flatMap((g) =>
        g.layers.filter((l) => active.has(l.id)).map((l) => ({ group: g.title, layer: l })),
      ),
    [active],
  );

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden bg-canvas">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full cursor-crosshair touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setCursor(null)}
        aria-label="2D flood map. Drag to pan, scroll to zoom, click to query a location."
        role="img"
      />

      {/* zoom + north */}
      <div className="absolute left-4 top-4 z-10 flex flex-col gap-2">
        <div className="flex flex-col border border-line bg-panel">
          <MapButton label="Zoom in" onClick={() => zoomAt(1.5, view.current.w / 2, view.current.h / 2)}>
            <Plus size={15} strokeWidth={1.5} />
          </MapButton>
          <MapButton label="Zoom out" onClick={() => zoomAt(1 / 1.5, view.current.w / 2, view.current.h / 2)} border>
            <Minus size={15} strokeWidth={1.5} />
          </MapButton>
          <MapButton label="Full extent" onClick={home} border>
            <Home size={14} strokeWidth={1.5} />
          </MapButton>
        </div>
        <div className="flex h-10 w-8 flex-col items-center justify-center border border-line bg-panel" aria-label="North">
          <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden>
            <path d="M6 0 L12 14 L6 10 L0 14 Z" fill="rgb(var(--c-brand))" />
          </svg>
          <span className="font-mono text-[9px] font-semibold text-fg">N</span>
        </div>
      </div>

      {/* feature popup */}
      {feature && <FeaturePopup feature={feature} riverLevel={riverLevel} onClose={() => setFeature(null)} />}

      {/* legend */}
      <aside className="absolute right-4 top-4 z-10 w-[min(272px,calc(100%-32px))] border border-line bg-panel">
        <button
          type="button"
          onClick={() => setLegendOpen((o) => !o)}
          className="flex h-9 w-full items-center justify-between border-b border-line px-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted hover:text-fg"
          aria-expanded={legendOpen}
        >
          Legend
          {legendOpen ? <ChevronUp size={14} strokeWidth={1.5} /> : <ChevronDown size={14} strokeWidth={1.5} />}
        </button>
        {legendOpen && (
          <div className="max-h-[min(52vh,460px)] space-y-3 overflow-y-auto px-3 py-2.5">
            {legendEntries.length === 0 && <p className="text-[11px] text-muted">No layers active.</p>}
            {legendEntries.map(({ group, layer }) => (
              <div key={layer.id}>
                <div className="text-[10px] uppercase tracking-wider text-muted">{group}</div>
                <div className="mb-1 text-[11px] font-medium text-fg">{layer.title}</div>
                <ul className="space-y-0.5">
                  {layer.legend.map((item) => (
                    <LegendSwatch key={item.label} item={item} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </aside>

      {/* basemap switcher + scale */}
      <div className="absolute bottom-4 left-4 z-10 flex items-end gap-3">
        <div className="flex border border-line bg-panel" role="radiogroup" aria-label="Basemap">
          {(['topographic', 'imagery', 'monochrome'] as Basemap[]).map((b, n) => (
            <button
              key={b}
              type="button"
              role="radio"
              aria-checked={basemap === b}
              onClick={() => onBasemap(b)}
              className={`flex flex-col items-center gap-1 px-2 py-1.5 text-[10px] font-medium capitalize ${
                n ? 'border-l border-line' : ''
              } ${basemap === b ? 'bg-brand text-white' : 'text-muted hover:bg-subtle hover:text-fg'}`}
            >
              <span className={`h-6 w-10 border border-black/10 ${BASEMAP_THUMB[b]}`} />
              {b}
            </button>
          ))}
        </div>
        <div className="border border-line bg-panel px-2 py-1.5">
          <div className="h-1.5 border-x border-b border-fg" style={{ width: scaleBar.px }} />
          <div className="tnum mt-0.5 font-mono text-[10px] text-fg">{scaleBar.label}</div>
        </div>
      </div>

      {/* cursor readout */}
      <div className="tnum absolute bottom-4 right-4 z-10 border border-line bg-panel px-2.5 py-1.5 font-mono text-[10px] text-muted">
        {cursor ? (
          <>
            <span className="text-fg">
              {cursor.lat.toFixed(5)}°N {cursor.lon.toFixed(5)}°E
            </span>
            <span className="mx-1.5 text-line">|</span>E {Math.round(cursor.x + HALF)} N {Math.round(HALF - cursor.z)} m
            <span className="mx-1.5 text-line">|</span>
            {Math.round(cursor.elevationAsl).toLocaleString('en-US')} m ASL
          </>
        ) : (
          <span>Click the map to query a location · drag to pan · scroll to zoom</span>
        )}
      </div>
    </div>
  );
}

const BASEMAP_THUMB: Record<Basemap, string> = {
  topographic: 'bg-[linear-gradient(135deg,#5b8a52,#c9c48a_55%,#b89a6a)]',
  imagery: 'bg-[linear-gradient(135deg,#2f4a2a,#7d9c55_50%,#2b4a5e)]',
  monochrome: 'bg-[linear-gradient(135deg,#e5e7eb,#9ca3af)]',
};

function MapButton({
  label,
  onClick,
  border,
  children,
}: {
  label: string;
  onClick: () => void;
  border?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex h-8 w-8 items-center justify-center text-fg hover:bg-subtle ${border ? 'border-t border-line' : ''}`}
    >
      {children}
    </button>
  );
}

export function LegendSwatch({ item }: { item: LegendItem }) {
  const shape = item.shape ?? 'fill';
  return (
    <li className="flex items-center gap-2 text-[11px] text-fg">
      {shape === 'line' ? (
        <span className="h-0.5 w-4" style={{ background: item.color }} />
      ) : shape === 'circle' ? (
        <span className="h-3 w-3 rounded-full border border-white" style={{ background: item.color }} />
      ) : shape === 'diamond' ? (
        <span className="mx-0.5 h-2.5 w-2.5 rotate-45 border border-white" style={{ background: item.color }} />
      ) : (
        <span className="h-3 w-4 border border-black/10" style={{ background: item.color }} />
      )}
      <span className="tnum">{item.label}</span>
    </li>
  );
}

function FeaturePopup({
  feature,
  riverLevel,
  onClose,
}: {
  feature: { f: Feature; sx: number; sy: number };
  riverLevel: number;
  onClose: () => void;
}) {
  const { f, sx, sy } = feature;
  return (
    <div
      className="absolute z-20 w-64 border border-line bg-panel text-[11px] shadow-[0_1px_0_rgba(0,0,0,0.04)]"
      style={{ left: Math.max(8, sx + 14), top: Math.max(8, sy - 20) }}
      role="dialog"
    >
      <div className="flex h-8 items-center justify-between border-b border-line pl-3">
        <span className="font-semibold text-fg">
          {f.kind === 'event' ? `${f.data.id} · ${f.data.type === 'single' ? 'Single' : 'Recurring'} Flood Event` : `${f.data.id} · ${f.data.name}`}
        </span>
        <button type="button" onClick={onClose} className="h-full border-l border-line px-2.5 text-muted hover:text-fg" aria-label="Close">
          ×
        </button>
      </div>
      <dl className="grid grid-cols-[88px_1fr] gap-x-2 gap-y-1 px-3 py-2 font-mono">
        {f.kind === 'event' ? (
          <>
            <dt className="text-muted">Date</dt>
            <dd className="tnum text-fg">{f.data.date}</dd>
            <dt className="text-muted">Source</dt>
            <dd className="text-fg">{f.data.source}</dd>
            <dt className="text-muted">Occurrences</dt>
            <dd className="tnum text-fg">{f.data.occurrences}</dd>
            <dt className="text-muted">Notes</dt>
            <dd className="font-sans text-fg">{f.data.description}</dd>
          </>
        ) : (
          <>
            <dt className="text-muted">Stage</dt>
            <dd className="tnum text-fg">{Math.max(0, riverLevel + f.data.offset).toFixed(2)} m</dd>
            <dt className="text-muted">Flood stage</dt>
            <dd className="tnum text-fg">{THRESHOLDS.floodStage.toFixed(1)} m</dd>
            <dt className="text-muted">Status</dt>
            <dd className={riverLevel + f.data.offset >= THRESHOLDS.floodStage ? 'text-crit' : 'text-safe'}>
              {riverLevel + f.data.offset >= THRESHOLDS.floodStage ? 'ABOVE FLOOD STAGE' : 'NORMAL'}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}
