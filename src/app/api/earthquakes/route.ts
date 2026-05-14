import { NextResponse } from 'next/server';

/**
 * OSIRIS — Combined Earthquake Data API
 * Fetches USGS (global, M2.5+) and EMSC (M2+, finer EU/Med coverage)
 * and deduplicates by spatio-temporal proximity (< 50km, < 5min).
 * EMSC preferred inside the Europe/Mediterranean bbox; USGS elsewhere.
 * No API key required.
 */

const EU_BBOX = { minLat: 25, maxLat: 72, minLng: -30, maxLng: 50 };

type Quake = {
  id: string;
  source: 'USGS' | 'EMSC';
  source_id: string;
  lat: number;
  lng: number;
  depth: number;
  magnitude: number;
  place: string;
  time: number;
  url: string;
};

function inEurope(lat: number, lng: number) {
  return lat >= EU_BBOX.minLat && lat <= EU_BBOX.maxLat && lng >= EU_BBOX.minLng && lng <= EU_BBOX.maxLng;
}

function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const midLat = (lat1 + lat2) / 2;
  const dy = (lat1 - lat2) * 111;
  const dx = (lng1 - lng2) * 111 * Math.cos((midLat * Math.PI) / 180);
  return Math.sqrt(dx * dx + dy * dy);
}

async function fetchUSGS(): Promise<Quake[]> {
  const url = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson';
  const res = await fetch(url, { signal: AbortSignal.timeout(10000), next: { revalidate: 300 } });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.features || [])
    .map((f: any): Quake | null => {
      const [lng, lat, depth] = f.geometry?.coordinates || [0, 0, 0];
      const p = f.properties || {};
      if (typeof lat !== 'number' || typeof lng !== 'number' || typeof p.mag !== 'number') return null;
      return {
        id: f.id,
        source: 'USGS',
        source_id: f.id,
        lat,
        lng,
        depth: Math.abs(depth ?? 0),
        magnitude: p.mag,
        place: p.place || 'Unknown',
        time: p.time || 0,
        url: p.url || `https://earthquake.usgs.gov/earthquakes/eventpage/${f.id}`,
      };
    })
    .filter((q: Quake | null): q is Quake => q !== null);
}

async function fetchEMSC(): Promise<Quake[]> {
  const start = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const url = `https://www.seismicportal.eu/fdsnws/event/1/query?limit=500&format=json&minmag=2&orderby=time&start=${encodeURIComponent(start)}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    headers: { Accept: 'application/json' },
    next: { revalidate: 300 },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.features || [])
    .map((f: any): Quake | null => {
      const [lng, lat, depth] = f.geometry?.coordinates || [0, 0, 0];
      const p = f.properties || {};
      const unid = p.unid || f.id;
      if (typeof lat !== 'number' || typeof lng !== 'number' || typeof p.mag !== 'number') return null;
      return {
        id: `emsc-${unid}`,
        source: 'EMSC',
        source_id: unid,
        lat,
        lng,
        depth: Math.abs(depth ?? p.depth ?? 0),
        magnitude: p.mag,
        place: p.flynn_region || 'Unknown region',
        time: p.time ? Date.parse(p.time) : 0,
        url: `https://www.seismicportal.eu/eventdetails.html?unid=${unid}`,
      };
    })
    .filter((q: Quake | null): q is Quake => q !== null);
}

// Priority: EMSC inside Europe > USGS > EMSC outside Europe.
// Lower number = higher priority (kept first when duplicates collide).
function priority(q: Quake): number {
  if (q.source === 'EMSC' && inEurope(q.lat, q.lng)) return 0;
  if (q.source === 'USGS') return 1;
  return 2;
}

function dedupe(quakes: Quake[]): Quake[] {
  const sorted = [...quakes].sort((a, b) => priority(a) - priority(b));
  const kept: Quake[] = [];
  for (const q of sorted) {
    const dup = kept.find(
      (k) => distanceKm(k.lat, k.lng, q.lat, q.lng) < 50 && Math.abs(k.time - q.time) < 5 * 60 * 1000
    );
    if (!dup) kept.push(q);
  }
  return kept;
}

export async function GET() {
  try {
    const [usgs, emsc] = await Promise.allSettled([fetchUSGS(), fetchEMSC()]);
    const usgsList = usgs.status === 'fulfilled' ? usgs.value : [];
    const emscList = emsc.status === 'fulfilled' ? emsc.value : [];
    const earthquakes = dedupe([...usgsList, ...emscList]);

    return NextResponse.json(
      {
        earthquakes,
        total: earthquakes.length,
        sources: {
          usgs: usgsList.length,
          emsc: emscList.length,
          merged: earthquakes.length,
        },
        timestamp: new Date().toISOString(),
      },
      {
        headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
      }
    );
  } catch (error) {
    console.error('Earthquake fetch error:', error);
    return NextResponse.json(
      { earthquakes: [], error: 'Failed to fetch earthquake data' },
      { status: 500 }
    );
  }
}
