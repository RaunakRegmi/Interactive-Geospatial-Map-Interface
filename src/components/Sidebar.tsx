import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Download, Info, Layers, MapPin, Search, Wrench, X } from 'lucide-react';
import {
  DATUM_ASL_M,
  EXTENT_M,
  THRESHOLDS,
  worldToIndex,
  worldToLatLon,
  type FieldBuffers,
} from '../engine/terrainMath';
import {
  CLIMATE_SCENARIOS,
  PAST_EVENTS,
  PROBABILITIES,
  RES_CELL_M,
  buildingFloodClass,
  distance,
  sampleRaster,
  type Building,
  type ClimateScenario,
  type DepthSet,
  type ExposureRow,
} from '../engine/floodModel';
import { LAYER_GROUPS, findLayer } from './layerCatalog';
import { LegendSwatch } from './FloodMap2D';

export type SidebarTab = 'layers' | 'tools' | 'info';

interface SidebarProps {
  tab: SidebarTab;
  onTab: (t: SidebarTab) => void;
  activeLayers: string[];
  onToggleLayer: (id: string) => void;
  onSetLayers: (ids: string[]) => void;
  overlayOpacity: number;
  onOpacity: (v: number) => void;
  infoLayerId: string | null;
  onInfo: (id: string) => void;
  query: { x: number; z: number } | null;
  onClearQuery: () => void;
  depths: DepthSet;
  elev: Float32Array;
  field: FieldBuffers;
  buildings: Building[];
  exposure: ExposureRow[];
}

const HALF = EXTENT_M / 2;

export default function Sidebar(props: SidebarProps) {
  const { tab, onTab } = props;
  return (
    <nav className="flex h-full w-[320px] shrink-0 flex-col border-r border-line bg-panel" aria-label="Map sidebar">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'layers' && <LayersTab {...props} />}
        {tab === 'tools' && <ToolsTab {...props} />}
        {tab === 'info' && <InfoTab {...props} />}
      </div>
      <div className="grid h-12 shrink-0 grid-cols-3 border-t border-line" role="tablist">
        {(
          [
            { id: 'layers', label: 'Layers', Icon: Layers },
            { id: 'tools', label: 'Tools', Icon: Wrench },
            { id: 'info', label: 'Info', Icon: Info },
          ] as const
        ).map(({ id, label, Icon }, n) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => onTab(id)}
            className={`flex flex-col items-center justify-center gap-0.5 text-[10px] font-semibold uppercase tracking-wider ${
              n ? 'border-l border-line' : ''
            } ${tab === id ? 'bg-brand text-white' : 'text-muted hover:bg-subtle hover:text-fg'}`}
          >
            <Icon size={15} strokeWidth={1.5} />
            {label}
          </button>
        ))}
      </div>
    </nav>
  );
}

/* ------------------------------------------------------------------------ */
/* Layers                                                                    */
/* ------------------------------------------------------------------------ */

function LayersTab({ activeLayers, onToggleLayer, onSetLayers, overlayOpacity, onOpacity, onInfo, onTab }: SidebarProps) {
  const [filter, setFilter] = useState('');
  const [activeOnly, setActiveOnly] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({ 'extent-present': true });
  const active = new Set(activeLayers);
  const f = filter.trim().toLowerCase();

  const groups = LAYER_GROUPS.map((g) => ({
    ...g,
    layers: g.layers.filter(
      (l) =>
        (!activeOnly || active.has(l.id)) &&
        (!f || l.title.toLowerCase().includes(f) || g.title.toLowerCase().includes(f)),
    ),
  })).filter((g) => g.layers.length > 0);

  return (
    <div>
      <SectionHeader title="Map Layers" />
      <div className="space-y-2 border-b border-line px-3 pb-3">
        <label className="flex h-8 items-center gap-2 border border-line bg-canvas px-2 text-muted focus-within:border-brand">
          <Search size={13} strokeWidth={1.5} />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter layers"
            className="w-full bg-transparent text-[12px] text-fg outline-none placeholder:text-muted"
          />
        </label>
        <div className="flex items-center justify-between">
          <div className="flex h-7 border border-line text-[11px] font-medium">
            <button
              type="button"
              onClick={() => setActiveOnly(false)}
              className={`px-2.5 ${!activeOnly ? 'bg-brand text-white' : 'text-muted hover:text-fg'}`}
            >
              All Layers
            </button>
            <button
              type="button"
              onClick={() => setActiveOnly(true)}
              className={`border-l border-line px-2.5 ${activeOnly ? 'bg-brand text-white' : 'text-muted hover:text-fg'}`}
            >
              Active ({activeLayers.length})
            </button>
          </div>
          <button
            type="button"
            onClick={() => onSetLayers([])}
            className="text-[11px] font-medium text-brandred hover:underline"
          >
            Clear all
          </button>
        </div>
        <label className="flex items-center gap-3 text-[11px] text-muted">
          <span className="shrink-0">Overlay opacity</span>
          <input
            type="range"
            min={0.2}
            max={1}
            step={0.05}
            value={overlayOpacity}
            onChange={(e) => onOpacity(Number(e.target.value))}
            className="sim-range"
            style={{ '--pct': `calc(6px + (100% - 12px) * ${(overlayOpacity - 0.2) / 0.8})`, '--fill': 'rgb(var(--c-brand))' } as React.CSSProperties}
          />
          <span className="tnum w-8 text-right font-mono text-fg">{Math.round(overlayOpacity * 100)}%</span>
        </label>
      </div>

      <ul>
        {groups.map((g) => {
          const isOpen = open[g.id] ?? (f !== '' || activeOnly);
          const count = g.layers.filter((l) => active.has(l.id)).length;
          return (
            <li key={g.id} className="border-b border-line">
              <button
                type="button"
                onClick={() => setOpen((o) => ({ ...o, [g.id]: !isOpen }))}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-subtle"
                aria-expanded={isOpen}
              >
                {isOpen ? (
                  <ChevronDown size={14} strokeWidth={1.5} className="shrink-0 text-muted" />
                ) : (
                  <ChevronRight size={14} strokeWidth={1.5} className="shrink-0 text-muted" />
                )}
                <span className="flex-1 text-[12px] font-semibold text-fg">{g.title}</span>
                {count > 0 && (
                  <span className="tnum border border-brand/40 px-1.5 font-mono text-[10px] text-brand">{count}</span>
                )}
              </button>
              {isOpen && (
                <ul className="pb-2">
                  {g.layers.map((l) => {
                    const on = active.has(l.id);
                    return (
                      <li key={l.id} className="px-3 py-1">
                        <div className="flex items-start gap-2 pl-5">
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={on}
                            onClick={() => onToggleLayer(l.id)}
                            className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center border ${
                              on ? 'border-brand bg-brand' : 'border-muted/60 bg-panel'
                            }`}
                          >
                            {on && (
                              <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden>
                                <path d="M1.5 5.2 L4 7.6 L8.5 2.6" fill="none" stroke="white" strokeWidth="1.6" />
                              </svg>
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => onToggleLayer(l.id)}
                            className="flex-1 text-left text-[12px] leading-4 text-fg"
                          >
                            {l.title}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              onInfo(l.id);
                              onTab('info');
                            }}
                            className="text-muted hover:text-brand"
                            aria-label={`About ${l.title}`}
                            title="Layer information"
                          >
                            <Info size={13} strokeWidth={1.5} />
                          </button>
                        </div>
                        {on && (
                          <ul className="ml-[42px] mt-1 space-y-0.5">
                            {l.legend.slice(0, 6).map((item) => (
                              <LegendSwatch key={item.label} item={item} />
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Tools                                                                     */
/* ------------------------------------------------------------------------ */

function ToolsTab({ query, onClearQuery, depths, elev, field, buildings, exposure }: SidebarProps) {
  const [scenario, setScenario] = useState<ClimateScenario>('present');

  const report = useMemo(() => {
    if (!query) return null;
    const { x, z } = query;
    const wx = (x / EXTENT_M) * 160;
    const wz = (z / EXTENT_M) * 160;
    const { lat, lon } = worldToLatLon(wx, wz);
    const k = worldToIndex(wx, wz);
    const depthRows = CLIMATE_SCENARIOS.map((c) => ({
      scenario: c,
      values: PROBABILITIES.map((p) => sampleRaster(depths[`${p.id}:${c.id}`], x, z)),
    }));
    const nearbyBuildings = buildings.filter((b) => distance(b.x, b.z, x, z) <= 500);
    const nearbyAtRisk = nearbyBuildings.filter((b) => buildingFloodClass(depths, b, 'present') !== null).length;
    const events = PAST_EVENTS.map((e) => ({ e, d: distance(e.x, e.z, x, z) }))
      .filter((v) => v.d <= 2500)
      .sort((a, b) => a.d - b.d);
    return {
      lat,
      lon,
      easting: x + HALF,
      northing: HALF - z,
      elevation: sampleRaster(elev, x, z) + DATUM_ASL_M,
      slope: field.slope[k],
      risk: field.risk[k],
      depthRows,
      nearbyBuildings: nearbyBuildings.length,
      nearbyAtRisk,
      events,
    };
  }, [query, depths, elev, field, buildings]);

  const exportCsv = () => {
    if (!report) return;
    const lines = [
      ['Pahiro Guard – Local Area Summary Report'],
      ['Latitude', report.lat.toFixed(6)],
      ['Longitude', report.lon.toFixed(6)],
      ['Ground elevation (m ASL)', report.elevation.toFixed(1)],
      ['Local slope (deg)', report.slope.toFixed(1)],
      ['Composite landslide risk (%)', (report.risk * 100).toFixed(1)],
      [],
      ['Scenario', ...PROBABILITIES.map((p) => `Depth ${p.aep} (m)`)],
      ...report.depthRows.map((r) => [r.scenario.label, ...r.values.map((v) => v.toFixed(2))]),
      [],
      ['Buildings within 500 m', String(report.nearbyBuildings)],
      ['…of which in a present-day flood extent', String(report.nearbyAtRisk)],
      [],
      ['Past events within 2.5 km', 'Type', 'Date', 'Distance (m)'],
      ...report.events.map(({ e, d }) => [e.id, e.type, e.date, d.toFixed(0)]),
    ];
    const csv = lines.map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `pahiro-guard-report-${report.lat.toFixed(4)}_${report.lon.toFixed(4)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const rows = exposure.filter((r) => r.scenario === scenario);

  return (
    <div>
      <SectionHeader title="Local Area Summary Report" />
      <div className="border-b border-line px-3 pb-3">
        {!report ? (
          <div className="flex gap-2 border border-dashed border-line p-3 text-[12px] text-muted">
            <MapPin size={15} strokeWidth={1.5} className="mt-0.5 shrink-0 text-brandred" />
            <p>
              Click any location on the <span className="font-medium text-fg">2D map</span> to generate a summary of
              flood depths, slope instability and past flood events within 2.5 km.
            </p>
          </div>
        ) : (
          <div className="space-y-3 text-[12px]">
            <dl className="grid grid-cols-[1fr_auto] gap-y-1 font-mono text-[11px]">
              <dt className="text-muted">Location</dt>
              <dd className="tnum text-right text-fg">
                {report.lat.toFixed(5)}°N {report.lon.toFixed(5)}°E
              </dd>
              <dt className="text-muted">Local grid E / N</dt>
              <dd className="tnum text-right text-fg">
                {report.easting.toFixed(0)} / {report.northing.toFixed(0)} m
              </dd>
              <dt className="text-muted">Ground elevation</dt>
              <dd className="tnum text-right text-fg">{report.elevation.toFixed(1)} m ASL</dd>
              <dt className="text-muted">Local slope</dt>
              <dd className="tnum text-right text-fg">{report.slope.toFixed(1)}°</dd>
              <dt className="text-muted">Landslide risk (live)</dt>
              <dd
                className={`tnum text-right font-semibold ${
                  report.risk >= THRESHOLDS.critical ? 'text-crit' : report.risk >= THRESHOLDS.warning ? 'text-warnink' : 'text-safe'
                }`}
              >
                {(report.risk * 100).toFixed(1)}%
              </dd>
            </dl>

            <div>
              <div className="mb-1 text-[11px] font-semibold text-fg">Modelled flood depth at point (m)</div>
              <table className="w-full border border-line font-mono text-[11px]">
                <thead className="bg-subtle text-muted">
                  <tr>
                    <th className="px-2 py-1 text-left font-medium">Scenario</th>
                    {PROBABILITIES.map((p) => (
                      <th key={p.id} className="px-2 py-1 text-right font-medium">
                        {p.aep.replace(' AEP', '')}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.depthRows.map((r) => (
                    <tr key={r.scenario.id} className="border-t border-line">
                      <td className="px-2 py-1 font-sans text-fg">{r.scenario.short}</td>
                      {r.values.map((v, n) => (
                        <td key={n} className={`tnum px-2 py-1 text-right ${v > 0 ? 'font-semibold text-brand' : 'text-muted'}`}>
                          {v > 0 ? v.toFixed(2) : '—'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="font-mono text-[11px]">
              <div className="flex justify-between">
                <span className="text-muted">Buildings within 500 m</span>
                <span className="tnum text-fg">{report.nearbyBuildings}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">…in present-day flood extent</span>
                <span className={`tnum ${report.nearbyAtRisk ? 'text-crit' : 'text-fg'}`}>{report.nearbyAtRisk}</span>
              </div>
            </div>

            <div>
              <div className="mb-1 text-[11px] font-semibold text-fg">
                Past flood events within 2.5 km ({report.events.length})
              </div>
              {report.events.length === 0 ? (
                <p className="text-[11px] text-muted">No recorded events.</p>
              ) : (
                <ul className="divide-y divide-line border border-line">
                  {report.events.map(({ e, d }) => (
                    <li key={e.id} className="px-2 py-1.5 text-[11px]">
                      <div className="flex justify-between font-mono">
                        <span className="text-fg">
                          {e.id} · {e.date}
                        </span>
                        <span className="tnum text-muted">{(d / 1000).toFixed(2)} km</span>
                      </div>
                      <div className="text-muted">{e.description}</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={exportCsv}
                className="flex h-8 flex-1 items-center justify-center gap-1.5 bg-brand text-[11px] font-semibold text-white hover:bg-brand/90"
              >
                <Download size={13} strokeWidth={1.5} /> Export CSV
              </button>
              <button
                type="button"
                onClick={onClearQuery}
                className="flex h-8 items-center gap-1.5 border border-line px-3 text-[11px] font-medium text-muted hover:text-fg"
              >
                <X size={13} strokeWidth={1.5} /> Clear
              </button>
            </div>
          </div>
        )}
      </div>

      <SectionHeader title="Exposure Summary" />
      <div className="px-3 pb-4">
        <div className="mb-2 flex h-7 border border-line text-[11px] font-medium">
          {CLIMATE_SCENARIOS.map((c, n) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setScenario(c.id)}
              className={`flex-1 ${n ? 'border-l border-line' : ''} ${
                scenario === c.id ? 'bg-brand text-white' : 'text-muted hover:text-fg'
              }`}
            >
              {c.short}
            </button>
          ))}
        </div>
        <table className="w-full border border-line font-mono text-[11px]">
          <thead className="bg-subtle text-muted">
            <tr>
              <th className="px-2 py-1 text-left font-medium">Event</th>
              <th className="px-2 py-1 text-right font-medium">Area km²</th>
              <th className="px-2 py-1 text-right font-medium">Bldgs</th>
              <th className="px-2 py-1 text-right font-medium">People</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const p = PROBABILITIES.find((x) => x.id === r.probability)!;
              return (
                <tr key={r.probability} className="border-t border-line">
                  <td className="px-2 py-1 text-fg">{p.aep}</td>
                  <td className="tnum px-2 py-1 text-right text-fg">{r.areaKm2.toFixed(2)}</td>
                  <td className={`tnum px-2 py-1 text-right ${r.buildings ? 'text-crit' : 'text-fg'}`}>{r.buildings}</td>
                  <td className="tnum px-2 py-1 text-right text-fg">{r.persons}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="mt-2 text-[10px] leading-4 text-muted">
          {CLIMATE_SCENARIOS.find((c) => c.id === scenario)!.note} Buildings counted where depth &gt; 0.05 m; people
          estimated at 2.4 per dwelling. Raster resolution {RES_CELL_M.toFixed(1)} m.
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Info                                                                      */
/* ------------------------------------------------------------------------ */

function InfoTab({ infoLayerId }: SidebarProps) {
  const layer = infoLayerId ? findLayer(infoLayerId) : undefined;
  const group = LAYER_GROUPS.find((g) => g.layers.some((l) => l.id === infoLayerId));
  return (
    <div>
      <SectionHeader title="Layer Information" />
      <div className="px-3 pb-4 text-[12px]">
        {!layer ? (
          <p className="border border-dashed border-line p-3 text-muted">
            Select the <Info size={12} strokeWidth={1.5} className="inline" /> icon beside a layer in the Layers tab to
            view its metadata.
          </p>
        ) : (
          <div className="space-y-3">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted">{group?.title}</div>
              <h3 className="text-[14px] font-semibold text-fg">{layer.title}</h3>
            </div>
            <p className="leading-5 text-fg">{layer.description}</p>
            <div>
              <div className="mb-1 text-[11px] font-semibold text-fg">Legend</div>
              <ul className="space-y-0.5">
                {layer.legend.map((item) => (
                  <LegendSwatch key={item.label} item={item} />
                ))}
              </ul>
            </div>
            <dl className="grid grid-cols-[110px_1fr] gap-y-1 border-t border-line pt-2 font-mono text-[11px]">
              <dt className="text-muted">Layer queryable</dt>
              <dd className="text-fg">{layer.queryable ? 'Yes' : 'No'}</dd>
              <dt className="text-muted">Source</dt>
              <dd className="text-fg">Pahiro Guard synthetic model (offline)</dd>
              <dt className="text-muted">Resolution</dt>
              <dd className="tnum text-fg">{RES_CELL_M.toFixed(1)} m raster</dd>
              <dt className="text-muted">Reference</dt>
              <dd className="text-fg">WGS84, illustrative extent</dd>
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="px-3 pb-2 pt-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-brand">{title}</div>
  );
}
