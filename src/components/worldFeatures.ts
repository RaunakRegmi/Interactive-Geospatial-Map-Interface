/**
 * worldFeatures.ts
 * ---------------------------------------------------------------------------
 * Cultural & natural features draped on the 3D terrain: the road network and
 * town bridge, building footprints (extruded with roofs) and forest.
 *
 * The data are the same synthetic roads/buildings drawn on the 2D flood map,
 * so both views agree. Feature footprints are exaggerated (cartographic
 * generalisation) so they stay legible at the overview zoom.
 *
 * Heights follow the live DEM: call update() whenever the relief changes.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  DATUM_ASL_M,
  EXTENT_M,
  GRID,
  METERS_PER_UNIT,
  TREELINE_ASL_M,
  VERTICAL_EXAGGERATION,
  clamp,
  forestDensity,
  riverCenterline,
  smoothstep,
  wallPosition,
  type ThemeMode,
} from '../engine/terrainMath';
import { TOWN, type Building, type Polyline } from '../engine/floodModel';

const HALF_M = EXTENT_M / 2;
/** metres -> world units (horizontal / vertical). */
const XU = 1 / METERS_PER_UNIT;
const YU = VERTICAL_EXAGGERATION / METERS_PER_UNIT;

/** Footprint / height exaggeration for buildings and trees. */
const BUILDING_SCALE = 1.6;
const ROAD_WIDTH_M = { primary: 22, secondary: 16 } as const;
const SHOULDER_M = 6;
/** Bridge deck level, metres above gauge datum (overtopped by extreme stages). */
const BRIDGE_DECK_M = 13;
const BRIDGE_SPAN_M = 170;
const BRIDGE_RAMP_M = 330;
const BRIDGE_SLAB_M = 2.2;
const PARAPET_M = 1.4;

type Sampler = (xm: number, zm: number) => number;

/** Height (m above datum) on the rendered terrain surface (matches its triangulation). */
function makeSampler(elev: Float32Array): Sampler {
  return (xm, zm) => {
    const gx = clamp(((xm + HALF_M) / EXTENT_M) * (GRID - 1), 0, GRID - 1);
    const gz = clamp(((zm + HALF_M) / EXTENT_M) * (GRID - 1), 0, GRID - 1);
    const i = Math.min(GRID - 2, Math.floor(gx));
    const j = Math.min(GRID - 2, Math.floor(gz));
    const fx = gx - i;
    const fz = gz - j;
    const a = elev[j * GRID + i];
    const b = elev[j * GRID + i + 1];
    const c = elev[(j + 1) * GRID + i];
    const d = elev[(j + 1) * GRID + i + 1];
    return fx + fz <= 1 ? a + (b - a) * fx + (c - a) * fz : d + (c - d) * (1 - fx) + (b - d) * (1 - fz);
  };
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/* ------------------------------------------------------------------------ */
/* Simple quad-soup builder with stable topology                             */
/* ------------------------------------------------------------------------ */

class QuadSoup {
  pos: number[] = [];
  /** Four corners in metres: [x, y(above datum), z]. */
  quad(a: number[], b: number[], c: number[], d: number[]) {
    for (const p of [a, b, c, a, c, d]) this.pos.push(p[0] * XU, p[1] * YU, p[2] * XU);
  }
}

/** Creates the mesh on first call, rewrites vertex positions afterwards. */
function syncSoup(mesh: THREE.Mesh | null, soup: QuadSoup, mat: THREE.Material, group: THREE.Group): THREE.Mesh {
  if (!mesh) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(soup.pos), 3));
    geo.computeVertexNormals();
    mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  }
  const attr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (attr.array.length === soup.pos.length) {
    (attr.array as Float32Array).set(soup.pos);
    attr.needsUpdate = true;
  } else {
    mesh.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(soup.pos), 3));
  }
  mesh.geometry.computeVertexNormals();
  mesh.geometry.computeBoundingSphere();
  return mesh;
}

/* ------------------------------------------------------------------------ */
/* Roads & bridge                                                            */
/* ------------------------------------------------------------------------ */

interface RoadSample {
  x: number;
  z: number;
  nx: number;
  nz: number;
}

function resample(pts: [number, number][], step: number): RoadSample[] {
  const out: RoadSample[] = [];
  const lens = [0];
  for (let n = 1; n < pts.length; n++)
    lens.push(lens[n - 1] + Math.hypot(pts[n][0] - pts[n - 1][0], pts[n][1] - pts[n - 1][1]));
  const total = lens[lens.length - 1];
  const count = Math.max(2, Math.round(total / step) + 1);
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const s = (k / (count - 1)) * total;
    while (seg < pts.length - 2 && lens[seg + 1] < s) seg++;
    const [x0, z0] = pts[seg];
    const [x1, z1] = pts[seg + 1];
    const L = Math.max(1e-6, lens[seg + 1] - lens[seg]);
    const t = (s - lens[seg]) / L;
    const tx = (x1 - x0) / L;
    const tz = (z1 - z0) / L;
    out.push({ x: x0 + (x1 - x0) * t, z: z0 + (z1 - z0) * t, nx: -tz, nz: tx });
  }
  return out;
}

interface RoadSoups {
  shoulder: QuadSoup;
  asphalt: QuadSoup;
  marking: QuadSoup;
  concrete: QuadSoup;
}

function buildRoads(roads: Polyline[], h: Sampler): RoadSoups {
  const soups: RoadSoups = { shoulder: new QuadSoup(), asphalt: new QuadSoup(), marking: new QuadSoup(), concrete: new QuadSoup() };
  const bridgeCx = riverCenterline(TOWN.z);

  for (const road of roads) {
    const isBridge = road.id === 'bridge';
    const samples = resample(road.pts, isBridge ? 10 : 20);
    const w = ROAD_WIDTH_M[road.kind];

    // Roadway level at a sample (bridge: flat deck + approach embankments).
    const deckAt = (s: RoadSample): number | null => {
      if (!isBridge) return null;
      const dx = Math.abs(s.x - bridgeCx);
      const ground = h(s.x, s.z);
      return Math.max(ground + 0.8, BRIDGE_DECK_M - (BRIDGE_DECK_M - ground) * smoothstep(BRIDGE_SPAN_M, BRIDGE_RAMP_M, dx));
    };
    const edge = (s: RoadSample, off: number, lift: number): number[] => {
      const x = s.x + s.nx * off;
      const z = s.z + s.nz * off;
      const deck = deckAt(s);
      return [x, deck !== null ? Math.max(deck, h(x, z) + 0.8) + (lift - 0.9) : h(x, z) + lift, z];
    };

    for (let k = 0; k < samples.length - 1; k++) {
      const s0 = samples[k];
      const s1 = samples[k + 1];
      const hw = w / 2;
      const sw = hw + SHOULDER_M;
      if (!isBridge) soups.shoulder.quad(edge(s0, -sw, 0.5), edge(s0, sw, 0.5), edge(s1, sw, 0.5), edge(s1, -sw, 0.5));
      soups.asphalt.quad(edge(s0, -hw, 0.9), edge(s0, hw, 0.9), edge(s1, hw, 0.9), edge(s1, -hw, 0.9));
      // dashed centre line (20 m dash / 20 m gap)
      if (k % 2 === 0 || isBridge) {
        const mw = 1.1;
        soups.marking.quad(edge(s0, -mw, 1.15), edge(s0, mw, 1.15), edge(s1, mw, 1.15), edge(s1, -mw, 1.15));
      }

      // bridge structure: parapets, fascia / retaining walls, deck soffit
      if (isBridge) {
        const d0 = deckAt(s0)!;
        const d1 = deckAt(s1)!;
        const g0 = h(s0.x, s0.z);
        const g1 = h(s1.x, s1.z);
        if (Math.min(d0 - g0, d1 - g1) < 1.2) continue;
        const inSpan = Math.abs((s0.x + s1.x) / 2 - bridgeCx) < BRIDGE_SPAN_M;
        const ew = hw + 1.2;
        for (const side of [-1, 1]) {
          const x0 = s0.x + s0.nx * ew * side;
          const z0 = s0.z + s0.nz * ew * side;
          const x1 = s1.x + s1.nx * ew * side;
          const z1 = s1.z + s1.nz * ew * side;
          const b0 = inSpan ? d0 - BRIDGE_SLAB_M : h(x0, z0) - 1;
          const b1 = inSpan ? d1 - BRIDGE_SLAB_M : h(x1, z1) - 1;
          soups.concrete.quad([x0, b0, z0], [x1, b1, z1], [x1, d1 + PARAPET_M, z1], [x0, d0 + PARAPET_M, z0]);
          // parapet inner face
          const ix0 = s0.x + s0.nx * hw * side;
          const iz0 = s0.z + s0.nz * hw * side;
          const ix1 = s1.x + s1.nx * hw * side;
          const iz1 = s1.z + s1.nz * hw * side;
          soups.concrete.quad([ix0, d0, iz0], [ix1, d1, iz1], [ix1, d1 + PARAPET_M, iz1], [ix0, d0 + PARAPET_M, iz0]);
          soups.concrete.quad([ix0, d0 + PARAPET_M, iz0], [ix1, d1 + PARAPET_M, iz1], [x1, d1 + PARAPET_M, z1], [x0, d0 + PARAPET_M, z0]);
        }
        if (inSpan) {
          const a = [s0.x - s0.nx * ew, d0 - BRIDGE_SLAB_M, s0.z - s0.nz * ew];
          const b = [s0.x + s0.nx * ew, d0 - BRIDGE_SLAB_M, s0.z + s0.nz * ew];
          const c = [s1.x + s1.nx * ew, d1 - BRIDGE_SLAB_M, s1.z + s1.nz * ew];
          const d = [s1.x - s1.nx * ew, d1 - BRIDGE_SLAB_M, s1.z - s1.nz * ew];
          soups.concrete.quad(a, b, c, d);
        }
      }
    }

    // bridge piers every 50 m across the span
    if (isBridge) {
      const s = samples[0];
      for (let px = -150; px <= 150; px += 50) {
        const cx = bridgeCx + px;
        const cz = s.z;
        const deck = BRIDGE_DECK_M - BRIDGE_SLAB_M;
        const hx = 2.2;
        const hz = w / 2 - 1;
        const g = Math.min(h(cx - hx, cz), h(cx + hx, cz)) - 3;
        const c = [
          [cx - hx, cz - hz],
          [cx + hx, cz - hz],
          [cx + hx, cz + hz],
          [cx - hx, cz + hz],
        ];
        for (let n = 0; n < 4; n++) {
          const [ax, az] = c[n];
          const [bx, bz] = c[(n + 1) % 4];
          soups.concrete.quad([ax, g, az], [bx, g, bz], [bx, deck, bz], [ax, deck, az]);
        }
      }
    }
  }
  return soups;
}

/* ------------------------------------------------------------------------ */
/* Buildings                                                                 */
/* ------------------------------------------------------------------------ */

function gableRoofGeometry(): THREE.BufferGeometry {
  // ridge along local x; base 1 x 1 (with eaves overhang), height 1
  const ox = 0.54;
  const oz = 0.56;
  const v = [
    // south slope
    -ox, 0, oz, ox, 0, oz, ox, 1, 0,
    -ox, 0, oz, ox, 1, 0, -ox, 1, 0,
    // north slope
    ox, 0, -oz, -ox, 0, -oz, -ox, 1, 0,
    ox, 0, -oz, -ox, 1, 0, ox, 1, 0,
    // gables
    ox, 0, oz, ox, 0, -oz, ox, 1, 0,
    -ox, 0, -oz, -ox, 0, oz, -ox, 1, 0,
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  geo.computeVertexNormals();
  return geo;
}

const PALETTE = {
  walls: {
    Residential: [0xece4d4, 0xd9c4a0, 0xb4654a, 0xf3f0ea, 0xc99d74, 0xe2d2b6],
    Commercial: [0xd2d5d8, 0xc4c8cc, 0xe0dcd2],
    Community: [0xf1e6cf, 0xe8d9b8],
    Agricultural: [0xa47c55, 0x8f6c4c, 0xb58d63],
  },
  roofs: {
    Residential: [0x9a3a2e, 0x3e5f7d, 0x5d6e4b, 0x6f7174, 0xa65a33, 0x8b3a3a],
    Commercial: [0x8c9196, 0x7d8286],
    Community: [0xb5372b, 0x9b2f2f],
    Agricultural: [0x7c7c78, 0x8e7a52],
  },
} as const;

interface BuildingSpec {
  x: number;
  z: number;
  lx: number;
  lz: number;
  angle: number;
  wall: number;
  roof: number;
}

function buildingSpecs(buildings: Building[]): BuildingSpec[] {
  return buildings.map((b) => {
    const r = rng(b.id * 2654435761);
    let lx = b.w * BUILDING_SCALE;
    let lz = b.h * BUILDING_SCALE;
    let angle = b.angle;
    if (lz > lx) {
      [lx, lz] = [lz, lx];
      angle += Math.PI / 2;
    }
    const wall =
      b.use === 'Commercial' ? 11 + r() * 7 : b.use === 'Community' ? 9 + r() * 3 : b.use === 'Agricultural' ? 4 + r() * 1.5 : 6 + r() * 3.5;
    const roof = b.use === 'Commercial' ? 0.6 : b.use === 'Community' ? 6 : b.use === 'Agricultural' ? 3 : 3 + r();
    return { x: b.x, z: b.z, lx, lz, angle, wall: wall * BUILDING_SCALE, roof: roof * BUILDING_SCALE };
  });
}

/* ------------------------------------------------------------------------ */
/* Trees                                                                     */
/* ------------------------------------------------------------------------ */

interface TreeSpec {
  x: number;
  z: number;
  height: number;
  rot: number;
  treeline: number;
}

function withColor(geo: THREE.BufferGeometry, rgb: [number, number, number]): THREE.BufferGeometry {
  const n = geo.getAttribute('position').count;
  const c = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) c.set(rgb, k * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  geo.deleteAttribute('uv');
  return geo;
}

const TRUNK: [number, number, number] = [4.0, 1.4, 1.2]; // multiplied by the green instance colour -> brown

function coniferGeometry(): THREE.BufferGeometry {
  const parts = [
    withColor(new THREE.CylinderGeometry(0.035, 0.05, 0.22, 5).translate(0, 0.11, 0), TRUNK),
    withColor(new THREE.ConeGeometry(0.3, 0.55, 7).translate(0, 0.42, 0), [1, 1, 1]),
    withColor(new THREE.ConeGeometry(0.22, 0.45, 7).translate(0, 0.76, 0), [1, 1, 1]),
  ];
  return mergeGeometries(parts.map((g) => g.toNonIndexed()))!;
}

function broadleafGeometry(): THREE.BufferGeometry {
  const parts = [
    withColor(new THREE.CylinderGeometry(0.045, 0.06, 0.4, 5).translate(0, 0.2, 0), TRUNK),
    withColor(new THREE.IcosahedronGeometry(0.38, 0).scale(1, 0.85, 1).translate(0, 0.66, 0), [1, 1, 1]),
  ];
  return mergeGeometries(parts.map((g) => g.toNonIndexed()))!;
}

function placeTrees(buildings: Building[]): { conifer: TreeSpec[]; broadleaf: TreeSpec[] } {
  const rand = rng(90210);
  const conifer: TreeSpec[] = [];
  const broadleaf: TreeSpec[] = [];

  // spatial hash of buildings for clearance tests
  const CELL = 100;
  const hash = new Map<string, Building[]>();
  for (const b of buildings) {
    const key = `${Math.floor(b.x / CELL)},${Math.floor(b.z / CELL)}`;
    (hash.get(key) ?? hash.set(key, []).get(key)!).push(b);
  }
  const nearBuilding = (x: number, z: number) => {
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        for (const b of hash.get(`${cx + dx},${cz + dz}`) ?? [])
          if (Math.hypot(b.x - x, b.z - z) < 18 + Math.max(b.w, b.h) * BUILDING_SCALE * 0.75) return true;
    return false;
  };

  const SPACING = 36;
  for (let zm = -HALF_M + 20; zm < HALF_M - 20; zm += SPACING) {
    const cl = riverCenterline(zm);
    for (let xm0 = -HALF_M + 20; xm0 < HALF_M - 20; xm0 += SPACING) {
      const xm = xm0 + (rand() - 0.5) * SPACING * 0.9;
      const z = zm + (rand() - 0.5) * SPACING * 0.9;
      const d = Math.abs(xm - cl);
      let p: number;
      if (d < 95) p = 0;
      else if (d < 170) p = 0.3; // riparian strip
      else if (d < 620) p = Math.abs(z - TOWN.z) < 1600 ? 0.015 : 0.035; // scattered trees among fields
      else p = 0.05 + 0.9 * forestDensity(xm, z, d);
      const r = rand();
      const r2 = rand();
      const r3 = rand();
      if (r >= p) continue;
      // keep roads and the bridge clear
      if (Math.abs(xm - (cl + 420)) < 30 || Math.abs(xm - (cl - 480)) < 26) continue;
      if (Math.abs(z - TOWN.z) < 30 && xm > riverCenterline(TOWN.z) - 500 && xm < riverCenterline(TOWN.z) + 440) continue;
      if (Math.abs(xm) > HALF_M - 15 || Math.abs(z) > HALF_M - 15) continue;
      if (nearBuilding(xm, z)) continue;
      const t = wallPosition(d) + (r2 - 0.5) * 0.3;
      const isConifer = t > 0.42;
      const spec: TreeSpec = {
        x: xm,
        z,
        height: isConifer ? 34 + r3 * 18 : 24 + r3 * 12,
        rot: r2 * Math.PI * 2,
        treeline: TREELINE_ASL_M + (r3 - 0.5) * 300,
      };
      (isConifer ? conifer : broadleaf).push(spec);
    }
  }
  return { conifer, broadleaf };
}

function treeMesh(geo: THREE.BufferGeometry, specs: TreeSpec[], greens: number[], seed: number): THREE.InstancedMesh {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true });
  const mesh = new THREE.InstancedMesh(geo, mat, specs.length);
  const r = rng(seed);
  const col = new THREE.Color();
  for (let n = 0; n < specs.length; n++) {
    col.setHex(greens[Math.floor(r() * greens.length)]).multiplyScalar(0.85 + r() * 0.3);
    mesh.setColorAt(n, col);
  }
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/* ------------------------------------------------------------------------ */
/* Public API                                                                */
/* ------------------------------------------------------------------------ */

export interface WorldFeatures {
  group: THREE.Group;
  /** Re-drape every feature on the current elevation (m above datum) and slope (deg) fields. */
  update(elevation: Float32Array, slope: Float32Array): void;
  setTheme(theme: ThemeMode): void;
}

export function createWorldFeatures(buildings: Building[], roads: Polyline[]): WorldFeatures {
  const group = new THREE.Group();
  group.name = 'world-features';

  /* materials */
  const roadMat = (color: number, offset: number) =>
    new THREE.MeshStandardMaterial({
      color,
      roughness: 0.92,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: offset,
      polygonOffsetUnits: offset,
    });
  const shoulderMat = roadMat(0x9b9180, -2);
  const asphaltMat = roadMat(0x3a3d43, -3);
  const markingMat = roadMat(0xe9d27a, -4);
  const concreteMat = new THREE.MeshStandardMaterial({ color: 0xbcb7ad, roughness: 0.85, side: THREE.DoubleSide });
  const worldMats = [shoulderMat, asphaltMat, markingMat, concreteMat];
  const baseColors = worldMats.map((m) => m.color.clone());

  let shoulder: THREE.Mesh | null = null;
  let asphalt: THREE.Mesh | null = null;
  let marking: THREE.Mesh | null = null;
  let concrete: THREE.Mesh | null = null;

  /* buildings */
  const bspecs = buildingSpecs(buildings);
  const wallGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const wallMat = new THREE.MeshStandardMaterial({ roughness: 0.88 });
  const roofMat = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.1, side: THREE.DoubleSide });
  const walls = new THREE.InstancedMesh(wallGeo, wallMat, bspecs.length);
  const roofs = new THREE.InstancedMesh(gableRoofGeometry(), roofMat, bspecs.length);
  for (const m of [walls, roofs]) {
    m.frustumCulled = false;
    m.castShadow = true;
    m.receiveShadow = true;
  }
  const col = new THREE.Color();
  buildings.forEach((b, n) => {
    const r = rng(b.id * 7919 + 13);
    const wl = PALETTE.walls[b.use];
    const rf = PALETTE.roofs[b.use];
    walls.setColorAt(n, col.setHex(wl[Math.floor(r() * wl.length)]));
    roofs.setColorAt(n, col.setHex(rf[Math.floor(r() * rf.length)]));
  });
  group.add(walls, roofs);

  /* trees */
  const trees = placeTrees(buildings);
  const conifers = treeMesh(coniferGeometry(), trees.conifer, [0x2e5233, 0x284a30, 0x37603a, 0x22402a], 7);
  const broadleaves = treeMesh(broadleafGeometry(), trees.broadleaf, [0x4f7a34, 0x5c8a3a, 0x416b2e, 0x6b8f3c, 0x3d6330], 11);
  group.add(conifers, broadleaves);
  const treeMats = [conifers.material, broadleaves.material, wallMat, roofMat] as THREE.MeshStandardMaterial[];

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();

  const placeTreesOn = (mesh: THREE.InstancedMesh, specs: TreeSpec[], h: Sampler, slope: Float32Array) => {
    const arr = mesh.instanceMatrix.array as Float32Array;
    for (let n = 0; n < specs.length; n++) {
      const t = specs[n];
      const y = h(t.x, t.z);
      const gi = Math.round(((t.x + HALF_M) / EXTENT_M) * (GRID - 1));
      const gj = Math.round(((t.z + HALF_M) / EXTENT_M) * (GRID - 1));
      const sl = slope[clamp(gj, 0, GRID - 1) * GRID + clamp(gi, 0, GRID - 1)];
      const visible = y + DATUM_ASL_M < t.treeline && sl < 50;
      const s = visible ? t.height * XU : 0;
      const c = Math.cos(t.rot) * s;
      const sn = Math.sin(t.rot) * s;
      const o = n * 16;
      arr[o] = c; arr[o + 1] = 0; arr[o + 2] = -sn; arr[o + 3] = 0;
      arr[o + 4] = 0; arr[o + 5] = visible ? t.height * YU : 0; arr[o + 6] = 0; arr[o + 7] = 0;
      arr[o + 8] = sn; arr[o + 9] = 0; arr[o + 10] = c; arr[o + 11] = 0;
      arr[o + 12] = t.x * XU; arr[o + 13] = (y - 1.5) * YU; arr[o + 14] = t.z * XU; arr[o + 15] = 1;
    }
    mesh.instanceMatrix.needsUpdate = true;
  };

  const update = (elevation: Float32Array, slope: Float32Array) => {
    const h = makeSampler(elevation);

    const soups = buildRoads(roads, h);
    shoulder = syncSoup(shoulder, soups.shoulder, shoulderMat, group);
    asphalt = syncSoup(asphalt, soups.asphalt, asphaltMat, group);
    marking = syncSoup(marking, soups.marking, markingMat, group);
    concrete = syncSoup(concrete, soups.concrete, concreteMat, group);
    concrete.castShadow = true;

    bspecs.forEach((b, n) => {
      const c = Math.cos(b.angle);
      const s = Math.sin(b.angle);
      let gMin = Infinity;
      let gMax = -Infinity;
      for (const [u, v] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5], [0, 0]]) {
        // canvas rotation (x, z) -> (x cos - z sin, x sin + z cos)
        const lx = u * b.lx;
        const lz = v * b.lz;
        const g = h(b.x + lx * c - lz * s, b.z + lx * s + lz * c);
        gMin = Math.min(gMin, g);
        gMax = Math.max(gMax, g);
      }
      // on steep ground the uphill side is dug into the slope rather than raised on a tower
      const gMid = h(b.x, b.z);
      const base = gMin - 1;
      const top = Math.max(gMid + b.wall, gMax + 0.35 * b.wall);
      q.setFromAxisAngle(up, -b.angle);
      walls.setMatrixAt(n, m4.compose(pos.set(b.x * XU, base * YU, b.z * XU), q, scl.set(b.lx * XU, (top - base) * YU, b.lz * XU)));
      roofs.setMatrixAt(n, m4.compose(pos.set(b.x * XU, top * YU, b.z * XU), q, scl.set(b.lx * XU, b.roof * YU, b.lz * XU)));
    });
    walls.instanceMatrix.needsUpdate = true;
    roofs.instanceMatrix.needsUpdate = true;

    placeTreesOn(conifers, trees.conifer, h, slope);
    placeTreesOn(broadleaves, trees.broadleaf, h, slope);
  };

  const setTheme = (theme: ThemeMode) => {
    const k = theme === 'dark' ? 0.72 : 1;
    worldMats.forEach((m, n) => m.color.copy(baseColors[n]).multiplyScalar(k));
    for (const m of treeMats) m.color.setScalar(k);
  };

  return { group, update, setTheme };
}
