import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Box, Columns3, Map as MapIcon } from 'lucide-react';
import {
  CELL_M,
  DATUM_ASL_M,
  GRID,
  LIMITS,
  METERS_PER_UNIT,
  SPAN_LAT_DEG,
  SPAN_LON_DEG,
  GEO_ORIGIN,
  VERTEX_COUNT,
  VERTICAL_EXAGGERATION,
  WORLD_SIZE,
  clamp,
  computeField,
  createFieldBuffers,
  elevationColor,
  riskColor,
  worldToIndex,
  worldToLatLon,
  type DEM,
  type LayerMode,
  type SimParams,
  type ThemeMode,
} from '../engine/terrainMath';

/* ------------------------------------------------------------------------ */
/* Public types                                                              */
/* ------------------------------------------------------------------------ */

export type CameraPreset = 'isometric' | 'section' | 'topdown';

export interface CameraRequest {
  preset: CameraPreset;
  nonce: number;
}

export interface HoverInfo {
  lat: number;
  lon: number;
  elevationAsl: number;
  slope: number;
  risk: number;
}

interface GeoViewportProps {
  dem: DEM;
  params: SimParams;
  theme: ThemeMode;
  layer: LayerMode;
  rainPaused: boolean;
  cameraRequest: CameraRequest;
  onCameraPreset: (preset: CameraPreset) => void;
  onHover: (info: HoverInfo | null) => void;
}

/* ------------------------------------------------------------------------ */
/* Constants                                                                 */
/* ------------------------------------------------------------------------ */

const HALF = WORLD_SIZE / 2;
const Y_SCALE = VERTICAL_EXAGGERATION / METERS_PER_UNIT; // metres -> world units
const BASE_Y = -2; // block-diagram floor
const RAIN_COUNT = 18000;
const RAIN_CEILING = 110;

const CAMERA_PRESETS: Record<CameraPreset, { pos: THREE.Vector3; target: THREE.Vector3 }> = {
  isometric: { pos: new THREE.Vector3(128, 104, 132), target: new THREE.Vector3(0, 6, 0) },
  section: { pos: new THREE.Vector3(6, 26, 168), target: new THREE.Vector3(0, 10, 0) },
  topdown: { pos: new THREE.Vector3(0, 236, 0.01), target: new THREE.Vector3(0, 0, 0) },
};

interface SceneTheme {
  background: number;
  overcast: number;
  hemiSky: number;
  hemiGround: number;
  hemi: number;
  sun: number;
  contour: number;
  contourOpacity: number;
  grid: number;
  gridOpacity: number;
  frame: number;
  skirt: number;
  water: number;
  rain: number;
  rainOpacity: number;
}

const SCENE_THEMES: Record<ThemeMode, SceneTheme> = {
  dark: {
    background: 0x09090b,
    overcast: 0x1d2026,
    hemiSky: 0xdbe4ee,
    hemiGround: 0x18181b,
    hemi: 0.75,
    sun: 2.1,
    contour: 0x000000,
    contourOpacity: 0.3,
    grid: 0xfafafa,
    gridOpacity: 0.07,
    frame: 0x52525b,
    skirt: 0x18181b,
    water: 0x2563eb,
    rain: 0xb4c3d6,
    rainOpacity: 0.55,
  },
  light: {
    background: 0xf8fafc,
    overcast: 0xc9d0d8,
    hemiSky: 0xffffff,
    hemiGround: 0xcbd5e1,
    hemi: 1.15,
    sun: 2.3,
    contour: 0x0f172a,
    contourOpacity: 0.22,
    grid: 0x0f172a,
    gridOpacity: 0.08,
    frame: 0x94a3b8,
    skirt: 0xe2e8f0,
    water: 0x1d4ed8,
    rain: 0x475569,
    rainOpacity: 0.5,
  },
};

/** sRGB (0..1, 8-bit quantised) -> linear lookup for vertex colours. */
const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) SRGB_TO_LINEAR[i] = new THREE.Color().setRGB(i / 255, 0, 0, THREE.SRGBColorSpace).r;

/* ------------------------------------------------------------------------ */
/* Shaders                                                                   */
/* ------------------------------------------------------------------------ */

const RAIN_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uSpeed;
  uniform float uSlant;
  uniform float uLength;
  uniform float uDensity;
  uniform float uCeiling;
  uniform float uHalf;
  attribute vec4 aDrop;
  attribute float aEnd;
  varying float vFade;
  void main() {
    float seed = aDrop.w;
    if (seed > uDensity) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vFade = 0.0;
      return;
    }
    float h = mod(aDrop.y - uTime * uSpeed * (0.82 + 0.36 * seed), uCeiling);
    float x = mod(aDrop.x + uSlant * h + uHalf, 2.0 * uHalf) - uHalf;
    vec3 p = vec3(x, h - 2.0, aDrop.z);
    vec3 tail = normalize(vec3(uSlant, 1.0, uSlant * 0.25));
    p += tail * uLength * (0.7 + 0.6 * seed) * aEnd;
    vFade = (1.0 - aEnd) * (0.45 + 0.55 * seed);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const RAIN_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vFade;
  void main() {
    gl_FragColor = vec4(uColor, uOpacity * vFade);
    #include <colorspace_fragment>
  }
`;

/* ------------------------------------------------------------------------ */
/* Component                                                                 */
/* ------------------------------------------------------------------------ */

export default function GeoViewport(props: GeoViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const dem = propsRef.current.dem;

    /* --- Renderer, scene, camera --------------------------------------- */
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.domElement.className = 'block h-full w-full outline-none';
    container.appendChild(renderer.domElement);

    const labelRenderer = new CSS2DRenderer();
    labelRenderer.domElement.className = 'pointer-events-none absolute inset-0';
    container.appendChild(labelRenderer.domElement);

    const scene = new THREE.Scene();
    const bgColor = new THREE.Color();
    scene.background = bgColor;
    const fog = new THREE.FogExp2(0x000000, 0.001);
    scene.fog = fog;

    const camera = new THREE.PerspectiveCamera(38, 1, 1, 3000);
    camera.position.copy(CAMERA_PRESETS.isometric.pos);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(CAMERA_PRESETS.isometric.target);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.zoomToCursor = true;
    controls.minDistance = 25;
    controls.maxDistance = 520;
    controls.minPolarAngle = 0;
    controls.maxPolarAngle = Math.PI / 2 - 0.06;
    controls.screenSpacePanning = true;
    controls.update();

    /* --- Lighting ------------------------------------------------------- */
    const hemi = new THREE.HemisphereLight(0xffffff, 0x222222, 1);
    const sun = new THREE.DirectionalLight(0xfff4e6, 2);
    sun.position.set(-110, 150, -90); // NW illumination (cartographic hillshade convention)
    const ambient = new THREE.AmbientLight(0xffffff, 0.12);
    scene.add(hemi, sun, ambient);

    /* --- Terrain mesh --------------------------------------------------- */
    const positions = new Float32Array(VERTEX_COUNT * 3);
    const colors = new Float32Array(VERTEX_COUNT * 3);
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const k = j * GRID + i;
        positions[k * 3] = (i / (GRID - 1) - 0.5) * WORLD_SIZE;
        positions[k * 3 + 2] = (j / (GRID - 1) - 0.5) * WORLD_SIZE;
      }
    }
    const indices = new Uint32Array((GRID - 1) * (GRID - 1) * 6);
    let q = 0;
    for (let j = 0; j < GRID - 1; j++) {
      for (let i = 0; i < GRID - 1; i++) {
        const a = j * GRID + i;
        const b = a + 1;
        const c = a + GRID;
        const d = c + 1;
        indices[q++] = a;
        indices[q++] = c;
        indices[q++] = b;
        indices[q++] = b;
        indices[q++] = c;
        indices[q++] = d;
      }
    }
    const terrainGeo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
    const colAttr = new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage);
    terrainGeo.setAttribute('position', posAttr);
    terrainGeo.setAttribute('color', colAttr);
    terrainGeo.setIndex(new THREE.BufferAttribute(indices, 1));

    const terrainUniforms = {
      uContourColor: { value: new THREE.Color() },
      uContourOpacity: { value: 0.25 },
      uContourInterval: { value: 50 },
      uIndexInterval: { value: 250 },
      uGridColor: { value: new THREE.Color() },
      uGridOpacity: { value: 0.06 },
      uGridSpacing: { value: 1000 / METERS_PER_UNIT },
      uMetersPerUnit: { value: METERS_PER_UNIT / VERTICAL_EXAGGERATION },
      uDatum: { value: DATUM_ASL_M },
    };
    const terrainMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.94,
      metalness: 0,
    });
    terrainMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, terrainUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTerrainPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTerrainPos = position;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec3 vTerrainPos;
          uniform vec3 uContourColor; uniform float uContourOpacity;
          uniform float uContourInterval; uniform float uIndexInterval;
          uniform vec3 uGridColor; uniform float uGridOpacity; uniform float uGridSpacing;
          uniform float uMetersPerUnit; uniform float uDatum;`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          {
            float elev = vTerrainPos.y * uMetersPerUnit + uDatum;
            float f1 = elev / uContourInterval;
            float w1 = max(fwidth(f1), 1e-4);
            float minor = 1.0 - smoothstep(0.0, 1.0, abs(fract(f1 - 0.5) - 0.5) / w1);
            minor *= 1.0 - smoothstep(0.18, 0.45, w1);
            float f2 = elev / uIndexInterval;
            float w2 = max(fwidth(f2), 1e-4);
            float major = 1.0 - smoothstep(0.0, 1.4, abs(fract(f2 - 0.5) - 0.5) / w2);
            major *= 1.0 - smoothstep(0.3, 0.6, w2);
            float contour = clamp(max(minor, major * 1.7) * uContourOpacity, 0.0, 1.0);
            diffuseColor.rgb = mix(diffuseColor.rgb, uContourColor, contour);
            vec2 g = vTerrainPos.xz / uGridSpacing;
            vec2 wg = max(fwidth(g), vec2(1e-4));
            vec2 gl = 1.0 - smoothstep(vec2(0.0), vec2(1.0), abs(fract(g - 0.5) - 0.5) / wg);
            diffuseColor.rgb = mix(diffuseColor.rgb, uGridColor, max(gl.x, gl.y) * uGridOpacity);
          }`,
        );
    };
    const terrain = new THREE.Mesh(terrainGeo, terrainMat);
    scene.add(terrain);

    /* --- Block-diagram skirt ------------------------------------------- */
    const perimeter: number[] = [];
    for (let i = 0; i < GRID; i++) perimeter.push(i); // north edge (j = 0)
    for (let j = 1; j < GRID; j++) perimeter.push(j * GRID + GRID - 1); // east
    for (let i = GRID - 2; i >= 0; i--) perimeter.push((GRID - 1) * GRID + i); // south
    for (let j = GRID - 2; j >= 0; j--) perimeter.push(j * GRID); // west (closes loop)
    const skirtPos = new Float32Array(perimeter.length * 2 * 3);
    perimeter.forEach((k, n) => {
      const x = positions[k * 3];
      const z = positions[k * 3 + 2];
      skirtPos.set([x, 0, z, x, BASE_Y, z], n * 6);
    });
    const skirtIdx: number[] = [];
    for (let n = 0; n < perimeter.length - 1; n++) {
      const t0 = n * 2;
      const b0 = t0 + 1;
      const t1 = t0 + 2;
      const b1 = t0 + 3;
      skirtIdx.push(t0, b0, t1, t1, b0, b1);
    }
    const skirtGeo = new THREE.BufferGeometry();
    const skirtAttr = new THREE.BufferAttribute(skirtPos, 3).setUsage(THREE.DynamicDrawUsage);
    skirtGeo.setAttribute('position', skirtAttr);
    skirtGeo.setIndex(skirtIdx);
    const skirtMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, fog: true });
    const skirt = new THREE.Mesh(skirtGeo, skirtMat);
    scene.add(skirt);

    /* --- River / water surface ----------------------------------------- */
    const waterGeo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, 1, 1);
    waterGeo.rotateX(-Math.PI / 2);
    const waterMat = new THREE.MeshPhysicalMaterial({
      transparent: true,
      opacity: 0.72,
      roughness: 0.12,
      metalness: 0.05,
      clearcoat: 0.8,
      clearcoatRoughness: 0.15,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const water = new THREE.Mesh(waterGeo, waterMat);
    water.renderOrder = 1;
    scene.add(water);

    /* --- Reference frame, ticks & labels ------------------------------- */
    const frameMat = new THREE.LineBasicMaterial({ fog: false });
    const framePts: number[] = [];
    const seg = (a: number[], b: number[]) => framePts.push(...a, ...b);
    const c = [
      [-HALF, BASE_Y, -HALF],
      [HALF, BASE_Y, -HALF],
      [HALF, BASE_Y, HALF],
      [-HALF, BASE_Y, HALF],
    ];
    for (let n = 0; n < 4; n++) seg(c[n], c[(n + 1) % 4]);
    const labels: CSS2DObject[] = [];
    const addLabel = (text: string, x: number, y: number, z: number, cls = 'geo-label') => {
      const el = document.createElement('div');
      el.className = cls;
      el.textContent = text;
      const obj = new CSS2DObject(el);
      obj.position.set(x, y, z);
      scene.add(obj);
      labels.push(obj);
      return obj;
    };
    const kmStep = 1000 / METERS_PER_UNIT;
    for (let n = 0; n <= 8; n++) {
      const p = -HALF + n * kmStep;
      const tick = n % 2 === 0 ? 2.6 : 1.4;
      seg([p, BASE_Y, HALF], [p, BASE_Y, HALF + tick]); // south edge -> longitude
      seg([-HALF, BASE_Y, p], [-HALF - tick, BASE_Y, p]); // west edge -> latitude
      if (n % 2 === 0) {
        const { lon } = worldToLatLon(p, HALF);
        const { lat } = worldToLatLon(-HALF, p);
        addLabel(`${lon.toFixed(3)}°E`, p, BASE_Y, HALF + 6);
        addLabel(`${lat.toFixed(3)}°N`, -HALF - 9, BASE_Y, p);
      }
    }
    addLabel('N', 0, BASE_Y, -HALF - 6, 'geo-label geo-label-strong');
    seg([0, BASE_Y, -HALF], [0, BASE_Y, -HALF - 3]);

    // elevation axis at the north-east corner
    const elevTicks: { obj: CSS2DObject; asl: number }[] = [];
    for (let asl = 750; asl <= 5000; asl += 250) {
      const y = (asl - DATUM_ASL_M) * Y_SCALE;
      const len = asl % 1000 === 0 ? 2.4 : 1.2;
      const tickGeo = new THREE.BufferGeometry().setAttribute(
        'position',
        new THREE.Float32BufferAttribute([HALF, y, -HALF, HALF + len, y, -HALF], 3),
      );
      const tickLine = new THREE.LineSegments(tickGeo, frameMat);
      scene.add(tickLine);
      const obj = addLabel(`${asl.toLocaleString('en-US')} m`, HALF + 8, y, -HALF);
      obj.userData.tickLine = tickLine;
      elevTicks.push({ obj, asl });
    }
    const axisGeo = new THREE.BufferGeometry().setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, 0, 0, 1, 0], 3),
    );
    const elevAxis = new THREE.LineSegments(axisGeo, frameMat);
    elevAxis.position.set(HALF, BASE_Y, -HALF);
    scene.add(elevAxis);
    const elevAxisTitle = addLabel('ELEV m ASL', HALF, 10, -HALF - 8, 'geo-label geo-label-strong');

    const frameGeo = new THREE.BufferGeometry().setAttribute(
      'position',
      new THREE.Float32BufferAttribute(framePts, 3),
    );
    const frame = new THREE.LineSegments(frameGeo, frameMat);
    scene.add(frame);

    /* --- Rain ----------------------------------------------------------- */
    const rainGeo = new THREE.BufferGeometry();
    const drop = new Float32Array(RAIN_COUNT * 2 * 4);
    const ends = new Float32Array(RAIN_COUNT * 2);
    let seed = 1234567;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let n = 0; n < RAIN_COUNT; n++) {
      const x = (rnd() - 0.5) * WORLD_SIZE;
      const y = rnd() * RAIN_CEILING;
      const z = (rnd() - 0.5) * WORLD_SIZE;
      const s = rnd();
      drop.set([x, y, z, s, x, y, z, s], n * 8);
      ends[n * 2] = 0;
      ends[n * 2 + 1] = 1;
    }
    rainGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RAIN_COUNT * 2 * 3), 3));
    rainGeo.setAttribute('aDrop', new THREE.BufferAttribute(drop, 4));
    rainGeo.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
    const rainUniforms = {
      uTime: { value: 0 },
      uSpeed: { value: 60 },
      uSlant: { value: 0.1 },
      uLength: { value: 1.5 },
      uDensity: { value: 0 },
      uCeiling: { value: RAIN_CEILING },
      uHalf: { value: HALF },
      uColor: { value: new THREE.Color() },
      uOpacity: { value: 0.5 },
    };
    const rainMat = new THREE.ShaderMaterial({
      uniforms: rainUniforms,
      vertexShader: RAIN_VERT,
      fragmentShader: RAIN_FRAG,
      transparent: true,
      depthWrite: false,
    });
    const rain = new THREE.LineSegments(rainGeo, rainMat);
    rain.frustumCulled = false;
    rain.renderOrder = 2;
    scene.add(rain);

    /* --- Simulation state ---------------------------------------------- */
    const field = createFieldBuffers();
    const current: SimParams = { ...propsRef.current.params };
    let appliedTheme: ThemeMode | null = null;
    let appliedLayer: LayerMode | null = null;
    let terrainDirty = true;
    let lastMaxY = 0;

    const tmpColor = new THREE.Color();
    const themeColor = (h: number) => tmpColor.setHex(h);

    const applyTheme = (theme: ThemeMode) => {
      const t = SCENE_THEMES[theme];
      hemi.color.setHex(t.hemiSky);
      hemi.groundColor.setHex(t.hemiGround);
      terrainUniforms.uContourColor.value.setHex(t.contour);
      terrainUniforms.uContourOpacity.value = t.contourOpacity;
      terrainUniforms.uGridColor.value.setHex(t.grid);
      terrainUniforms.uGridOpacity.value = t.gridOpacity;
      frameMat.color.setHex(t.frame);
      skirtMat.color.setHex(t.skirt);
      waterMat.color.setHex(t.water);
      rainUniforms.uColor.value.setHex(t.rain);
      rainUniforms.uOpacity.value = t.rainOpacity;
    };

    const updateAtmosphere = (theme: ThemeMode, rainfall: number) => {
      const t = SCENE_THEMES[theme];
      const o = clamp(rainfall / LIMITS.rainfall.max);
      bgColor.setHex(t.background).lerp(themeColor(t.overcast), 0.55 * o);
      fog.color.copy(bgColor);
      fog.density = 0.0009 + 0.0038 * o;
      sun.intensity = t.sun * (1 - 0.62 * o);
      hemi.intensity = t.hemi * (1 - 0.28 * o);
      rainUniforms.uDensity.value = o <= 0.001 ? 0 : 0.04 + 0.96 * o;
      rainUniforms.uSpeed.value = 55 + 0.55 * rainfall;
      rainUniforms.uSlant.value = 0.04 + 0.0018 * rainfall;
      rainUniforms.uLength.value = 1.1 + 0.014 * rainfall;
    };

    const rebuildTerrain = (theme: ThemeMode, layer: LayerMode) => {
      const stats = computeField(dem, current, field);
      const minE = stats.minElevation;
      const span = Math.max(1, stats.maxElevation - minE);
      const { elevation, slope, risk } = field;
      for (let k = 0; k < VERTEX_COUNT; k++) {
        positions[k * 3 + 1] = elevation[k] * Y_SCALE;
        const o = k * 3;
        if (layer === 'risk') riskColor(risk[k], (elevation[k] - minE) / span, slope[k], theme, colors, o);
        else elevationColor(elevation[k] + DATUM_ASL_M, theme, colors, o);
        colors[o] = SRGB_TO_LINEAR[Math.round(colors[o] * 255)];
        colors[o + 1] = SRGB_TO_LINEAR[Math.round(colors[o + 1] * 255)];
        colors[o + 2] = SRGB_TO_LINEAR[Math.round(colors[o + 2] * 255)];
      }
      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
      terrainGeo.computeVertexNormals();
      terrainGeo.computeBoundingSphere();
      terrainGeo.computeBoundingBox();

      perimeter.forEach((k, n) => {
        skirtPos[n * 6 + 1] = positions[k * 3 + 1];
      });
      skirtAttr.needsUpdate = true;
      skirtGeo.computeBoundingSphere();

      water.position.y = current.riverLevel * Y_SCALE;

      const maxY = stats.maxElevation * Y_SCALE;
      if (Math.abs(maxY - lastMaxY) > 0.01) {
        lastMaxY = maxY;
        const topY = Math.max(maxY, 10);
        elevAxis.scale.y = topY - BASE_Y;
        for (const t of elevTicks) {
          const vis = (t.asl - DATUM_ASL_M) * Y_SCALE <= topY + 0.5;
          t.obj.visible = vis;
          (t.obj.userData.tickLine as THREE.Object3D).visible = vis;
        }
        elevAxisTitle.position.y = topY + 6;
      }
    };

    /* --- Hover / raycasting -------------------------------------------- */
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let pointerInside = false;
    let hoverDirty = false;
    const onPointerMove = (e: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      pointerInside = true;
      hoverDirty = true;
    };
    const onPointerLeave = () => {
      pointerInside = false;
      propsRef.current.onHover(null);
    };
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerleave', onPointerLeave);

    const resolveHover = () => {
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(terrain, false)[0];
      if (!hit) {
        propsRef.current.onHover(null);
        return;
      }
      const k = worldToIndex(hit.point.x, hit.point.z);
      const { lat, lon } = worldToLatLon(hit.point.x, hit.point.z);
      propsRef.current.onHover({
        lat,
        lon,
        elevationAsl: field.elevation[k] + DATUM_ASL_M,
        slope: field.slope[k],
        risk: field.risk[k],
      });
    };

    /* --- Camera preset animation --------------------------------------- */
    let camAnim: {
      fromPos: THREE.Vector3;
      fromTarget: THREE.Vector3;
      toPos: THREE.Vector3;
      toTarget: THREE.Vector3;
      t: number;
    } | null = null;
    let handledNonce = 0;
    let firstFrame = true;

    /* --- Resize --------------------------------------------------------- */
    const resize = () => {
      const w = Math.max(1, container.clientWidth);
      const h = Math.max(1, container.clientHeight);
      renderer.setSize(w, h, false);
      labelRenderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    resize();

    /* --- Frame loop ----------------------------------------------------- */
    const clock = new THREE.Clock();
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(clock.getDelta(), 0.1);
      const p = propsRef.current;

      // smooth parameter transitions (critically damped exponential approach)
      const k = 1 - Math.exp(-dt * 11);
      const keys: (keyof SimParams)[] = ['rainfall', 'slope', 'riverLevel'];
      for (const key of keys) {
        const target = p.params[key];
        const diff = target - current[key];
        if (diff !== 0) {
          const eps = key === 'rainfall' ? 0.05 : 0.002;
          current[key] = Math.abs(diff) < eps ? target : current[key] + diff * k;
          terrainDirty = true;
        }
      }

      if (p.theme !== appliedTheme) {
        applyTheme(p.theme);
        appliedTheme = p.theme;
        terrainDirty = true;
      }
      if (p.layer !== appliedLayer) {
        appliedLayer = p.layer;
        terrainDirty = true;
      }
      if (terrainDirty) {
        rebuildTerrain(p.theme, p.layer);
        updateAtmosphere(p.theme, current.rainfall);
        terrainDirty = false;
        if (pointerInside) hoverDirty = true;
      }

      if (!p.rainPaused) rainUniforms.uTime.value += dt;

      const req = p.cameraRequest;
      if (req.nonce !== handledNonce) {
        handledNonce = req.nonce;
        const preset = CAMERA_PRESETS[req.preset];
        if (firstFrame) {
          // initial (deep-linked) view: jump without animating
          camera.position.copy(preset.pos);
          controls.target.copy(preset.target);
        } else camAnim = {
          fromPos: camera.position.clone(),
          fromTarget: controls.target.clone(),
          toPos: preset.pos.clone(),
          toTarget: preset.target.clone(),
          t: 0,
        };
        controls.enabled = !camAnim;
      }
      firstFrame = false;
      if (camAnim) {
        camAnim.t = Math.min(1, camAnim.t + dt / 0.9);
        const e = camAnim.t < 0.5 ? 4 * camAnim.t ** 3 : 1 - (-2 * camAnim.t + 2) ** 3 / 2;
        camera.position.lerpVectors(camAnim.fromPos, camAnim.toPos, e);
        controls.target.lerpVectors(camAnim.fromTarget, camAnim.toTarget, e);
        if (camAnim.t >= 1) {
          camAnim = null;
          controls.enabled = true;
        }
      }
      controls.update();

      if (hoverDirty && pointerInside) {
        hoverDirty = false;
        resolveHover();
      }

      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
    };
    tick();

    /* --- Teardown ------------------------------------------------------- */
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      controls.dispose();
      for (const l of labels) l.removeFromParent();
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else if (mat) mat.dispose();
      });
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      labelRenderer.domElement.remove();
    };
  }, []);

  const { onCameraPreset } = props;
  return (
    <div className="relative h-full w-full overflow-hidden bg-canvas">
      <div ref={containerRef} className="absolute inset-0 isolate z-0" />
      <CameraToolbar onSelect={onCameraPreset} active={props.cameraRequest.preset} />
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Camera preset toolbar (viewport chrome)                                   */
/* ------------------------------------------------------------------------ */

const PRESET_BUTTONS: { id: CameraPreset; label: string; Icon: typeof Box }[] = [
  { id: 'isometric', label: 'Isometric Overview', Icon: Box },
  { id: 'section', label: 'Valley Cross-Section', Icon: Columns3 },
  { id: 'topdown', label: 'Top-Down GIS', Icon: MapIcon },
];

function CameraToolbar({ onSelect, active }: { onSelect: (p: CameraPreset) => void; active: CameraPreset }) {
  return (
    <div className="absolute bottom-4 right-4 z-10 flex flex-col items-end gap-2">
      <div className="hidden border border-line bg-panel px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider text-muted md:block">
        <span className="tnum">
          GSD {CELL_M.toFixed(1)} m · VE {VERTICAL_EXAGGERATION.toFixed(1)}× · CI 50 m · GRID 1 km
        </span>
        <span className="mx-1.5 text-line">|</span>
        <span className="tnum">
          {GEO_ORIGIN.lat.toFixed(2)}–{(GEO_ORIGIN.lat + SPAN_LAT_DEG).toFixed(2)}°N
        </span>{' '}
        <span className="tnum">
          {GEO_ORIGIN.lon.toFixed(2)}–{(GEO_ORIGIN.lon + SPAN_LON_DEG).toFixed(2)}°E
        </span>
      </div>
      <div className="flex border border-line bg-panel" role="group" aria-label="Camera presets">
        {PRESET_BUTTONS.map(({ id, label, Icon }, n) => (
          <button
            key={id}
            type="button"
            onClick={() => onSelect(id)}
            className={`flex h-8 items-center gap-1.5 px-2.5 text-[11px] font-medium transition-colors ${
              n > 0 ? 'border-l border-line' : ''
            } ${active === id ? 'bg-subtle text-fg' : 'text-muted hover:bg-subtle hover:text-fg'}`}
            title={label}
          >
            <Icon size={14} strokeWidth={1.5} />
            <span className="hidden lg:inline">{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
