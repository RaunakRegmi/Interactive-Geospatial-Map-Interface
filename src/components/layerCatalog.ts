import { CLIMATE_SCENARIOS, PROBABILITIES, type ClimateScenario, type Probability } from '../engine/floodModel';

export type LegendItem = { color: string; label: string; shape?: 'fill' | 'line' | 'circle' | 'diamond' | 'square' };

export interface LayerDef {
  id: string;
  title: string;
  description: string;
  legend: LegendItem[];
  queryable: boolean;
}

export interface LayerGroup {
  id: string;
  title: string;
  layers: LayerDef[];
}

export type Basemap = 'topographic' | 'imagery' | 'monochrome';

/** Flood extent fills (darker = more frequent). */
export const EXTENT_COLORS: Record<Probability, string> = {
  high: '#1E3A8A',
  medium: '#2563EB',
  low: '#93C5FD',
};

export const DEPTH_RAMP: { max: number; color: string; label: string }[] = [
  { max: 0.5, color: '#DBEAFE', label: '0.0 – 0.5 m' },
  { max: 1.0, color: '#93C5FD', label: '0.5 – 1.0 m' },
  { max: 1.5, color: '#60A5FA', label: '1.0 – 1.5 m' },
  { max: 2.0, color: '#3B82F6', label: '1.5 – 2.0 m' },
  { max: 3.0, color: '#1D4ED8', label: '2.0 – 3.0 m' },
  { max: Infinity, color: '#172554', label: '> 3.0 m' },
];

export const BUILDING_COLORS = {
  high: '#DC2626',
  medium: '#F97316',
  low: '#EAB308',
  none: '#94A3B8',
} as const;

const AEP_TEXT =
  'Annual Exceedance Probability (AEP) is the chance of a flood of this size or larger occurring in any given year. ' +
  'High = 10% AEP (1-in-10), Medium = 1% AEP (1-in-100), Low = 0.1% AEP (1-in-1,000).';

const extentLayer = (c: ClimateScenario, p: Probability): LayerDef => {
  const prob = PROBABILITIES.find((x) => x.id === p)!;
  const scen = CLIMATE_SCENARIOS.find((x) => x.id === c)!;
  return {
    id: `extent:${c}:${p}`,
    title: `River – ${prob.label} (${prob.aep})`,
    description: `Modelled river flood extent for the ${prob.aep} (${prob.returnPeriod}) design event, ${scen.label}. ${scen.note} ${AEP_TEXT}`,
    legend: [{ color: EXTENT_COLORS[p], label: `${prob.aep} extent` }],
    queryable: true,
  };
};

const depthLayer = (c: ClimateScenario, p: Probability): LayerDef => {
  const prob = PROBABILITIES.find((x) => x.id === p)!;
  const scen = CLIMATE_SCENARIOS.find((x) => x.id === c)!;
  return {
    id: `depth:${c}:${p}`,
    title: `River Depth – ${prob.label} (${prob.aep})`,
    description: `Maximum modelled flood depth (m) for the ${prob.aep} design event, ${scen.label}. Depth = design water level − ground level.`,
    legend: DEPTH_RAMP.map((d) => ({ color: d.color, label: d.label })),
    queryable: true,
  };
};

export const LAYER_GROUPS: LayerGroup[] = [
  ...CLIMATE_SCENARIOS.map((c) => ({
    id: `extent-${c.id}`,
    title: `Flood Extents – ${c.label}`,
    layers: PROBABILITIES.map((p) => extentLayer(c.id, p.id)),
  })),
  {
    id: 'depth-present',
    title: 'Flood Depth – Present Day',
    layers: PROBABILITIES.map((p) => depthLayer('present', p.id)),
  },
  {
    id: 'depth-highEnd',
    title: 'Flood Depth – High-End Future Scenario',
    layers: [depthLayer('highEnd', 'medium'), depthLayer('highEnd', 'low')],
  },
  {
    id: 'slope',
    title: 'Slope Instability',
    layers: [
      {
        id: 'landslide',
        title: 'Landslide Susceptibility (live simulation)',
        description:
          'Composite slope-instability and flood risk from the simulation engine, driven by the current rainfall intensity, slope gradient and river level (see 3D Terrain view). Classes: < 50% safe (transparent), 50–74% elevated, ≥ 75% critical.',
        legend: [
          { color: '#EAB308', label: '50–74% Elevated' },
          { color: '#DC2626', label: '≥ 75% Critical' },
        ],
        queryable: true,
      },
    ],
  },
  {
    id: 'past',
    title: 'Past Flood Events',
    layers: [
      {
        id: 'events:single',
        title: 'Single Flood Event',
        description: 'Locations of individually recorded historic flood events (synthetic record).',
        legend: [{ color: '#0EA5E9', label: 'Single event', shape: 'circle' }],
        queryable: true,
      },
      {
        id: 'events:recurring',
        title: 'Recurring Flood Event',
        description: 'Locations where flooding has been recorded on multiple occasions (synthetic record).',
        legend: [{ color: '#7C3AED', label: 'Recurring event', shape: 'diamond' }],
        queryable: true,
      },
    ],
  },
  {
    id: 'exposure',
    title: 'Exposure – Properties at Risk',
    layers: [
      {
        id: 'buildings',
        title: 'Buildings by Flood Probability (Present Day)',
        description:
          'Synthetic building footprints classified by the most frequent present-day design flood that reaches them (> 0.05 m depth).',
        legend: [
          { color: BUILDING_COLORS.high, label: 'Floods at 10% AEP', shape: 'square' },
          { color: BUILDING_COLORS.medium, label: 'Floods at 1% AEP', shape: 'square' },
          { color: BUILDING_COLORS.low, label: 'Floods at 0.1% AEP', shape: 'square' },
          { color: BUILDING_COLORS.none, label: 'Not affected', shape: 'square' },
        ],
        queryable: true,
      },
    ],
  },
  {
    id: 'monitoring',
    title: 'Hydrometric Monitoring',
    layers: [
      {
        id: 'gauges',
        title: 'River Gauge Stations',
        description: 'Water-level gauges reporting the live simulated river stage against the 10.0 m flood stage.',
        legend: [{ color: '#0F766E', label: 'Gauge station', shape: 'square' }],
        queryable: true,
      },
    ],
  },
  {
    id: 'reference',
    title: 'Reference',
    layers: [
      {
        id: 'river',
        title: 'River Centreline',
        description: 'Main channel centreline.',
        legend: [{ color: '#2563EB', label: 'River', shape: 'line' }],
        queryable: false,
      },
      {
        id: 'roads',
        title: 'Road Network',
        description: 'Primary and secondary roads (synthetic).',
        legend: [{ color: '#F59E0B', label: 'Road', shape: 'line' }],
        queryable: false,
      },
      {
        id: 'grid',
        title: '1 km Grid',
        description: 'Local 1 km reference grid.',
        legend: [{ color: '#64748B', label: 'Grid line', shape: 'line' }],
        queryable: false,
      },
    ],
  },
];

export const ALL_LAYERS: LayerDef[] = LAYER_GROUPS.flatMap((g) => g.layers);
export const findLayer = (id: string) => ALL_LAYERS.find((l) => l.id === id);

export const DEFAULT_LAYERS = [
  'extent:present:high',
  'extent:present:medium',
  'extent:present:low',
  'buildings',
  'gauges',
  'events:single',
  'events:recurring',
  'river',
  'roads',
];
