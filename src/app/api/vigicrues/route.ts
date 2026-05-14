import { NextResponse } from 'next/server';

/**
 * OSIRIS — Vigicrues Flood Vigilance API (France)
 * Fetches the official French flood-vigilance GeoJSON feed.
 * Each feature is a river section (MultiLineString) with a current vigilance level:
 *   NivInfViCr: 1=green, 2=yellow, 3=orange, 4=red
 * Source: https://www.vigicrues.gouv.fr — public, no API key required.
 */

const LEVEL_COLOR: Record<number, string> = {
  1: '#00E676', // green
  2: '#FFD700', // yellow
  3: '#FF9500', // orange
  4: '#FF1744', // red
};

const LEVEL_LABEL: Record<number, string> = {
  1: 'VERT',
  2: 'JAUNE',
  3: 'ORANGE',
  4: 'ROUGE',
};

// Round coords to 4 decimals (~11m precision) to roughly halve payload size.
// The raw feed is ~3MB; Next.js refuses to cache >2MB items, so we also disable
// the Next data-cache layer and rely on edge HTTP caching via Cache-Control.
function roundCoords(c: any): any {
  if (typeof c[0] === 'number') {
    return [Math.round(c[0] * 10000) / 10000, Math.round(c[1] * 10000) / 10000];
  }
  return c.map(roundCoords);
}

export async function GET() {
  try {
    const url = 'https://www.vigicrues.gouv.fr/services/1/InfoVigiCru.geojson';
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });

    if (!res.ok) {
      return NextResponse.json({ features: [], error: 'Vigicrues unavailable' });
    }

    const data = await res.json();
    const features = (data.features || [])
      .map((f: any) => {
        const p = f.properties || {};
        const level = typeof p.NivInfViCr === 'number' ? p.NivInfViCr : 1;
        const cdEnt = p.CdEntCru || p.cdint || p.id || '';
        return {
          type: 'Feature' as const,
          geometry: f.geometry && f.geometry.coordinates
            ? { ...f.geometry, coordinates: roundCoords(f.geometry.coordinates) }
            : f.geometry,
          properties: {
            id: p.id || cdEnt,
            name: p.lbentcru || 'Tronçon',
            level,
            level_label: LEVEL_LABEL[level] || 'INCONNU',
            color: LEVEL_COLOR[level] || '#00E676',
            status: p.stentcru || '',
            code: cdEnt,
            updated: p.dhmentcru || p.dhcentcru || '',
          },
        };
      })
      .filter(
        (f: any) =>
          f.geometry &&
          (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString') &&
          f.properties.level >= 2,
      );

    const counts = features.reduce(
      (acc: Record<string, number>, f: any) => {
        acc[f.properties.level_label] = (acc[f.properties.level_label] || 0) + 1;
        return acc;
      },
      {}
    );

    return NextResponse.json(
      {
        features,
        total: features.length,
        counts,
        timestamp: new Date().toISOString(),
      },
      {
        headers: { 'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1200' },
      }
    );
  } catch (error) {
    console.error('Vigicrues fetch error:', error);
    return NextResponse.json(
      { features: [], error: 'Failed to fetch Vigicrues data' },
      { status: 500 }
    );
  }
}
