import { NextResponse } from 'next/server';
import { DATA_SOURCES } from '@/lib/api';
import { resolveCentroid } from '@/lib/geo-centroids';

const FETCH_TIMEOUT = 12_000;

type Severity = 'LOW' | 'MODERATE' | 'ELEVATED' | 'HIGH' | 'CRITICAL';

interface EpidemicRecord {
  source: 'CDC' | 'ECDC' | 'WHO' | 'HEALTHMAP';
  disease: string;
  diseases?: string[];
  region: string;
  date: string;
  value: number | null;
  unit?: string;
  severity?: Severity;
  lat?: number;
  lng?: number;
  link?: string;
}

interface SourceStatus {
  ok: boolean;
  count: number;
  error?: string;
}

// Friendly disease label per dataset — keeps the map labels readable instead of showing raw IDs.
// Update when adding new CDC datasets to defaults.
const CDC_DATASET_LABELS: Record<string, string> = {
  'ua7e-t2fy': 'NHSN Respiratory',
  'vjzj-u7u8': 'NSSP ED Respiratory',
  'f3zz-zga5': 'ARI Activity',
  '3cxc-4k8q': 'RSV % Positivity',
  'seuz-s2cv': 'Resp. Pathogen % Positive',
  'ymmh-divb': 'Influenza A Wastewater',
};

async function fetchCDC(dataset: string, limit: number): Promise<EpidemicRecord[]> {
  // Socrata: :id DESC = most recently ingested row first. Combined with a generous limit + post-fetch
  // `since` filter, this surfaces fresh records without needing per-dataset date-field knowledge.
  const url = `${DATA_SOURCES.CDC_SOCRATA}/${dataset}.json?$limit=${limit}&$order=:id DESC`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) throw new Error(`CDC ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('CDC: unexpected payload');
  return rows.map((r: Record<string, unknown>) => normalizeCDC(r, dataset));
}

function normalizeCDC(r: Record<string, unknown>, dataset: string): EpidemicRecord {
  const pick = (...keys: string[]): unknown => {
    for (const k of keys) if (r[k] != null && r[k] !== '') return r[k];
    return undefined;
  };
  const dateRaw = pick(
    'week_end', 'week_end_date', 'weekenddate', 'week_ending_date', 'end_date', 'end_week',
    'start_date', 'date', 'data_as_of', 'submission_date', 'collection_date', 'report_date'
  );
  const regionRaw = pick(
    'geography', 'jurisdiction_of_occurrence', 'jurisdiction', 'state', 'region',
    'sub_jurisdiction', 'state_abbreviation', 'reporting_area', 'res_state'
  );
  const valueRaw = pick(
    'percent_visits', 'percent_positive', 'weekly_rate', 'cumulative_rate',
    'totalconfc19newadm', 'totalconfflunewadm', 'totalconfrsvnewadm',
    'all_cause', 'total_deaths', 'covid_19_deaths', 'cases', 'count', 'value', 'rate'
  );
  const diseaseRaw = pick('pathogen', 'cause_of_death', 'cause', 'indicator', 'virus', 'season_label');
  const labelRaw = pick('label', 'activity_level_label', 'activity_level');

  let value = valueRaw != null ? Number(valueRaw) : null;
  // Some datasets (e.g. ARI activity f3zz-zga5) report a qualitative label instead of a number.
  // Translate to a coarse scale so downstream severity computation has something to work with.
  if ((value == null || !Number.isFinite(value)) && labelRaw) {
    const key = String(labelRaw).trim().toLowerCase();
    const scale: Record<string, number> = {
      'minimal': 1, 'very low': 2, 'low': 3,
      'moderate': 5, 'high': 8, 'very high': 10,
    };
    if (scale[key] != null) value = scale[key];
  }
  const friendlyLabel = CDC_DATASET_LABELS[dataset];
  return {
    source: 'CDC',
    disease: diseaseRaw ? String(diseaseRaw) : (friendlyLabel ?? dataset),
    region: regionRaw ? String(regionRaw) : 'US',
    date: dateRaw ? String(dateRaw) : '',
    value: Number.isFinite(value as number) ? value : null,
    link: `https://data.cdc.gov/d/${dataset}`,
  };
}

async function fetchECDC(): Promise<EpidemicRecord[]> {
  const url = 'https://opendata.ecdc.europa.eu/respiratoryviruses/atlas_data.csv';
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) throw new Error(`ECDC ${res.status}`);
  const text = await res.text();
  return parseECDCCsv(text);
}

function parseECDCCsv(text: string): EpidemicRecord[] {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]).map(h => h.trim().toLowerCase());
  const idx = (name: string) => headers.indexOf(name);
  const iDisease = idx('pathogen') !== -1 ? idx('pathogen') : idx('disease');
  const iRegion = idx('countrycode') !== -1 ? idx('countrycode')
    : idx('countryname') !== -1 ? idx('countryname') : idx('country');
  const iDate = idx('yearweek') !== -1 ? idx('yearweek') : idx('date');
  const iValue = idx('value') !== -1 ? idx('value') : idx('numvalue');
  const iUnit = idx('indicator');

  const out: EpidemicRecord[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    if (cols.length < headers.length / 2) continue;
    const v = iValue >= 0 ? Number(cols[iValue]) : NaN;
    out.push({
      source: 'ECDC',
      disease: iDisease >= 0 ? cols[iDisease] : 'respiratory',
      region: iRegion >= 0 ? cols[iRegion] : 'EU',
      date: iDate >= 0 ? cols[iDate] : '',
      value: Number.isFinite(v) ? v : null,
      unit: iUnit >= 0 ? cols[iUnit] : undefined,
      link: 'https://www.ecdc.europa.eu/en/respiratory-viruses-europe',
    });
  }
  return out;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (c === ',' && !inQuote) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

interface HealthMapMarker {
  lat?: number; lon?: number;
  place_name?: string;
  label?: string;
  alertids?: string[];
  pin?: string;
}

async function fetchHealthMap(days: number): Promise<EpidemicRecord[]> {
  // HealthMap aggregator — Boston Children's Hospital, multi-source outbreak surveillance.
  // Returns markers with lat/lon already resolved + a disease label per cluster.
  // UA required: without it, HealthMap intermittently 403s server-side requests.
  const url = `https://www.healthmap.org/getAlerts.php?days=${Math.max(1, Math.min(days, 60))}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
    cache: 'no-store',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; OSIRIS/1.0; +https://osiris.app)',
      'Accept': 'application/json,text/plain;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en',
    },
  });
  if (!res.ok) throw new Error(`HealthMap ${res.status}`);
  const data = await res.json();
  const markers: HealthMapMarker[] = Array.isArray(data?.markers) ? data.markers : [];
  const todayIso = new Date().toISOString().slice(0, 10);

  // HealthMap encodes the full pathogen list for a cluster in `label` (comma-separated),
  // and `alertids` count is the global total for the cluster — there's no per-disease
  // breakdown in the public endpoint. So we just normalize the list and keep the global count.
  const out: EpidemicRecord[] = [];
  for (const m of markers) {
    if (!Number.isFinite(m.lat) || !Number.isFinite(m.lon)) continue;
    // Label often starts with a leading empty segment ("," then list) — filter falsy and de-dup.
    const diseases = Array.from(new Set(
      String(m.label || '').split(',').map(s => s.trim()).filter(Boolean)
    ));
    const alertCount = Array.isArray(m.alertids) ? m.alertids.length : 0;
    const summary = diseases.length === 0
      ? 'outbreak'
      : diseases.length <= 3
        ? diseases.join(', ')
        : `${diseases.slice(0, 3).join(', ')} +${diseases.length - 3}`;
    out.push({
      source: 'HEALTHMAP',
      disease: summary,
      diseases,
      region: m.place_name || '—',
      date: todayIso,
      value: alertCount || null,
      lat: m.lat as number,
      lng: m.lon as number,
      link: 'https://www.healthmap.org/',
    });
  }
  return out;
}

async function fetchWHO(indicator: string): Promise<EpidemicRecord[]> {
  const url = `${DATA_SOURCES.WHO_GHO}/${encodeURIComponent(indicator)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) throw new Error(`WHO ${res.status}`);
  const data = await res.json();
  const rows: unknown[] = Array.isArray(data?.value) ? data.value : [];
  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    const value = r.NumericValue != null ? Number(r.NumericValue) : null;
    return {
      source: 'WHO' as const,
      disease: indicator,
      region: r.SpatialDim ? String(r.SpatialDim) : 'GLOBAL',
      date: r.TimeDim != null ? String(r.TimeDim) : '',
      value: Number.isFinite(value as number) ? value : null,
      unit: r.Dim1 ? String(r.Dim1) : undefined,
      link: `https://www.who.int/data/gho/indicator-metadata-registry/imr-details/${indicator}`,
    };
  });
}

function severityFromCount(value: number | null): Severity | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  // Heuristic that works for both percentages (% positivity / ED visits) and raw counts.
  // Large absolute counts (>=25) collapse to CRITICAL like high percentages.
  if (value >= 25) return 'CRITICAL';
  if (value >= 10) return 'HIGH';
  if (value >= 3) return 'ELEVATED';
  if (value >= 0.5) return 'MODERATE';
  return 'LOW';
}

/**
 * Parse heterogeneous date strings to epoch ms (UTC). Supports:
 *  - ISO 8601 ("2026-01-12", "2026-01-12T00:00:00.000")
 *  - Year-week ("2025-W42", "2025W42", "202542")
 *  - Plain year ("2025") — treated as Jan 1
 *  Returns null when unparseable.
 */
function parseRecordDate(raw: string): number | null {
  if (!raw) return null;
  const s = raw.trim();
  // ISO date
  const iso = Date.parse(s);
  if (Number.isFinite(iso)) return iso;
  // Year-week: 2025-W42, 2025W42, 202542
  const yw = s.match(/^(\d{4})[-]?W?(\d{1,2})$/i);
  if (yw) {
    const year = parseInt(yw[1], 10);
    const week = parseInt(yw[2], 10);
    if (year >= 1990 && week >= 1 && week <= 53) {
      // ISO week: Jan 4th is always week 1
      const jan4 = Date.UTC(year, 0, 4);
      const jan4Day = new Date(jan4).getUTCDay() || 7;
      return jan4 + (week - 1) * 7 * 86400000 - (jan4Day - 1) * 86400000;
    }
  }
  // Plain year
  if (/^\d{4}$/.test(s)) {
    return Date.UTC(parseInt(s, 10), 0, 1);
  }
  return null;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  // Default CDC datasets — verified active (updated within the last week as of 2026-05).
  // ua7e-t2fy = NHSN respiratory hospital metrics, vjzj-u7u8 = NSSP ED respiratory daily,
  // f3zz-zga5 = ARI activity by state, 3cxc-4k8q = RSV % positivity.
  // Override / extend via ?cdc=<id>,<id>,...
  const cdcParam = searchParams.get('cdc') || 'ua7e-t2fy,vjzj-u7u8,f3zz-zga5,3cxc-4k8q';
  const cdcDatasets = cdcParam.split(',').map(s => s.trim()).filter(Boolean);
  const whoIndicator = searchParams.get('who') || 'MDG_0000000020';
  const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '1000', 10), 1), 5000);
  // ECDC is opt-in: their public CSV endpoints have been deprecated, leaving only the SDMX
  // Surveillance Atlas which needs dedicated parsing. HealthMap provides global outbreak
  // coverage with lat/lng already resolved — it's what makes the map non-US-centric.
  const sourcesParam = searchParams.get('sources');
  const enabled = new Set(
    sourcesParam ? sourcesParam.split(',').map(s => s.trim().toLowerCase()) : ['cdc', 'who', 'healthmap']
  );
  const healthmapDays = Math.min(Math.max(parseInt(searchParams.get('healthmap_days') || '14', 10), 1), 60);
  // Drop records older than `since` (ISO date) or `days` (rolling window). Default: 365 days.
  const sinceParam = searchParams.get('since');
  const days = parseInt(searchParams.get('days') || '365', 10);
  const sinceMs = sinceParam
    ? Date.parse(sinceParam)
    : Date.now() - Math.max(days, 1) * 86400000;

  const empty: EpidemicRecord[] = [];
  const cdcTasks = enabled.has('cdc')
    ? cdcDatasets.map(ds => fetchCDC(ds, limit))
    : [Promise.resolve(empty)];

  const settled = await Promise.allSettled([
    Promise.allSettled(cdcTasks).then(results => {
      const merged: EpidemicRecord[] = [];
      for (const r of results) {
        if (r.status === 'fulfilled') merged.push(...r.value);
      }
      return merged;
    }),
    enabled.has('ecdc')      ? fetchECDC()                    : Promise.resolve(empty),
    enabled.has('who')       ? fetchWHO(whoIndicator)         : Promise.resolve(empty),
    enabled.has('healthmap') ? fetchHealthMap(healthmapDays)  : Promise.resolve(empty),
  ]);

  const labels = ['cdc', 'ecdc', 'who', 'healthmap'] as const;
  const records: EpidemicRecord[] = [];
  const sources: Record<string, SourceStatus> = {};
  let dropped = 0;

  settled.forEach((r, i) => {
    const key = labels[i];
    if (r.status === 'fulfilled') {
      const enriched: EpidemicRecord[] = [];
      for (const rec of r.value) {
        const ts = parseRecordDate(rec.date);
        if (ts == null || ts < sinceMs) { dropped++; continue; }
        // Preserve direct lat/lng when the source already provides them (HealthMap).
        // Only fall back to centroid lookup for region-keyed sources (CDC states, ECDC/WHO ISO codes).
        const hasDirectCoords = Number.isFinite(rec.lat) && Number.isFinite(rec.lng);
        const centroid = hasDirectCoords ? null : resolveCentroid(rec.region);
        enriched.push({
          ...rec,
          severity: severityFromCount(rec.value),
          lat: hasDirectCoords ? rec.lat : (centroid ? centroid[0] : undefined),
          lng: hasDirectCoords ? rec.lng : (centroid ? centroid[1] : undefined),
        });
      }
      records.push(...enriched);
      sources[key] = { ok: true, count: enriched.length };
    } else {
      const reason = r.reason as { message?: string } | string;
      const message = typeof reason === 'string' ? reason : reason?.message ?? 'unknown error';
      sources[key] = { ok: false, count: 0, error: message };
    }
  });

  // Sort most-recent first so the UI surfaces fresh data
  records.sort((a, b) => {
    const ta = parseRecordDate(a.date) ?? 0;
    const tb = parseRecordDate(b.date) ?? 0;
    return tb - ta;
  });

  return NextResponse.json({
    records,
    total: records.length,
    dropped_stale: dropped,
    sources,
    query: {
      cdc: cdcDatasets,
      who: whoIndicator,
      healthmap_days: healthmapDays,
      limit,
      enabled: [...enabled],
      since: new Date(sinceMs).toISOString().slice(0, 10),
    },
    timestamp: new Date().toISOString(),
  }, {
    headers: { 'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1200' },
  });
}
