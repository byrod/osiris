import { NextResponse } from 'next/server';

/**
 * OSIRIS — Météo-France Vigilance API (France)
 * Combines:
 *  - Opendatasoft public mirror of Météo-France vigilance (no token)
 *  - geo.api.gouv.fr for department centroids (no token)
 * Only departments with active vigilance level >= 2 (yellow/orange/red) are returned.
 * Phenomena are aggregated by department; the max level drives the marker color.
 */

const LEVEL_COLOR: Record<number, string> = {
  1: '#00E676',
  2: '#FFD700',
  3: '#FF9500',
  4: '#FF1744',
};

const LEVEL_LABEL: Record<number, string> = {
  1: 'VERT',
  2: 'JAUNE',
  3: 'ORANGE',
  4: 'ROUGE',
};

type Alert = {
  domain_id: string;
  phenomenon: string;
  color_id: number;
  begin_time: string;
  end_time: string;
  echeance: string;
};

type Dept = { code: string; nom: string; lng: number; lat: number };

async function fetchAlerts(): Promise<Alert[]> {
  const url =
    'https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/weatherref-france-vigilance-meteo-departement/records?limit=1100';
  const res = await fetch(url, { signal: AbortSignal.timeout(15000), cache: 'no-store' });
  if (!res.ok) return [];
  const data = await res.json();
  return data.results || [];
}

async function fetchDepartements(): Promise<Dept[]> {
  const url = 'https://geo.api.gouv.fr/departements?fields=nom,code,centre&format=geojson';
  const res = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    next: { revalidate: 86400 }, // dept boundaries never change
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.features || []).map((f: any) => ({
    code: f.properties.code,
    nom: f.properties.nom,
    lng: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
  }));
}

// Opendatasoft encodes domain_id as a 4-char code where the first 2 are the
// dept code (e.g. "3410" = Hérault). DOM and Corse may use other prefixes.
// We try a direct match first, then a 2-char prefix fallback.
function resolveDept(domainId: string, deptMap: Map<string, Dept>): Dept | undefined {
  if (deptMap.has(domainId)) return deptMap.get(domainId);
  if (domainId.length >= 2) {
    const prefix = domainId.slice(0, 2);
    if (deptMap.has(prefix)) return deptMap.get(prefix);
    // pad leading zero for departments 1-9
    const padded = String(parseInt(prefix, 10)).padStart(2, '0');
    if (deptMap.has(padded)) return deptMap.get(padded);
  }
  return undefined;
}

export async function GET() {
  try {
    const [alertsRes, deptsRes] = await Promise.allSettled([fetchAlerts(), fetchDepartements()]);
    const alerts = alertsRes.status === 'fulfilled' ? alertsRes.value : [];
    const depts = deptsRes.status === 'fulfilled' ? deptsRes.value : [];

    const deptMap = new Map(depts.map((d) => [d.code, d]));

    type Group = { dept: Dept; phenomena: { name: string; level: number }[]; maxLevel: number };
    const grouped = new Map<string, Group>();

    for (const a of alerts) {
      if (a.echeance !== 'J') continue;       // today only
      if (a.color_id < 2) continue;            // skip green
      if (a.domain_id === 'FRA') continue;     // skip national rollup

      const dept = resolveDept(a.domain_id, deptMap);
      if (!dept) continue;

      const existing = grouped.get(dept.code) || { dept, phenomena: [], maxLevel: 0 };
      existing.phenomena.push({ name: a.phenomenon, level: a.color_id });
      existing.maxLevel = Math.max(existing.maxLevel, a.color_id);
      grouped.set(dept.code, existing);
    }

    const out = Array.from(grouped.values()).map((g) => ({
      id: `meteo-${g.dept.code}`,
      code: g.dept.code,
      name: g.dept.nom,
      lat: g.dept.lat,
      lng: g.dept.lng,
      level: g.maxLevel,
      level_label: LEVEL_LABEL[g.maxLevel] || 'VERT',
      color: LEVEL_COLOR[g.maxLevel] || '#00E676',
      phenomena: g.phenomena,
    }));

    return NextResponse.json(
      {
        alerts: out,
        total: out.length,
        timestamp: new Date().toISOString(),
      },
      {
        headers: { 'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=1800' },
      },
    );
  } catch (error) {
    console.error('Vigilance Météo error:', error);
    return NextResponse.json(
      { alerts: [], error: 'Failed to fetch vigilance data' },
      { status: 500 },
    );
  }
}
