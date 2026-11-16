# Geospatial Hydro-Slope Simulator

An interactive 3D simulation of slope instability and flood risk in a mountain river valley, written in React 18, TypeScript, Three.js and Tailwind CSS.

It runs entirely in the browser with no map tokens or network services, so it works offline during live presentations. Fonts are bundled locally.

---

## 1. Overview

| Layer | Description |
| --- | --- |
| **Terrain** | Procedural 160 × 160 vertex DEM covering an 8 × 8 km tile (50.3 m ground sampling distance). It models a meandering river valley with an incised channel, a gently rising floodplain, terraced hillslopes, ridge lines and tributary gullies. |
| **Hydrology** | A translucent water surface rises and falls with river stage and floods the low banks. |
| **Precipitation** | 18,000 slanted rain streaks animated on the GPU. Density, fall speed, slant, overcast lighting and fog all scale with rainfall intensity. |
| **Risk model** | A deterministic composite instability and flood risk score is computed per vertex and as a global score, then drawn as a choropleth draped on the terrain. |
| **Cartography** | 50 m contours (250 m index contours), a 1 km grid, lat/lon tick labels, an elevation axis in m ASL, a north marker and a live cursor readout. |

The tile is georeferenced to an illustrative extent near 30.18–30.25°N, 79.58–79.66°E. The terrain is synthetic and does not represent surveyed ground.

---

## 2. Simulation model

### 2.1 Inputs

| Control | Range | Threshold |
| --- | --- | --- |
| Rainfall intensity *I* | 0–250 mm/hr | **145 mm/hr** (critical) |
| Slope gradient *S* | 0–60° | **30°** (critical) |
| River level *H* | 0.0–15.0 m above gauge datum | **10.0 m** (flood stage) |

### 2.2 Steepness transfer function

The DEM is stored as two components: a valley-floor field `base(x,z)` and a normalised relief field `relief(x,z)`. Elevation is

```
z(x,z) = base(x,z) + R(S) · relief(x,z)
```

At start-up, `R(S)` is calibrated for every integer degree 0–60 by bisection, so that the **mean valley-wall slope of the rendered surface equals the slider value**. At runtime, vertex elevations are recomputed and normals rebuilt (`computeVertexNormals()`) on every frame in which a parameter changes. Slider movements are eased with an exponential approach, so even fast scrubbing animates smoothly.

Local slope angle is computed analytically from precomputed central-difference gradients:

```
θ = atan(‖∇base + R·∇relief‖)
```

### 2.3 Composite risk (per vertex, 0–1)

1. **Shear susceptibility**: `steep = smoothstep(4°, 50°, θ)`, `sat = 1 − e^(−I/120)`
   `slide = steep^1.3 · (0.20 + 0.46·sat)`
2. **Basal undercutting** along banks as the stage rises:
   `slide += 0.20 · e^(−h/22) · steep · smoothstep(0.3, 1.4, H/10)`, where *h* is height above the water surface.
3. **Compound critical trigger.** When **I > 145 mm/hr AND S > 30°**, a non-linear saturation and shear-stress multiplier applies:
   `slide ×= 1 + g · steep^0.8`, with `g = 0.62 + 0.45·√(eI·eS) + 0.25·(eI + eS)`. Here `eI` and `eS` are the normalised exceedances above each threshold. This pushes steep faces sharply past the 75% critical line.
4. **Fluvial inundation**: proximity to and depth below the water surface, gated by `H / flood stage`. Deep floodplain flooding above 8 m stage adds a further term.
5. **Union of the two hazards**: `risk = 1 − (1 − slide)(1 − flood)`.

Global telemetry reports the **peak** risk, mean risk, area at ≥ 75%, area at 50–74%, inundated floodplain area (km², at 0.00253 km² per vertex), mean hillslope and relief range.

### 2.4 Classification

| Class | Risk | Light | Dark |
| --- | --- | --- | --- |
| Safe | **< 50%** | `#16A34A` | `#22C55E` |
| Elevated warning | **50% ≤ risk < 75%** | `#EAB308` | `#EAB308` |
| Critical hazard | **≥ 75%** | `#DC2626` | `#EF4444` |

Safe cells are shaded by normalised elevation so relief stays readable. Critical cells on steep faces get a subtle highlight. The **Topographic** layer swaps the choropleth for a hypsometric tint, so you can compare the raw geography with the risk zones.

### 2.5 Scenario presets

| Preset | I (mm/hr) | S (°) | H (m) | Peak risk |
| --- | --- | --- | --- | --- |
| Nominal Baseline | 18 | 14 | 3.0 | ≈ 25% (Safe) |
| Monsoon Warning | 125 | 27 | 10.1 | ≈ 55% (Warning) |
| Extreme Landslide Trigger | 190 | 40 | 12.5 | 100% (Critical, ≈ 30 km²) |

---

## 3. Architecture

```
src/
├── engine/
│   └── terrainMath.ts        DEM generation, slope calibration, risk model, colour maps, georeferencing
├── components/
│   ├── GeoViewport.tsx       Three.js scene: terrain, contour/grid shader, skirt, water, rain,
│   │                         theme-aware lighting & fog, OrbitControls, camera presets, raycast readout
│   ├── ControlTaskbar.tsx    Precision sliders with threshold markers, Reset, Pause/Play rain
│   └── TelemetryOverlay.tsx  Header (status, presets, layer & theme toggles), telemetry & legend card
├── App.tsx                   State container; telemetry evaluated on target parameters
├── main.tsx
└── index.css                 Design tokens (CSS custom properties) for light & dark themes
```

**Rendering and performance**

- One Three.js scene is created when the component mounts. React props reach the render loop through a ref, so moving a slider never re-creates GPU resources.
- Terrain position and colour buffers use `DynamicDrawUsage` and are updated in place. A full field update (25,600 vertices, including normals) takes a few milliseconds.
- Rain animates entirely in a vertex shader (`LineSegments` + `ShaderMaterial`), so it costs nothing on the CPU per frame. Pause freezes the shader clock.
- Contours and the coordinate grid are drawn in the fragment shader (`onBeforeCompile`) with `fwidth` anti-aliasing.
- On unmount, every geometry and material is disposed, along with the renderer, controls, label layer, observers and listeners.

**Theming**

Tailwind uses the `class` dark-mode strategy and colours resolve from CSS custom properties. The same theme switch drives the WebGL scene: background/sky, fog, hemisphere and sun lighting, contour and grid line colours, water and rain.

**Camera**

`OrbitControls` is configured with damping and zoom-to-cursor, and the polar angle is capped so the camera cannot go below the terrain. There are three animated presets: *Isometric Overview*, *Valley Cross-Section* and *Top-Down GIS*.

---

## 4. Local setup

Requirements: Node.js ≥ 18.

```bash
npm install
npm run dev          # http://localhost:5173
npm run typecheck    # tsc --noEmit
npm run build        # type-check + production bundle in dist/
npm run preview      # serve the production build
```

### Deep links (handy for presentations)

```
/?scenario=nominal|monsoon|extreme
 &theme=light|dark
 &layer=risk|elevation
 &view=isometric|section|topdown
```

For example, `/?scenario=extreme&view=section&theme=dark`.

---

## 5. Disclaimer

This is a visualisation and teaching tool. The DEM is procedural, and the risk formula is a deterministic heuristic loosely based on infinite-slope stability and stage-inundation concepts. It is not calibrated against field data and must not be used for real hazard assessment or emergency decisions.
