import { useState, type ReactNode } from 'react';
import { Box, ChevronDown, ChevronUp, Crosshair, Layers, Map as MapIcon, Moon, Sun } from 'lucide-react';
import {
  HYPSOMETRIC_STOPS,
  THRESHOLDS,
  type FieldStats,
  type LayerMode,
  type RiskBand,
  type SimParams,
  type ThemeMode,
} from '../engine/terrainMath';
import type { HoverInfo } from './GeoViewport';

/* ------------------------------------------------------------------------ */
/* Scenario presets                                                          */
/* ------------------------------------------------------------------------ */

export interface Scenario {
  id: string;
  label: string;
  short: string;
  params: SimParams;
}

export const SCENARIOS: Scenario[] = [
  { id: 'nominal', label: 'Nominal Baseline', short: 'Nominal', params: { rainfall: 18, slope: 14, riverLevel: 3 } },
  {
    id: 'monsoon',
    label: 'Monsoon Warning (55%)',
    short: 'Monsoon',
    params: { rainfall: 125, slope: 27, riverLevel: 10.1 },
  },
  {
    id: 'extreme',
    label: 'Extreme Landslide Trigger (>145mm/hr, >30°)',
    short: 'Extreme',
    params: { rainfall: 190, slope: 40, riverLevel: 12.5 },
  },
];

export const DEFAULT_PARAMS: SimParams = SCENARIOS[0].params;

const sameParams = (a: SimParams, b: SimParams) =>
  Math.abs(a.rainfall - b.rainfall) < 1e-6 &&
  Math.abs(a.slope - b.slope) < 1e-6 &&
  Math.abs(a.riverLevel - b.riverLevel) < 1e-6;

/* ------------------------------------------------------------------------ */
/* Shared atoms                                                              */
/* ------------------------------------------------------------------------ */

const BAND_META: Record<RiskBand, { label: string; range: string; text: string; bg: string; border: string }> = {
  safe: { label: 'SAFE', range: '<50%', text: 'text-safe', bg: 'bg-safe', border: 'border-safe/40' },
  warning: { label: 'WARNING', range: '50–74%', text: 'text-warnink', bg: 'bg-warn', border: 'border-warn/50' },
  critical: { label: 'CRITICAL', range: '≥75%', text: 'text-crit', bg: 'bg-crit', border: 'border-crit/50' },
};

function StatusBadge({ band }: { band: RiskBand }) {
  const m = BAND_META[band];
  return (
    <div
      className={`flex h-6 items-center gap-2 border ${m.border} bg-panel px-2 font-mono text-[11px] font-semibold tracking-wider ${m.text}`}
      role="status"
      aria-live="polite"
    >
      <span className={`h-2 w-2 ${m.bg} ${band === 'critical' ? 'animate-[blink_1s_steps(2,start)_infinite]' : ''}`} />
      <span>{m.label}</span>
      <span className="tnum font-normal opacity-80">{m.range}</span>
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: { id: T; label: string; icon?: ReactNode }[];
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="flex h-7 border border-line" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o, n) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={`flex items-center gap-1.5 whitespace-nowrap px-2.5 text-[11px] font-medium transition-colors ${
            n > 0 ? 'border-l border-line' : ''
          } ${value === o.id ? 'bg-brand text-white' : 'text-muted hover:bg-subtle hover:text-fg'}`}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Header bar                                                                */
/* ------------------------------------------------------------------------ */

interface HeaderBarProps {
  params: SimParams;
  stats: FieldStats;
  hover: HoverInfo | null;
  theme: ThemeMode;
  layer: LayerMode;
  onTheme: (t: ThemeMode) => void;
  onLayer: (l: LayerMode) => void;
  onScenario: (s: Scenario) => void;
  view: ViewMode;
  onView: (v: ViewMode) => void;
}

export type ViewMode = '2d' | '3d';

export function HeaderBar({ params, stats, hover, theme, layer, onTheme, onLayer, onScenario, view, onView }: HeaderBarProps) {
  return (
    <header className="relative z-20 flex h-14 shrink-0 items-center justify-between gap-4 border-b border-line bg-panel px-4">
      <div className="flex min-w-0 items-center gap-4">
        <div className="flex shrink-0 items-center gap-2">
          <img src="/pahiro-mark.png" alt="" width={34} height={34} className="h-[34px] w-[34px] rounded-full bg-white" />
          <h1 className="flex flex-col leading-none">
            <span className="whitespace-nowrap text-[15px] font-semibold tracking-[0.04em] text-brand dark:text-fg">
              PAHIRO <span className="text-brandred">GUARD</span>
            </span>
            <span className="mt-0.5 hidden whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.12em] text-muted sm:block">
              Flood &amp; Landslide Risk Platform // v1.1
            </span>
          </h1>
        </div>
        <div className="hidden h-6 w-px bg-line md:block" />
        <Segmented<ViewMode>
          ariaLabel="View"
          value={view}
          onChange={onView}
          options={[
            { id: '2d', label: '2D Flood Map', icon: <MapIcon size={13} strokeWidth={1.5} /> },
            { id: '3d', label: '3D Terrain', icon: <Box size={13} strokeWidth={1.5} /> },
          ]}
        />
        <div className="hidden h-5 w-px bg-line min-[1800px]:block" />
        <div className="hidden min-w-0 items-center gap-2 font-mono text-[11px] text-muted min-[1800px]:flex">
          <Crosshair size={13} strokeWidth={1.5} className="shrink-0" />
          {hover && view === '3d' ? (
            <span className="tnum truncate">
              <span className="text-fg">{hover.lat.toFixed(5)}°N</span>{' '}
              <span className="text-fg">{hover.lon.toFixed(5)}°E</span>
              <span className="mx-1.5 text-line">|</span>
              {Math.round(hover.elevationAsl).toLocaleString('en-US')} m ASL
              <span className="mx-1.5 text-line">|</span>
              {hover.slope.toFixed(1)}°
              <span className="mx-1.5 text-line">|</span>
              <span className={BAND_META[bandOf(hover.risk)].text}>R {(hover.risk * 100).toFixed(1)}%</span>
            </span>
          ) : (
            <span className="tnum truncate">
              CURSOR — <span className="mx-1.5 text-line">|</span>I {params.rainfall.toFixed(0)} mm/hr · θ{' '}
              {params.slope.toFixed(1)}° · H {params.riverLevel.toFixed(1)} m
            </span>
          )}
        </div>
        <StatusBadge band={stats.band} />
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <div className="flex h-7 border border-line" role="group" aria-label="Scenario presets">
          {SCENARIOS.map((s, n) => {
            const active = sameParams(params, s.params);
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => onScenario(s)}
                title={s.label}
                className={`px-2.5 text-[11px] font-medium transition-colors ${n > 0 ? 'border-l border-line' : ''} ${
                  active ? 'bg-brandred text-white' : 'text-muted hover:bg-subtle hover:text-fg'
                }`}
              >
                <span className="hidden min-[1760px]:inline">{s.label}</span>
                <span className="min-[1760px]:hidden">{s.short}</span>
              </button>
            );
          })}
        </div>
        <div className={view === '3d' ? 'hidden md:block' : 'hidden'}>
          <Segmented<LayerMode>
            ariaLabel="Layer mode"
            value={layer}
            onChange={onLayer}
            options={[
              { id: 'risk', label: 'Risk Choropleth', icon: <Layers size={13} strokeWidth={1.5} /> },
              { id: 'elevation', label: 'Topographic' },
            ]}
          />
        </div>
        <Segmented<ThemeMode>
          ariaLabel="Theme"
          value={theme}
          onChange={onTheme}
          options={[
            { id: 'light', label: 'Light', icon: <Sun size={13} strokeWidth={1.5} /> },
            { id: 'dark', label: 'Dark', icon: <Moon size={13} strokeWidth={1.5} /> },
          ]}
        />
      </div>
    </header>
  );
}

function bandOf(r: number): RiskBand {
  return r >= THRESHOLDS.critical ? 'critical' : r >= THRESHOLDS.warning ? 'warning' : 'safe';
}

/* ------------------------------------------------------------------------ */
/* Telemetry & legend card                                                   */
/* ------------------------------------------------------------------------ */

interface TelemetryCardProps {
  params: SimParams;
  stats: FieldStats;
  layer: LayerMode;
}

export function TelemetryCard({ params, stats, layer }: TelemetryCardProps) {
  const [collapsed, setCollapsed] = useState(false);
  const band = stats.band;
  const meta = BAND_META[band];
  const peakPct = stats.peakRisk * 100;
  const rainHit = params.rainfall > THRESHOLDS.rainfall;
  const slopeHit = params.slope > THRESHOLDS.slope;
  const floodHit = params.riverLevel >= THRESHOLDS.floodStage;

  return (
    <aside
      aria-label="Risk telemetry"
      className="absolute right-4 top-4 z-10 w-[min(296px,calc(100vw-32px))] border border-line bg-panel"
    >
      <header className="flex h-9 items-center justify-between border-b border-line pl-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Risk Telemetry</span>
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex h-full items-center border-l border-line px-2.5 text-muted hover:bg-subtle hover:text-fg"
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand telemetry' : 'Collapse telemetry'}
        >
          {collapsed ? <ChevronDown size={14} strokeWidth={1.5} /> : <ChevronUp size={14} strokeWidth={1.5} />}
        </button>
      </header>

      {/* Peak risk */}
      <div className="px-3 pb-3 pt-2.5">
        <div className="flex items-baseline justify-between">
          <span className="text-[11px] text-muted">Peak Composite Risk</span>
          <span className={`font-mono text-[10px] font-semibold tracking-wider ${meta.text}`}>{meta.label}</span>
        </div>
        <div className={`tnum mt-0.5 font-mono text-[30px] font-semibold leading-none ${meta.text}`}>
          {peakPct.toFixed(1)}
          <span className="ml-0.5 text-[16px] font-medium">%</span>
        </div>
        <div className="relative mt-2.5 h-1.5 bg-subtle">
          <div className={`absolute inset-y-0 left-0 ${meta.bg}`} style={{ width: `${peakPct}%` }} />
          <div className="absolute -inset-y-0.5 left-1/2 w-px bg-fg/60" />
          <div className="absolute -inset-y-0.5 left-3/4 w-px bg-fg/60" />
        </div>
        <div className="tnum relative mt-1 h-3 font-mono text-[9px] text-muted">
          <span className="absolute left-0">0</span>
          <span className="absolute left-1/2 -translate-x-1/2">50</span>
          <span className="absolute left-3/4 -translate-x-1/2">75</span>
          <span className="absolute right-0">100</span>
        </div>
      </div>

      {!collapsed && (
        <>
          <dl className="grid grid-cols-2 border-t border-line">
            <Metric label="High-Risk Area ≥75%" value={stats.criticalAreaKm2.toFixed(2)} unit="km²" tone={stats.criticalAreaKm2 > 0 ? 'text-crit' : undefined} />
            <Metric label="Elevated 50–74%" value={stats.elevatedAreaKm2.toFixed(2)} unit="km²" tone={stats.elevatedAreaKm2 > 0 ? 'text-warnink' : undefined} left />
            <Metric label="Mean Risk" value={(stats.meanRisk * 100).toFixed(1)} unit="%" top />
            <Metric label="Inundated Floodplain" value={stats.inundatedAreaKm2.toFixed(2)} unit="km²" top left />
            <Metric label="Mean Hillslope" value={stats.meanHillslope.toFixed(1)} unit="°" top />
            <Metric label="Relief Range" value={Math.round(stats.maxElevation - stats.minElevation).toLocaleString('en-US')} unit="m" top left />
          </dl>

          <div className="border-t border-line px-3 py-2.5">
            <div className="mb-1.5 text-[11px] text-muted">Threshold Status</div>
            <ul className="space-y-1">
              <Flag label="Rainfall > 145 mm/hr" on={rainHit} />
              <Flag label="Slope > 30°" on={slopeHit} />
              <Flag label="River ≥ 10.0 m flood stage" on={floodHit} />
              <Flag label="Compound shear trigger" on={stats.compound} trueText="ARMED" falseText="IDLE" />
            </ul>
          </div>

          <div className="border-t border-line px-3 py-2.5">
            <div className="mb-1.5 flex items-center justify-between text-[11px] text-muted">
              <span>Legend</span>
              <span className="font-mono text-[9px] uppercase tracking-wider">
                {layer === 'risk' ? 'Risk Choropleth' : 'Hypsometric Tint'}
              </span>
            </div>
            <ul className={`space-y-1 font-mono text-[11px] ${layer === 'elevation' ? 'opacity-60' : ''}`}>
              <LegendRow swatch="bg-safe" range="< 50%" label="Safe" />
              <LegendRow swatch="bg-warn" range="50–74%" label="Elevated" />
              <LegendRow swatch="bg-crit" range="≥ 75%" label="Critical" />
            </ul>
            {layer === 'elevation' && (
              <div className="mt-2.5">
                <div
                  className="h-2 border border-line"
                  style={{
                    background: `linear-gradient(to right, ${HYPSOMETRIC_STOPS.map(
                      ([, c], n) =>
                        `rgb(${c.map((v) => Math.round(v * 255)).join(' ')}) ${(n / (HYPSOMETRIC_STOPS.length - 1)) * 100}%`,
                    ).join(', ')})`,
                  }}
                />
                <div className="tnum mt-1 flex justify-between font-mono text-[9px] text-muted">
                  <span>{HYPSOMETRIC_STOPS[0][0]} m</span>
                  <span>{HYPSOMETRIC_STOPS[HYPSOMETRIC_STOPS.length - 1][0].toLocaleString('en-US')} m ASL</span>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

function Metric({
  label,
  value,
  unit,
  tone,
  top,
  left,
}: {
  label: string;
  value: string;
  unit: string;
  tone?: string;
  top?: boolean;
  left?: boolean;
}) {
  return (
    <div className={`px-3 py-2 ${top ? 'border-t border-line' : ''} ${left ? 'border-l border-line' : ''}`}>
      <dt className="truncate text-[10px] text-muted">{label}</dt>
      <dd className={`tnum mt-0.5 font-mono text-[14px] font-semibold ${tone ?? 'text-fg'}`}>
        {value}
        <span className="ml-1 text-[10px] font-normal text-muted">{unit}</span>
      </dd>
    </div>
  );
}

function Flag({
  label,
  on,
  trueText = 'TRUE',
  falseText = 'FALSE',
}: {
  label: string;
  on: boolean;
  trueText?: string;
  falseText?: string;
}) {
  return (
    <li className="flex items-center justify-between text-[11px]">
      <span className="tnum font-mono text-fg">{label}</span>
      <span
        className={`flex h-5 w-[64px] items-center justify-center gap-1.5 border font-mono text-[10px] font-semibold tracking-wider ${
          on ? 'border-crit/50 text-crit' : 'border-line text-muted'
        }`}
      >
        <span className={`h-1.5 w-1.5 ${on ? 'bg-crit' : 'bg-line'}`} />
        {on ? trueText : falseText}
      </span>
    </li>
  );
}

function LegendRow({ swatch, range, label }: { swatch: string; range: string; label: string }) {
  return (
    <li className="flex items-center gap-2">
      <span className={`h-3 w-3 border border-fg/10 ${swatch}`} />
      <span className="tnum w-16 text-fg">{range}</span>
      <span className="text-muted">{label}</span>
    </li>
  );
}
