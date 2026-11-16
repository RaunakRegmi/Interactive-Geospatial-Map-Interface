/**
 * floodModel.ts
 * ---------------------------------------------------------------------------
 * Design-event flood mapping on top of the procedural DEM.
 *
 *  - Fine-resolution (12.5 m) elevation raster resampled from the DEM.
 *  - Flood extent & depth for three Annual Exceedance Probabilities (AEP)
 *    under three climate scenarios, using a channel-connected
 *    ("bathtub with connectivity") inundation model.
 *  - Synthetic exposure data: buildings, roads, river gauges, past events.
 *  - Point query / local-area summary report.
 */

import {
  EXTENT_M,
  GRID,
  clamp,
  reliefScale,
  riverCenterline,
  type DEM,
} from './terrainMath';

/* ------------------------------------------------------------------------ */
/* Raster definition                                                         */
/* ------------------------------------------------------------------------ */

/** Pixels per side of the fine raster. */
export const RES = 640;
export const RES_CELL_M = EXTENT_M / RES;
export const RES_CELL_KM2 = (RES_CELL_M * RES_CELL_M) / 1e6;
const HALF_M = EXTENT_M / 2;

/** Pixel (column/row) -> metres from tile centre (x east, z south). */
export const pixToM = (p: number): number => (p + 0.5) * RES_CELL_M - HALF_M;
export const mToPix = (m: number): number => (m + HALF_M) / RES_CELL_M - 0.5;

/* ------------------------------------------------------------------------ */
/* Design events                                                             */
/* ------------------------------------------------------------------------ */

export type Probability = 'high' | 'medium' | 'low';
export type ClimateScenario = 'present' | 'midRange' | 'highEnd';

export const PROBABILITIES: { id: Probability; label: string; aep: string; returnPeriod: string; stage: number }[] = [
  { id: 'high', label: 'High Probability', aep: '10% AEP', returnPeriod: '1 in 10 yr', stage: 4.8 },
  { id: 'medium', label: 'Medium Probability', aep: '1% AEP', returnPeriod: '1 in 100 yr', stage: 7.8 },
  { id: 'low', label: 'Low Probability', aep: '0.1% AEP', returnPeriod: '1 in 1,000 yr', stage: 10.8 },
];

export const CLIMATE_SCENARIOS: { id: ClimateScenario; label: string; short: string; uplift: number; note: string }[] = [
  { id: 'present', label: 'Present Day', short: 'Present', uplift: 0, note: 'Current climate and flows.' },
  {
    id: 'midRange',
    label: 'Mid-Range Future Scenario',
    short: 'Mid-Range',
    uplift: 0.9,
    note: '+20% peak flow (approx. +0.9 m design stage).',
  },
  {
    id: 'highEnd',
    label: 'High-End Future Scenario',
    short: 'High-End',
    uplift: 1.8,
    note: '+30% peak flow (approx. +1.8 m design stage).',
  },
];

export const designStage = (p: Probability, c: ClimateScenario): number =>
  PROBABILITIES.find((x) => x.id === p)!.stage + CLIMATE_SCENARIOS.find((x) => x.id === c)!.uplift;

/* ------------------------------------------------------------------------ */
/* Fine elevation                                                            */
/* ------------------------------------------------------------------------ */

export interface FineTerrain {
  base: Float32Array;
  relief: Float32Array;
  riverDist: Float32Array;
}

function bilinear(field: Float32Array, gx: number, gz: number): number {
  const x = clamp(gx, 0, GRID - 1);
  const z = clamp(gz, 0, GRID - 1);
  const i0 = Math.min(GRID - 2, Math.floor(x));
  const j0 = Math.min(GRID - 2, Math.floor(z));
  const fx = x - i0;
  const fz = z - j0;
  const a = field[j0 * GRID + i0];
  const b = field[j0 * GRID + i0 + 1];
  const c = field[(j0 + 1) * GRID + i0];
  const d = field[(j0 + 1) * GRID + i0 + 1];
  return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
}

export function buildFineTerrain(dem: DEM): FineTerrain {
  const n = RES * RES;
  const base = new Float32Array(n);
  const relief = new Float32Array(n);
  const riverDist = new Float32Array(n);
  for (let r = 0; r < RES; r++) {
    const zm = pixToM(r);
    const gz = ((zm + HALF_M) / EXTENT_M) * (GRID - 1);
    const cx = riverCenterline(zm);
    for (let c = 0; c < RES; c++) {
      const xm = pixToM(c);
      const gx = ((xm + HALF_M) / EXTENT_M) * (GRID - 1);
      const k = r * RES + c;
      base[k] = bilinear(dem.base, gx, gz);
      relief[k] = bilinear(dem.relief, gx, gz);
      riverDist[k] = Math.abs(xm - cx);
    }
  }
  return { base, relief, riverDist };
}

export function fineElevation(dem: DEM, fine: FineTerrain, slopeDeg: number): Float32Array {
  const R = reliefScale(dem, slopeDeg);
  const out = new Float32Array(RES * RES);
  for (let k = 0; k < out.length; k++) out[k] = fine.base[k] + R * fine.relief[k];
  return out;
}

/* ------------------------------------------------------------------------ */
/* Connected inundation                                                      */
/* ------------------------------------------------------------------------ */

/** Depth raster (m, 0 = dry) for a water surface connected to the channel. */
export function floodDepth(elev: Float32Array, riverDist: Float32Array, stage: number): Float32Array {
  const n = RES * RES;
  const depth = new Float32Array(n);
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let k = 0; k < n; k++) {
    if (riverDist[k] < 30 && elev[k] < stage) {
      seen[k] = 1;
      queue[tail++] = k;
    }
  }
  while (head < tail) {
    const k = queue[head++];
    depth[k] = stage - elev[k];
    const r = (k / RES) | 0;
    const c = k - r * RES;
    if (c > 0) visit(k - 1);
    if (c < RES - 1) visit(k + 1);
    if (r > 0) visit(k - RES);
    if (r < RES - 1) visit(k + RES);
  }
  function visit(j: number) {
    if (!seen[j] && elev[j] < stage) {
      seen[j] = 1;
      queue[tail++] = j;
    }
  }
  return depth;
}

export type DepthKey = `${Probability}:${ClimateScenario}`;
export type DepthSet = Record<DepthKey, Float32Array>;

export function computeDepthSet(elev: Float32Array, riverDist: Float32Array): DepthSet {
  const set = {} as DepthSet;
  for (const p of PROBABILITIES)
    for (const c of CLIMATE_SCENARIOS) set[`${p.id}:${c.id}`] = floodDepth(elev, riverDist, designStage(p.id, c.id));
  return set;
}

export function sampleRaster(raster: Float32Array, xm: number, zm: number): number {
  const c = Math.round(mToPix(xm));
  const r = Math.round(mToPix(zm));
  if (c < 0 || r < 0 || c >= RES || r >= RES) return 0;
  return raster[r * RES + c];
}

/* ------------------------------------------------------------------------ */
/* Synthetic exposure & reference data                                       */
/* ------------------------------------------------------------------------ */

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export interface Building {
  id: number;
  x: number;
  z: number;
  w: number;
  h: number;
  angle: number;
  use: 'Residential' | 'Commercial' | 'Agricultural' | 'Community';
}

export const TOWN = { name: 'Valley Town', z: 900 };

export function generateBuildings(): Building[] {
  const rand = rng(424242);
  const out: Building[] = [];
  const riverAngle = (z: number) => Math.atan2(riverCenterline(z + 10) - riverCenterline(z - 10), 20);
  let id = 1;
  // town core: gaussian cluster around the bridge
  while (out.length < 210) {
    const z = TOWN.z + (rand() + rand() + rand() - 1.5) * 1500;
    const side = rand() < 0.55 ? 1 : -1;
    const d = 110 + Math.pow(rand(), 1.4) * 820;
    const x = riverCenterline(z) + side * d;
    if (Math.abs(x) > HALF_M - 60 || Math.abs(z) > HALF_M - 60) continue;
    const big = rand() < 0.1;
    out.push({
      id: id++,
      x,
      z,
      w: big ? 30 + rand() * 25 : 11 + rand() * 9,
      h: big ? 18 + rand() * 14 : 8 + rand() * 6,
      angle: riverAngle(z) + (rand() - 0.5) * 0.25,
      use: big ? (rand() < 0.7 ? 'Commercial' : 'Community') : 'Residential',
    });
  }
  // dispersed farmsteads along the valley
  for (let n = 0; n < 46; n++) {
    const z = (rand() - 0.5) * (EXTENT_M - 400);
    const side = rand() < 0.5 ? 1 : -1;
    const x = riverCenterline(z) + side * (180 + rand() * 600);
    for (let b = 0; b < 2; b++) {
      out.push({
        id: id++,
        x: x + (rand() - 0.5) * 40,
        z: z + (rand() - 0.5) * 40,
        w: 14 + rand() * 16,
        h: 9 + rand() * 8,
        angle: rand() * Math.PI,
        use: b === 0 ? 'Residential' : 'Agricultural',
      });
    }
  }
  return out;
}

export const PERSONS_PER_DWELLING = 2.4;

export interface Polyline {
  id: string;
  name: string;
  pts: [number, number][];
  kind: 'primary' | 'secondary';
}

export function generateRoads(): Polyline[] {
  const valleyRoad = (offset: number): [number, number][] => {
    const pts: [number, number][] = [];
    for (let z = -HALF_M; z <= HALF_M; z += 100) pts.push([riverCenterline(z) + offset, z]);
    return pts;
  };
  const bz = TOWN.z;
  return [
    { id: 'n1', name: 'N-Valley Road (east bank)', kind: 'primary', pts: valleyRoad(420) },
    { id: 'r1', name: 'Regional Road (west bank)', kind: 'secondary', pts: valleyRoad(-480) },
    {
      id: 'bridge',
      name: 'Town Bridge',
      kind: 'secondary',
      pts: [
        [riverCenterline(bz) - 480, bz],
        [riverCenterline(bz) + 420, bz],
      ],
    },
  ];
}

export function riverLine(): [number, number][] {
  const pts: [number, number][] = [];
  for (let z = -HALF_M; z <= HALF_M; z += 50) pts.push([riverCenterline(z), z]);
  return pts;
}

export interface Gauge {
  id: string;
  name: string;
  x: number;
  z: number;
  /** Local stage offset relative to the reach reference stage. */
  offset: number;
}

export const GAUGES: Gauge[] = [
  { id: 'G01', name: 'Upper Valley', x: riverCenterline(-3100), z: -3100, offset: 0.4 },
  { id: 'G02', name: 'Town Bridge', x: riverCenterline(TOWN.z), z: TOWN.z, offset: 0 },
  { id: 'G03', name: 'Lower Gorge', x: riverCenterline(3200), z: 3200, offset: -0.3 },
];

export interface PastEvent {
  id: string;
  x: number;
  z: number;
  type: 'single' | 'recurring';
  date: string;
  occurrences: number;
  source: string;
  description: string;
}

export const PAST_EVENTS: PastEvent[] = [
  { z: 820, off: 260, type: 'recurring', date: '2009-11-19', occurrences: 6, source: 'River', description: 'Main Street and bridge approach flooded; recurring at high stage.' },
  { z: 1350, off: -300, type: 'recurring', date: '2015-12-05', occurrences: 4, source: 'River', description: 'West bank housing estate; gardens and ground floors affected.' },
  { z: 400, off: 180, type: 'single', date: '2015-12-06', occurrences: 1, source: 'River', description: 'Riverside car park inundated to ~0.6 m.' },
  { z: -1800, off: -220, type: 'single', date: '2002-02-01', occurrences: 1, source: 'River', description: 'Agricultural land flooded for 4 days.' },
  { z: -2900, off: 160, type: 'recurring', date: '2017-10-16', occurrences: 3, source: 'Pluvial', description: 'Road ponding at culvert under N-Valley Road.' },
  { z: 2300, off: 350, type: 'single', date: '2020-02-23', occurrences: 1, source: 'River', description: 'Farmyard and access lane flooded.' },
  { z: 2950, off: -260, type: 'recurring', date: '2023-11-01', occurrences: 5, source: 'River', description: 'Regional road closed at low-lying section.' },
  { z: 1700, off: 520, type: 'single', date: '2019-08-12', occurrences: 1, source: 'Landslide/debris', description: 'Debris flow from tributary gully blocked culvert.' },
].map((e, n) => ({
  id: `PFE-${String(n + 1).padStart(3, '0')}`,
  x: riverCenterline(e.z) + e.off,
  z: e.z,
  type: e.type as PastEvent['type'],
  date: e.date,
  occurrences: e.occurrences,
  source: e.source,
  description: e.description,
}));

/* ------------------------------------------------------------------------ */
/* Exposure statistics                                                       */
/* ------------------------------------------------------------------------ */

export interface ExposureRow {
  probability: Probability;
  scenario: ClimateScenario;
  areaKm2: number;
  buildings: number;
  persons: number;
}

export function exposureTable(depths: DepthSet, buildings: Building[]): ExposureRow[] {
  const rows: ExposureRow[] = [];
  for (const c of CLIMATE_SCENARIOS) {
    for (const p of PROBABILITIES) {
      const d = depths[`${p.id}:${c.id}`];
      let cells = 0;
      for (let k = 0; k < d.length; k++) if (d[k] > 0) cells++;
      let b = 0;
      let persons = 0;
      for (const bl of buildings) {
        if (sampleRaster(d, bl.x, bl.z) > 0.05) {
          b++;
          if (bl.use === 'Residential') persons += PERSONS_PER_DWELLING;
        }
      }
      rows.push({ probability: p.id, scenario: c.id, areaKm2: cells * RES_CELL_KM2, buildings: b, persons: Math.round(persons) });
    }
  }
  return rows;
}

/** Most frequent (highest probability) event that floods a building. */
export function buildingFloodClass(depths: DepthSet, b: Building, scenario: ClimateScenario): Probability | null {
  for (const p of PROBABILITIES) if (sampleRaster(depths[`${p.id}:${scenario}`], b.x, b.z) > 0.05) return p.id;
  return null;
}

export const distance = (ax: number, az: number, bx: number, bz: number) => Math.hypot(ax - bx, az - bz);
