/**
 * terrainMath.ts
 * ---------------------------------------------------------------------------
 * Deterministic geospatial core for the Hydro-Slope Simulator.
 *
 *  - Procedural DEM generation (meandering river valley, floodplain, terraced
 *    hillslopes, ridge lines, tributary gullies).
 *  - Slope-gradient transfer function (regional hillslope angle -> relief).
 *  - Per-vertex slope angle computation (central differences, metres).
 *  - Composite instability & flood risk model with the compound
 *    rainfall/slope critical trigger.
 *  - Colour mapping (risk choropleth + hypsometric elevation tint).
 *
 * The module is framework-agnostic and allocation-free in its hot path so it
 * can run every animation frame and inside React memo hooks alike.
 */

/* ------------------------------------------------------------------------ */
/* Spatial reference                                                         */
/* ------------------------------------------------------------------------ */

/** Vertices per side of the DEM grid (GRID x GRID vertices). */
export const GRID = 160;
export const VERTEX_COUNT = GRID * GRID;
/** Ground extent of the DEM tile, metres (square). */
export const EXTENT_M = 8000;
/** Ground sampling distance between adjacent vertices, metres. */
export const CELL_M = EXTENT_M / (GRID - 1);
/** Ground area represented by one vertex, km². */
export const CELL_AREA_KM2 = (CELL_M * CELL_M) / 1e6;
/** Width of the tile in Three.js world units. */
export const WORLD_SIZE = 160;
/** Metres represented by one world unit (horizontal and vertical, VE = 1). */
export const METERS_PER_UNIT = EXTENT_M / WORLD_SIZE;
/** Vertical exaggeration applied to the rendered surface. */
export const VERTICAL_EXAGGERATION = 1;
/** Gauge datum (river-stage 0 m) expressed as metres above sea level. */
export const DATUM_ASL_M = 640;
/** Half-width of the incised low-flow channel, metres. */
export const CHANNEL_HALF_WIDTH_M = 70;

/** South-west corner of the (illustrative) georeferenced tile, WGS84. */
export const GEO_ORIGIN = { lat: 27.92, lon: 85.52 } as const;
const CENTER_LAT_RAD = ((GEO_ORIGIN.lat + EXTENT_M / 111_320 / 2) * Math.PI) / 180;
export const SPAN_LAT_DEG = EXTENT_M / 111_320;
export const SPAN_LON_DEG = EXTENT_M / (111_320 * Math.cos(CENTER_LAT_RAD));

/* ------------------------------------------------------------------------ */
/* Model thresholds and parameter domain                                     */
/* ------------------------------------------------------------------------ */

export const THRESHOLDS = {
  /** Critical rainfall intensity, mm/hr. */
  rainfall: 145,
  /** Critical regional slope gradient, degrees. */
  slope: 30,
  /** Flood stage, metres above gauge datum. */
  floodStage: 10,
  /** Risk class boundaries (fractions). */
  warning: 0.5,
  critical: 0.75,
} as const;

export const LIMITS = {
  rainfall: { min: 0, max: 250, step: 1 },
  slope: { min: 0, max: 60, step: 0.5 },
  riverLevel: { min: 0, max: 15, step: 0.1 },
} as const;

export interface SimParams {
  /** Rainfall intensity, mm/hr. */
  rainfall: number;
  /** Regional slope gradient, degrees. */
  slope: number;
  /** River stage above gauge datum, metres. */
  riverLevel: number;
}

export type RiskBand = 'safe' | 'warning' | 'critical';
export type ThemeMode = 'light' | 'dark';
export type LayerMode = 'risk' | 'elevation';

/* ------------------------------------------------------------------------ */
/* Scalar helpers                                                            */
/* ------------------------------------------------------------------------ */

export const clamp = (v: number, lo = 0, hi = 1): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

/* ------------------------------------------------------------------------ */
/* Deterministic value noise                                                 */
/* ------------------------------------------------------------------------ */

function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy) * 2 - 1;
}

function fbm(x: number, y: number, seed: number, octaves = 5): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * freq, y * freq, seed + o * 17);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

function ridgedNoise(x: number, y: number, seed: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let weight = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    let n = 1 - Math.abs(valueNoise(x * freq, y * freq, seed + o * 31));
    n *= n;
    n *= weight;
    weight = clamp(n * 1.6);
    sum += n * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.1;
  }
  return sum / norm;
}

/* ------------------------------------------------------------------------ */
/* DEM                                                                       */
/* ------------------------------------------------------------------------ */

export interface DEM {
  /** Valley floor component (channel + floodplain), metres above datum. */
  base: Float32Array;
  /** Normalised hillslope relief component, multiplied by reliefScale(). */
  relief: Float32Array;
  /** Gradients (dz/dx, dz/dz) of base and relief, per metre. */
  baseGx: Float32Array;
  baseGz: Float32Array;
  reliefGx: Float32Array;
  reliefGz: Float32Array;
  /** Horizontal distance to the river centreline, metres. */
  riverDist: Float32Array;
  /** 1 where the vertex belongs to a valley wall (used for calibration). */
  hillside: Uint8Array;
  /** Calibration table: relief scale (m) for slope = 0..60° in 1° steps. */
  reliefTable: Float32Array;
}

/** River centreline x-offset (metres) as a function of along-valley position. */
export function riverCenterline(zm: number): number {
  const v = zm / (EXTENT_M / 2);
  return (EXTENT_M / 2) * (0.1 * Math.sin(v * 2.3 + 0.4) + 0.04 * Math.sin(v * 5.7 + 1.3));
}

/** Grid index -> horizontal metres from tile centre (x east, z south). */
export const gridToMeters = (k: number): number => (k / (GRID - 1) - 0.5) * EXTENT_M;

function gradient(field: Float32Array, gx: Float32Array, gz: Float32Array): void {
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const idx = j * GRID + i;
      const i0 = i > 0 ? i - 1 : i;
      const i1 = i < GRID - 1 ? i + 1 : i;
      const j0 = j > 0 ? j - 1 : j;
      const j1 = j < GRID - 1 ? j + 1 : j;
      gx[idx] = (field[j * GRID + i1] - field[j * GRID + i0]) / ((i1 - i0) * CELL_M);
      gz[idx] = (field[j1 * GRID + i] - field[j0 * GRID + i]) / ((j1 - j0) * CELL_M);
    }
  }
}

/** Generate the procedural mountainous river-valley DEM. Deterministic. */
export function generateDEM(): DEM {
  const base = new Float32Array(VERTEX_COUNT);
  const relief = new Float32Array(VERTEX_COUNT);
  const riverDist = new Float32Array(VERTEX_COUNT);
  const hillside = new Uint8Array(VERTEX_COUNT);

  const VALLEY_FLOOR_M = 650; // floodplain half-width
  const WALL_RUN_M = 1900; // toe-to-crest horizontal run of the valley walls
  const TERRACES = 7;

  for (let j = 0; j < GRID; j++) {
    const zm = gridToMeters(j);
    const cx = riverCenterline(zm);
    for (let i = 0; i < GRID; i++) {
      const idx = j * GRID + i;
      const xm = gridToMeters(i);
      const d = Math.abs(xm - cx);
      riverDist[idx] = d;

      // --- Valley floor: incised channel + gently rising floodplain -------
      const n1 = fbm(xm / 900, zm / 900, 11);
      const channel = -2 + 5 * smoothstep(20, CHANNEL_HALF_WIDTH_M, d);
      const plainT = clamp((d - CHANNEL_HALF_WIDTH_M) / (VALLEY_FLOOR_M - CHANNEL_HALF_WIDTH_M));
      const plain = 15 * Math.pow(plainT, 1.15);
      const floorNoise = 1.6 * n1 * smoothstep(CHANNEL_HALF_WIDTH_M, 160, d);
      base[idx] = channel + plain + floorNoise;

      // --- Valley walls: terraced hillslopes, ridges and gullies ----------
      const tRaw = (d - VALLEY_FLOOR_M + 40 * n1) / WALL_RUN_M;
      const t = clamp(tRaw, 0, 1);
      // concave toe / convex crest profile
      let s = 0.45 * t + 0.55 * t * t * (3 - 2 * t);
      // agricultural / structural terraces on lower and mid slopes
      const sf = s * TERRACES;
      const terraced = (Math.floor(sf) + smoothstep(0.3, 0.7, sf - Math.floor(sf))) / TERRACES;
      s = lerp(s, terraced, 0.45 * (1 - smoothstep(0.75, 1, t)));
      // ridge lines on the upper slopes and interfluves
      const ridge = ridgedNoise(xm / 1500, zm / 1500, 23);
      const ridgeTerm = 0.42 * ridge * smoothstep(0.25, 1.1, tRaw);
      // tributary gullies cutting perpendicular to the main channel
      const n2 = fbm(xm / 1200, zm / 1200, 37, 3);
      const gully = Math.pow(1 - Math.abs(Math.sin(zm / 560 + 2.2 * n2)), 5);
      const gullyTerm = 0.16 * gully * smoothstep(0.05, 0.6, tRaw);
      // fine roughness
      const detail = 0.05 * fbm(xm / 260, zm / 260, 53, 4) * smoothstep(0, 0.3, tRaw);
      relief[idx] = Math.max(0, s + ridgeTerm - gullyTerm + detail);

      hillside[idx] = tRaw > 0.06 && tRaw < 0.94 ? 1 : 0;
    }
  }

  const baseGx = new Float32Array(VERTEX_COUNT);
  const baseGz = new Float32Array(VERTEX_COUNT);
  const reliefGx = new Float32Array(VERTEX_COUNT);
  const reliefGz = new Float32Array(VERTEX_COUNT);
  gradient(base, baseGx, baseGz);
  gradient(relief, reliefGx, reliefGz);

  const dem: DEM = {
    base,
    relief,
    baseGx,
    baseGz,
    reliefGx,
    reliefGz,
    riverDist,
    hillside,
    reliefTable: new Float32Array(61),
  };
  calibrateReliefTable(dem);
  return dem;
}

function meanHillslopeDeg(dem: DEM, R: number): number {
  let sum = 0;
  let n = 0;
  for (let k = 0; k < VERTEX_COUNT; k++) {
    if (!dem.hillside[k]) continue;
    const gx = dem.baseGx[k] + R * dem.reliefGx[k];
    const gz = dem.baseGz[k] + R * dem.reliefGz[k];
    sum += Math.atan(Math.sqrt(gx * gx + gz * gz));
    n++;
  }
  return n ? (sum / n) * RAD2DEG : 0;
}

/**
 * Steepness transfer function calibration. For each integer slope gradient
 * 0..60° we solve (bisection) for the relief amplitude R (metres) such that
 * the mean valley-wall slope of the resulting surface equals that angle.
 */
function calibrateReliefTable(dem: DEM): void {
  const table = dem.reliefTable;
  table[0] = 0;
  let lo = 0;
  for (let deg = 1; deg <= 60; deg++) {
    let a = lo;
    let b = 20000;
    for (let it = 0; it < 26; it++) {
      const m = (a + b) / 2;
      if (meanHillslopeDeg(dem, m) < deg) a = m;
      else b = m;
    }
    table[deg] = (a + b) / 2;
    lo = table[deg];
  }
}

/** Relief amplitude (metres) that realises the requested regional slope. */
export function reliefScale(dem: DEM, slopeDeg: number): number {
  const s = clamp(slopeDeg, 0, 60);
  const k = Math.min(59, Math.floor(s));
  return lerp(dem.reliefTable[k], dem.reliefTable[k + 1], s - k);
}

/* ------------------------------------------------------------------------ */
/* Risk model                                                                */
/* ------------------------------------------------------------------------ */

export interface RiskContext {
  /** Pore-pressure saturation proxy, 0..1. */
  saturation: number;
  /** River stage / flood stage. */
  stageRatio: number;
  /** Gate for bank undercutting & inundation, 0..1. */
  floodGate: number;
  /** Over-flood-stage depth weight, 0..1. */
  overtop: number;
  /** True when rainfall > 145 mm/hr AND slope > 30°. */
  compound: boolean;
  /** Compound shear multiplier gain (applied scaled by local steepness). */
  compoundGain: number;
}

export function riskContext(p: SimParams): RiskContext {
  const saturation = 1 - Math.exp(-p.rainfall / 120);
  const stageRatio = p.riverLevel / THRESHOLDS.floodStage;
  const compound = p.rainfall > THRESHOLDS.rainfall && p.slope > THRESHOLDS.slope;
  let compoundGain = 0;
  if (compound) {
    const eI = clamp((p.rainfall - THRESHOLDS.rainfall) / (LIMITS.rainfall.max - THRESHOLDS.rainfall));
    const eS = clamp((p.slope - THRESHOLDS.slope) / (LIMITS.slope.max - THRESHOLDS.slope));
    compoundGain = 0.62 + 0.45 * Math.sqrt(eI * eS) + 0.25 * (eI + eS);
  }
  return {
    saturation,
    stageRatio,
    floodGate: smoothstep(0.45, 1.25, stageRatio),
    overtop: clamp((p.riverLevel - 8) / 5),
    compound,
    compoundGain,
  };
}

/**
 * Composite instability & flood risk for a single cell.
 *
 * @param slopeDeg   local surface slope, degrees
 * @param hAboveWater elevation above the current water surface, metres
 * @param distToRiver horizontal distance to channel centreline, metres
 */
export function vertexRisk(
  slopeDeg: number,
  hAboveWater: number,
  distToRiver: number,
  ctx: RiskContext,
): number {
  // 1. Shear susceptibility of the face (infinite-slope analogue).
  const steep = smoothstep(4, 50, slopeDeg);
  let slide = Math.pow(steep, 1.3) * (0.2 + 0.46 * ctx.saturation);

  // 2. Basal undercutting of riverbank toes as the stage rises.
  const bankProximity = hAboveWater > 0 ? Math.exp(-hAboveWater / 22) : 1;
  slide += 0.2 * bankProximity * steep * smoothstep(0.3, 1.4, ctx.stageRatio);

  // 3. Compound saturation & shear-stress trigger (non-linear).
  if (ctx.compound) slide *= 1 + ctx.compoundGain * Math.pow(steep, 0.8);

  // 4. Fluvial inundation hazard (floodplain beyond the low-flow channel).
  let flood = 0;
  if (ctx.floodGate > 0) {
    const inChannel = distToRiver < CHANNEL_HALF_WIDTH_M ? 0.55 : 1;
    const proximity = hAboveWater <= 0 ? 1 : Math.exp(-hAboveWater / 2.5);
    const depth = hAboveWater < 0 ? clamp(-hAboveWater / 4) : 0;
    flood =
      inChannel *
      ctx.floodGate *
      proximity *
      (0.4 + 0.2 * ctx.saturation + 0.4 * depth * ctx.overtop);
  }

  // Union of independent hazards.
  return clamp(1 - (1 - clamp(slide)) * (1 - clamp(flood)));
}

export function riskBand(r: number): RiskBand {
  if (r >= THRESHOLDS.critical) return 'critical';
  if (r >= THRESHOLDS.warning) return 'warning';
  return 'safe';
}

/* ------------------------------------------------------------------------ */
/* Field evaluation                                                          */
/* ------------------------------------------------------------------------ */

export interface FieldBuffers {
  /** Metres above gauge datum. */
  elevation: Float32Array;
  /** Degrees. */
  slope: Float32Array;
  /** 0..1. */
  risk: Float32Array;
}

export interface FieldStats {
  peakRisk: number;
  meanRisk: number;
  criticalAreaKm2: number;
  elevatedAreaKm2: number;
  inundatedAreaKm2: number;
  minElevation: number;
  maxElevation: number;
  meanHillslope: number;
  reliefScale: number;
  compound: boolean;
  band: RiskBand;
}

export function createFieldBuffers(): FieldBuffers {
  return {
    elevation: new Float32Array(VERTEX_COUNT),
    slope: new Float32Array(VERTEX_COUNT),
    risk: new Float32Array(VERTEX_COUNT),
  };
}

/** Evaluate elevation, slope and risk for every DEM vertex. */
export function computeField(dem: DEM, p: SimParams, buf: FieldBuffers): FieldStats {
  const R = reliefScale(dem, p.slope);
  const ctx = riskContext(p);
  const { elevation, slope, risk } = buf;

  let peak = 0;
  let sumRisk = 0;
  let crit = 0;
  let elevated = 0;
  let inundated = 0;
  let minE = Infinity;
  let maxE = -Infinity;
  let hillSum = 0;
  let hillN = 0;

  for (let k = 0; k < VERTEX_COUNT; k++) {
    const e = dem.base[k] + R * dem.relief[k];
    const gx = dem.baseGx[k] + R * dem.reliefGx[k];
    const gz = dem.baseGz[k] + R * dem.reliefGz[k];
    const s = Math.atan(Math.sqrt(gx * gx + gz * gz)) * RAD2DEG;
    const h = e - p.riverLevel;
    const r = vertexRisk(s, h, dem.riverDist[k], ctx);

    elevation[k] = e;
    slope[k] = s;
    risk[k] = r;

    if (r > peak) peak = r;
    sumRisk += r;
    if (r >= THRESHOLDS.critical) crit++;
    else if (r >= THRESHOLDS.warning) elevated++;
    if (h < 0 && dem.riverDist[k] > CHANNEL_HALF_WIDTH_M) inundated++;
    if (e < minE) minE = e;
    if (e > maxE) maxE = e;
    if (dem.hillside[k]) {
      hillSum += s;
      hillN++;
    }
  }

  return {
    peakRisk: peak,
    meanRisk: sumRisk / VERTEX_COUNT,
    criticalAreaKm2: crit * CELL_AREA_KM2,
    elevatedAreaKm2: elevated * CELL_AREA_KM2,
    inundatedAreaKm2: inundated * CELL_AREA_KM2,
    minElevation: minE,
    maxElevation: maxE,
    meanHillslope: hillN ? hillSum / hillN : 0,
    reliefScale: R,
    compound: ctx.compound,
    band: riskBand(peak),
  };
}

/* ------------------------------------------------------------------------ */
/* Colour mapping (sRGB, 0..1)                                               */
/* ------------------------------------------------------------------------ */

type RGB = readonly [number, number, number];
const hex = (h: number): RGB => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

export const RISK_PALETTE: Record<ThemeMode, { safe: RGB; warning: RGB; critical: RGB }> = {
  light: { safe: hex(0x16a34a), warning: hex(0xeab308), critical: hex(0xdc2626) },
  dark: { safe: hex(0x22c55e), warning: hex(0xeab308), critical: hex(0xef4444) },
};

/** Hypsometric tint stops: [metres ASL, colour]. */
export const HYPSOMETRIC_STOPS: ReadonlyArray<readonly [number, RGB]> = [
  [630, hex(0x3f6e4a)],
  [700, hex(0x5b8a52)],
  [950, hex(0x8fae67)],
  [1300, hex(0xc9c48a)],
  [1800, hex(0xb89a6a)],
  [2500, hex(0x8f7660)],
  [3300, hex(0xa8a29e)],
  [4300, hex(0xf1f0ee)],
];

const BAND_EDGE = 0.012;

/**
 * Risk choropleth colour. Banded at the 50% / 75% thresholds (with a narrow
 * anti-aliasing ramp) and modulated by elevation so relief stays legible.
 */
export function riskColor(
  r: number,
  elevNorm: number,
  slopeDeg: number,
  theme: ThemeMode,
  out: Float32Array,
  o: number,
): void {
  const pal = RISK_PALETTE[theme];
  const a = smoothstep(THRESHOLDS.warning - BAND_EDGE, THRESHOLDS.warning + BAND_EDGE, r);
  const b = smoothstep(THRESHOLDS.critical - BAND_EDGE, THRESHOLDS.critical + BAND_EDGE, r);
  const safeShade = (theme === 'dark' ? 0.62 : 0.74) + 0.42 * elevNorm;
  const warnShade = 0.86 + 0.18 * elevNorm;
  const steepGlow = 0.22 * smoothstep(28, 55, slopeDeg);
  for (let c = 0; c < 3; c++) {
    const safe = pal.safe[c] * safeShade;
    const warn = pal.warning[c] * warnShade;
    const crit = lerp(pal.critical[c], 1, steepGlow * (c === 0 ? 0.35 : 0.6));
    out[o + c] = clamp(lerp(lerp(safe, warn, a), crit, b));
  }
}

/** Hypsometric (topographic elevation) tint. */
export function elevationColor(elevAsl: number, theme: ThemeMode, out: Float32Array, o: number): void {
  const stops = HYPSOMETRIC_STOPS;
  let c0 = stops[0][1];
  let c1 = c0;
  let t = 0;
  if (elevAsl >= stops[stops.length - 1][0]) {
    c0 = c1 = stops[stops.length - 1][1];
  } else {
    for (let s = 0; s < stops.length - 1; s++) {
      if (elevAsl < stops[s + 1][0]) {
        c0 = stops[s][1];
        c1 = stops[s + 1][1];
        t = clamp((elevAsl - stops[s][0]) / (stops[s + 1][0] - stops[s][0]));
        break;
      }
    }
  }
  const k = theme === 'dark' ? 0.86 : 1;
  out[o] = lerp(c0[0], c1[0], t) * k;
  out[o + 1] = lerp(c0[1], c1[1], t) * k;
  out[o + 2] = lerp(c0[2], c1[2], t) * k;
}

/* ------------------------------------------------------------------------ */
/* Georeferencing                                                            */
/* ------------------------------------------------------------------------ */

/** World-space (x east, z south) -> WGS84 lat/lon of the illustrative tile. */
export function worldToLatLon(x: number, z: number): { lat: number; lon: number } {
  const u = x / WORLD_SIZE + 0.5; // 0 west .. 1 east
  const v = 0.5 - z / WORLD_SIZE; // 0 south .. 1 north
  return { lat: GEO_ORIGIN.lat + v * SPAN_LAT_DEG, lon: GEO_ORIGIN.lon + u * SPAN_LON_DEG };
}

/** Nearest DEM vertex index for a world-space position. */
export function worldToIndex(x: number, z: number): number {
  const i = Math.round((x / WORLD_SIZE + 0.5) * (GRID - 1));
  const j = Math.round((z / WORLD_SIZE + 0.5) * (GRID - 1));
  return clamp(j, 0, GRID - 1) * GRID + clamp(i, 0, GRID - 1);
}

export const degToRad = (d: number): number => d * DEG2RAD;
