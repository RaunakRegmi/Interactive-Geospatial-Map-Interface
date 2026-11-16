import { useCallback, useEffect, useMemo, useState } from 'react';
import GeoViewport, { type CameraPreset, type CameraRequest, type HoverInfo } from './components/GeoViewport';
import ControlTaskbar from './components/ControlTaskbar';
import { DEFAULT_PARAMS, HeaderBar, SCENARIOS, TelemetryCard, type Scenario } from './components/TelemetryOverlay';
import {
  computeField,
  createFieldBuffers,
  generateDEM,
  type LayerMode,
  type SimParams,
  type ThemeMode,
} from './engine/terrainMath';

const THEME_KEY = 'ghs-theme';

/** Optional deep-link query parameters, e.g. ?scenario=extreme&theme=light&layer=elevation&view=topdown */
const query = new URLSearchParams(window.location.search);
const queryScenario = SCENARIOS.find((s) => s.id === query.get('scenario'));
const queryView = query.get('view');
const initialCamera: CameraPreset =
  queryView === 'section' || queryView === 'topdown' || queryView === 'isometric' ? queryView : 'isometric';

function initialTheme(): ThemeMode {
  const q = query.get('theme');
  if (q === 'light' || q === 'dark') return q;
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    /* storage unavailable */
  }
  return 'dark';
}

export default function App() {
  const dem = useMemo(() => generateDEM(), []);
  const fieldBuffers = useMemo(() => createFieldBuffers(), []);

  const [params, setParams] = useState<SimParams>(queryScenario?.params ?? DEFAULT_PARAMS);
  const [theme, setTheme] = useState<ThemeMode>(initialTheme);
  const [layer, setLayer] = useState<LayerMode>(query.get('layer') === 'elevation' ? 'elevation' : 'risk');
  const [rainPaused, setRainPaused] = useState(false);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [cameraRequest, setCameraRequest] = useState<CameraRequest>({
    preset: initialCamera,
    nonce: initialCamera === 'isometric' ? 0 : 1,
  });

  // Telemetry is evaluated on the target parameters (deterministic, instantaneous).
  const stats = useMemo(() => computeField(dem, params, fieldBuffers), [dem, params, fieldBuffers]);

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
      />
      <main className="relative min-h-0 flex-1">
        <GeoViewport
          dem={dem}
          params={params}
          theme={theme}
          layer={layer}
          rainPaused={rainPaused}
          cameraRequest={cameraRequest}
          onCameraPreset={selectCamera}
          onHover={setHover}
        />
        <TelemetryCard params={params} stats={stats} layer={layer} />
        <ControlTaskbar
          params={params}
          rainPaused={rainPaused}
          onChange={patchParams}
          onReset={reset}
          onToggleRain={() => setRainPaused((p) => !p)}
        />
      </main>
    </div>
  );
}
