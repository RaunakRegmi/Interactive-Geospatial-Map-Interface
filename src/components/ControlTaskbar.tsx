import type { CSSProperties, ReactNode } from 'react';
import { CloudRain, Mountain, Pause, Play, RotateCcw, Waves } from 'lucide-react';
import { LIMITS, THRESHOLDS, type SimParams } from '../engine/terrainMath';

interface ControlTaskbarProps {
  params: SimParams;
  rainPaused: boolean;
  onChange: (patch: Partial<SimParams>) => void;
  onReset: () => void;
  onToggleRain: () => void;
}

export default function ControlTaskbar({ params, rainPaused, onChange, onReset, onToggleRain }: ControlTaskbarProps) {
  return (
    <section
      aria-label="Simulation controls"
      className="absolute bottom-4 left-4 z-10 w-[min(400px,calc(100vw-32px))] border border-line bg-panel"
    >
      <header className="flex h-9 items-center justify-between border-b border-line pl-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Simulation Controls</span>
        <div className="flex h-full">
          <button
            type="button"
            onClick={onToggleRain}
            className="flex h-full items-center gap-1.5 border-l border-line px-3 text-[11px] font-medium text-muted transition-colors hover:bg-subtle hover:text-fg"
            aria-pressed={rainPaused}
          >
            {rainPaused ? <Play size={13} strokeWidth={1.5} /> : <Pause size={13} strokeWidth={1.5} />}
            {rainPaused ? 'Play Rain' : 'Pause Rain'}
          </button>
          <button
            type="button"
            onClick={onReset}
            className="flex h-full items-center gap-1.5 border-l border-line px-3 text-[11px] font-medium text-muted transition-colors hover:bg-subtle hover:text-fg"
          >
            <RotateCcw size={13} strokeWidth={1.5} />
            Reset
          </button>
        </div>
      </header>

      <div className="divide-y divide-line">
        <PrecisionSlider
          id="rainfall"
          label="Rainfall Intensity"
          icon={<CloudRain size={14} strokeWidth={1.5} />}
          unit="mm/hr"
          value={params.rainfall}
          decimals={0}
          {...LIMITS.rainfall}
          threshold={THRESHOLDS.rainfall}
          thresholdLabel="145 critical"
          ticks={[0, 50, 100, 150, 200, 250]}
          onChange={(v) => onChange({ rainfall: v })}
        />
        <PrecisionSlider
          id="slope"
          label="Slope Gradient"
          icon={<Mountain size={14} strokeWidth={1.5} />}
          unit="°"
          value={params.slope}
          decimals={1}
          {...LIMITS.slope}
          threshold={THRESHOLDS.slope}
          thresholdLabel="30° critical"
          ticks={[0, 10, 20, 30, 40, 50, 60]}
          onChange={(v) => onChange({ slope: v })}
        />
        <PrecisionSlider
          id="river"
          label="River Level"
          icon={<Waves size={14} strokeWidth={1.5} />}
          unit="m"
          value={params.riverLevel}
          decimals={1}
          {...LIMITS.riverLevel}
          threshold={THRESHOLDS.floodStage}
          thresholdLabel="10.0 flood stage"
          ticks={[0, 2.5, 5, 7.5, 10, 12.5, 15]}
          onChange={(v) => onChange({ riverLevel: v })}
        />
      </div>
    </section>
  );
}

interface PrecisionSliderProps {
  id: string;
  label: string;
  icon: ReactNode;
  unit: string;
  value: number;
  min: number;
  max: number;
  step: number;
  decimals: number;
  threshold: number;
  thresholdLabel: string;
  ticks: number[];
  onChange: (v: number) => void;
}

/** Thumb is 12px wide; positions inside the track are inset by half a thumb. */
const trackPos = (pct: number) => `calc(6px + (100% - 12px) * ${pct})`;

function PrecisionSlider({
  id,
  label,
  icon,
  unit,
  value,
  min,
  max,
  step,
  decimals,
  threshold,
  thresholdLabel,
  ticks,
  onChange,
}: PrecisionSliderProps) {
  const pct = (value - min) / (max - min);
  const tPct = (threshold - min) / (max - min);
  const exceeded = value > threshold;
  const inputId = `slider-${id}`;
  const style = {
    '--pct': `calc(6px + (100% - 12px) * ${pct})`,
    '--fill': exceeded ? 'rgb(var(--c-crit))' : 'rgb(var(--c-fg))',
  } as CSSProperties;

  return (
    <div className="px-3 pb-2 pt-2.5">
      <div className="mb-1 flex items-center justify-between">
        <label htmlFor={inputId} className="flex items-center gap-2 text-[12px] font-medium text-fg">
          <span className="text-muted">{icon}</span>
          {label}
        </label>
        <div className="flex items-baseline gap-1 font-mono">
          <span className={`tnum text-[13px] font-semibold ${exceeded ? 'text-crit' : 'text-fg'}`}>
            {value.toFixed(decimals)}
          </span>
          <span className="w-9 text-[10px] text-muted">{unit}</span>
        </div>
      </div>

      <div className="relative">
        <input
          id={inputId}
          type="range"
          className="sim-range relative z-[1]"
          min={min}
          max={max}
          step={step}
          value={value}
          style={style}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-valuetext={`${value.toFixed(decimals)} ${unit}`}
        />
        {/* threshold marker */}
        <div
          className="pointer-events-none absolute top-1/2 z-0 h-3.5 w-px -translate-y-1/2 bg-crit"
          style={{ left: trackPos(tPct) }}
          aria-hidden
        />
      </div>

      <div className="relative h-4 font-mono text-[9px] text-muted" aria-hidden>
        {ticks.map((t) => {
          const p = (t - min) / (max - min);
          return (
            <div key={t} className="absolute top-0 -translate-x-1/2" style={{ left: trackPos(p) }}>
              <div className="mx-auto h-1 w-px bg-line" />
              <span className="tnum block leading-3">{t}</span>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-wider text-muted" aria-hidden>
        <span className="inline-block h-2 w-px bg-crit" />
        <span className="tnum">{thresholdLabel}</span>
      </div>
    </div>
  );
}
