import { NextResponse } from 'next/server';

/**
 * OSIRIS — Severe Weather & Natural Disasters API
 * Aggregates:
 *   - NASA EONET (severe storms, volcanoes, sea ice)
 *   - GDACS (global disaster alerts — cyclones, floods, droughts, volcanoes)
 * USGS earthquakes and NASA FIRMS wildfires are tracked by dedicated routes
 * and skipped here to avoid duplicate markers.
 */

interface WeatherEvent {
  id: string;
  title: string;
  category: string;
  type: string;
  icon: string;
  severity: 'low' | 'medium' | 'high';
  lat: number;
  lng: number;
  date: string;
  source: string;
}

const FETCH_TIMEOUT = 12_000;

async function fetchEONET(): Promise<WeatherEvent[]> {
  const res = await fetch('https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=100', {
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
    next: { revalidate: 1800 },
  });
  if (!res.ok) throw new Error(`EONET ${res.status}`);
  const data = await res.json();
  const out: WeatherEvent[] = [];
  for (const event of (data.events || []) as Array<Record<string, unknown>>) {
    const geomArr = event.geometry as Array<Record<string, unknown>> | undefined;
    const geom = geomArr && geomArr.length > 0 ? geomArr[geomArr.length - 1] : null;
    if (!geom || geom.type !== 'Point') continue;
    const coords = geom.coordinates as [number, number] | undefined;
    if (!coords) continue;
    const categories = event.categories as Array<Record<string, unknown>> | undefined;
    const category = String(categories?.[0]?.id ?? 'unknown');
    if (category === 'wildfires' || category === 'earthquakes') continue;

    let typeLabel = 'Event', icon = 'alert', severity: WeatherEvent['severity'] = 'low';
    if (category === 'severeStorms') { typeLabel = 'Severe Storm'; icon = 'cyclone'; severity = 'high'; }
    else if (category === 'volcanoes') { typeLabel = 'Volcano Eruption'; icon = 'volcano'; severity = 'high'; }
    else if (category === 'seaIce') { typeLabel = 'Iceberg / Sea Ice'; icon = 'ice'; severity = 'medium'; }
    else typeLabel = String(categories?.[0]?.title ?? 'Anomaly');

    const sources = event.sources as Array<Record<string, unknown>> | undefined;
    out.push({
      id: String(event.id ?? ''),
      title: String(event.title ?? ''),
      category,
      type: typeLabel,
      icon,
      severity,
      lat: coords[1],
      lng: coords[0],
      date: String(geom.date ?? ''),
      source: String(sources?.[0]?.url ?? 'NASA EONET'),
    });
  }
  return out;
}

// GDACS event-type code → label/icon/severity baseline. Severity is upgraded based on alertlevel.
const GDACS_TYPE: Record<string, { label: string; icon: string }> = {
  TC: { label: 'Tropical Cyclone', icon: 'cyclone' },
  FL: { label: 'Flood', icon: 'flood' },
  VO: { label: 'Volcano', icon: 'volcano' },
  DR: { label: 'Drought', icon: 'drought' },
  TS: { label: 'Tsunami', icon: 'cyclone' },
};

function gdacsSeverity(alertLevel: string): WeatherEvent['severity'] {
  const lvl = alertLevel.toLowerCase();
  if (lvl === 'red') return 'high';
  if (lvl === 'orange') return 'medium';
  return 'low';
}

function extractTag(xml: string, tag: string): string {
  // Matches both <tag>X</tag> and <ns:tag>X</ns:tag>; tag is regex-safe (caller controls).
  // Case-sensitive on purpose — GDACS uses <georss:point> for coords but <geo:Point>
  // for a container, and an `i` flag would let `point` match the empty <geo:Point>.
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`);
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

async function fetchGDACS(): Promise<WeatherEvent[]> {
  const res = await fetch('https://www.gdacs.org/xml/rss.xml', {
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OSIRIS/1.0)' },
  });
  if (!res.ok) throw new Error(`GDACS ${res.status}`);
  const xml = await res.text();
  const out: WeatherEvent[] = [];
  // Split items: <item>...</item>
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const item = m[1];
    const eventtype = extractTag(item, 'eventtype');
    // EQ handled by USGS, WF by FIRMS — skip to avoid duplicates
    if (eventtype === 'EQ' || eventtype === 'WF') continue;
    const point = extractTag(item, 'point');           // "lat lng" (space-separated)
    if (!point) continue;
    const parts = point.split(/\s+/).map(Number);
    if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) continue;
    const [lat, lng] = parts;
    const meta = GDACS_TYPE[eventtype];
    if (!meta) continue;
    const alertLevel = extractTag(item, 'alertlevel');
    out.push({
      id: `gdacs-${extractTag(item, 'eventid') || extractTag(item, 'guid')}`,
      title: extractTag(item, 'title').replace(/^[^<]*?<!\[CDATA\[/, '').replace(/\]\]>$/, ''),
      category: eventtype,
      type: meta.label,
      icon: meta.icon,
      severity: gdacsSeverity(alertLevel),
      lat, lng,
      date: extractTag(item, 'pubDate'),
      source: extractTag(item, 'link') || 'https://www.gdacs.org/',
    });
  }
  return out;
}

export async function GET() {
  const settled = await Promise.allSettled([fetchEONET(), fetchGDACS()]);
  const events: WeatherEvent[] = [];
  const sources: Record<string, { ok: boolean; count: number; error?: string }> = {};
  const labels = ['eonet', 'gdacs'] as const;
  settled.forEach((r, i) => {
    const key = labels[i];
    if (r.status === 'fulfilled') {
      events.push(...r.value);
      sources[key] = { ok: true, count: r.value.length };
    } else {
      const reason = r.reason as { message?: string } | string;
      const message = typeof reason === 'string' ? reason : reason?.message ?? 'unknown';
      sources[key] = { ok: false, count: 0, error: message };
    }
  });

  return NextResponse.json({
    events,
    total: events.length,
    sources,
    timestamp: new Date().toISOString(),
  });
}
