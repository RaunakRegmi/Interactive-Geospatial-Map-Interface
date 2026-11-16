import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import GeoViewport, { type CameraPreset, type CameraRequest, type HoverInfo } from './components/GeoViewport';
import ControlTaskbar from './components/ControlTaskbar';
import FloodMap2D from './components/FloodMap2D';
import Sidebar, { type SidebarTab } from './components/Sidebar';
import { DEFAULT_LAYERS, type Basemap } from './components/layerCatalog';
import {
  DEFAULT_PARAMS,
  HeaderBar,
  SCENARIOS,
  TelemetryCard,
  type Scenario,
  type ViewMode,
} from './components/TelemetryOverlay';
import {
  computeField,
  createFieldBuffers,
  generateDEM,
  type LayerMode,
  type SimParams,
  type ThemeMode,
} from './engine/terrainMath';
import {
  buildFineTerrain,
  computeDepthSet,
  exposureTable,
  fineElevation,
  generateBuildings,
  generateRoads,
} from './engine/floodModel';

const THEME_KEY = 'pahiro-theme';

/** Optional deep-link query parameters, e.g. ?view=3d&scenario=extreme&theme=dark&layer=elevation&camera=topdown&world=0 */
const query = new URLSearchParams(window.location.search);
const queryScenario = SCENARIOS.find((s) => s.id === query.get('scenario'));
const queryCamera = query.get('camera');
const initialCamera: CameraPreset =
  queryCamera === 'section' || queryCamera === 'topdown' || queryCamera === 'isometric' ? queryCamera : 'isometric';
const queryBasemap = query.get('basemap');

function initialTheme(): ThemeMode {
  const q = query.get('theme');
  if (q === 'light' || q === 'dark') return q;
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    /* storage unavailable */
  }
  return 'light';
}

export default function App() {
  const dem = useMemo(() => generateDEM(), []);
  const fieldBuffers = useMemo(() => createFieldBuffers(), []);
  const fine = useMemo(() => buildFineTerrain(dem), [dem]);
  const buildings = useMemo(() => generateBuildings(), []);
  const roads = useMemo(() => generateRoads(), []);

  const [view, setView] = useState<ViewMode>(query.get('view') === '3d' ? '3d' : '2d');
  const [params, setParams] = useState<SimParams>(queryScenario?.params ?? DEFAULT_PARAMS);
  const [theme, setTheme] = useState<ThemeMode>(initialTheme);
  const [layer, setLayer] = useState<LayerMode>(() => {
    const q = query.get('layer');
    return q === 'elevation' || q === 'risk' ? q : 'landscape';
  });
  const [showWorld, setShowWorld] = useState(query.get('world') !== '0');
  const [rainPaused, setRainPaused] = useState(false);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [cameraRequest, setCameraRequest] = useState<CameraRequest>({
    preset: initialCamera,
    nonce: initialCamera === 'isometric' ? 0 : 1,
  });

  // 2D map state
  const [activeLayers, setActiveLayers] = useState<string[]>(() => {
    const q = query.get('layers');
    return q ? q.split(',') : DEFAULT_LAYERS;
  });
  const [basemap, setBasemap] = useState<Basemap>(
    queryBasemap === 'imagery' || queryBasemap === 'monochrome' ? queryBasemap : 'topographic',
  );
  const [overlayOpacity, setOverlayOpacity] = useState(0.7);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('layers');
  const [infoLayerId, setInfoLayerId] = useState<string | null>(null);
  const [pointQuery, setPointQuery] = useState<{ x: number; z: number } | null>(null);

  // Telemetry is evaluated on the target parameters (deterministic, instantaneous).
  const stats = useMemo(() => computeField(dem, params, fieldBuffers), [dem, params, fieldBuffers]);
  const riskKey = `${params.rainfall}|${params.slope}|${params.riverLevel}`;

  // Flood rasters depend on terrain relief (slope). Only rebuild them while the
  // 2D map is visible so slider scrubbing in 3D stays at full frame rate.
  const slope2DRef = useRef(params.slope);
  if (view === '2d') slope2DRef.current = params.slope;
  const slope2D = slope2DRef.current;
  const elev = useMemo(() => fineElevation(dem, fine, slope2D), [dem, fine, slope2D]);
  const depths = useMemo(() => computeDepthSet(elev, fine.riverDist), [elev, fine]);
  const exposure = useMemo(() => exposureTable(depths, buildings), [depths, buildings]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* storage unavailable */
    }
  }, [theme]);

  const patchParams = useCallback((patch: Partial<SimParams>) => setParams((p) => ({ ...p, ...patch })), []);
  const applyScenario = useCallback((s: Scenario) => setParams({ ...s.params }), []);
  const reset = useCallback(() => {
    setParams({ ...DEFAULT_PARAMS });
    setRainPaused(false);
  }, []);
  const selectCamera = useCallback(
    (preset: CameraPreset) => setCameraRequest((r) => ({ preset, nonce: r.nonce + 1 })),
    [],
  );
  const toggleLayer = useCallback(
    (id: string) => setActiveLayers((ls) => (ls.includes(id) ? ls.filter((l) => l !== id) : [...ls, id])),
    [],
  );
  const onQuery = useCallback((x: number, z: number) => {
    setPointQuery({ x, z });
    setSidebarTab('tools');
  }, []);
  const changeView = useCallback((v: ViewMode) => {
    setView(v);
    setHover(null);
  }, []);

  return (
    <div className="flex h-full flex-col bg-canvas text-fg">
      <HeaderBar
        params={params}
        stats={stats}
        hover={hover}
        theme={theme}
        layer={layer}
        onTheme={setTheme}
        onLayer={setLayer}
        onScenario={applyScenario}
        view={view}
        onView={changeView}
      />
      <div className="flex min-h-0 flex-1">
        <div className="hidden md:block">
          <Sidebar
            tab={sidebarTab}
            onTab={setSidebarTab}
            activeLayers={activeLayers}
            onToggleLayer={toggleLayer}
            onSetLayers={setActiveLayers}
            overlayOpacity={overlayOpacity}
            onOpacity={setOverlayOpacity}
            infoLayerId={infoLayerId}
            onInfo={setInfoLayerId}
            query={pointQuery}
            onClearQuery={() => setPointQuery(null)}
            depths={depths}
            elev={elev}
            field={fieldBuffers}
            buildings={buildings}
            exposure={exposure}
          />
        </div>
        <main className="relative min-w-0 flex-1">
          {view === '2d' ? (
            <FloodMap2D
              fine={fine}
              elev={elev}
              depths={depths}
              riskGrid={fieldBuffers.risk}
              riskKey={riskKey}
              buildings={buildings}
              roads={roads}
              activeLayers={activeLayers}
              basemap={basemap}
              onBasemap={setBasemap}
              theme={theme}
              overlayOpacity={overlayOpacity}
              riverLevel={params.riverLevel}
              query={pointQuery}
              onQuery={onQuery}
            />
          ) : (
            <>
              <GeoViewport
                dem={dem}
                params={params}
                theme={theme}
                layer={layer}
                rainPaused={rainPaused}
                cameraRequest={cameraRequest}
                onCameraPreset={selectCamera}
                onHover={setHover}
                buildings={buildings}
                roads={roads}
                showWorld={showWorld}
                onToggleWorld={() => setShowWorld((w) => !w)}
              />
              <TelemetryCard params={params} stats={stats} layer={layer} />
              <ControlTaskbar
                params={params}
                rainPaused={rainPaused}
                onChange={patchParams}
                onReset={reset}
                onToggleRain={() => setRainPaused((p) => !p)}
              />
            </>
          )}
        </main>
      </div>
    </div>
  );
}
