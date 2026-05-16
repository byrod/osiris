import { NextResponse } from 'next/server';

/**
 * OSIRIS — War Simulator / Kinetic OSINT Feed
 * Fetches real-time GDELT data for kinetic strikes & conflict news pings.
 * Uses geopolitical inference to calculate origin coordinates.
 */

// Geopolitical Inference Engine
function inferOrigin(targetLat: number, targetLng: number): { lat: number; lng: number; name: string } {
  // Iran targets (Lat 25-40, Lng 44-63)
  if (targetLat >= 25.0 && targetLat <= 40.0 && targetLng >= 44.0 && targetLng <= 63.0) {
    return { lat: 31.5, lng: 34.8, name: 'Israel' }; // Assume Israel/US strikes
  }
  // Israel targets
  if (targetLat >= 29.5 && targetLat <= 33.5 && targetLng >= 34.0 && targetLng <= 36.0) {
    if (targetLat > 32.5) return { lat: 33.3, lng: 35.4, name: 'Southern Lebanon' }; // North Israel
    if (targetLat < 30.0) return { lat: 15.3, lng: 44.2, name: 'Yemen (Houthi)' }; // Eilat
    // If not north/south, could be Iran or Gaza. Let's add random chance for Iran.
    if (Math.random() > 0.7) return { lat: 35.6892, lng: 51.3890, name: 'Tehran (Iran)' };
    return { lat: 31.5, lng: 34.4, name: 'Gaza Strip' }; // Central/South Israel
  }
  // Lebanon targets
  if (targetLat >= 33.0 && targetLat <= 34.5 && targetLng >= 35.0 && targetLng <= 36.5) {
    return { lat: 32.8, lng: 34.98, name: 'Israel' };
  }
  // Gaza targets
  if (targetLat >= 31.3 && targetLat <= 31.6 && targetLng >= 34.2 && targetLng <= 34.6) {
    return { lat: 31.65, lng: 34.6, name: 'Israel' };
  }
  // Yemen targets
  if (targetLat >= 12.0 && targetLat <= 17.0 && targetLng >= 42.0 && targetLng <= 50.0) {
    return { lat: 29.55, lng: 34.95, name: 'Israel / US / UK Coalition' };
  }
  // Ukraine targets
  if (targetLat >= 44.0 && targetLat <= 52.0 && targetLng >= 22.0 && targetLng <= 40.0) {
    if (targetLat < 47.0) return { lat: 44.5, lng: 33.5, name: 'Black Sea Fleet (Russia)' }; // Odesa/South
    return { lat: 50.6, lng: 36.6, name: 'Belgorod (Russia)' }; // North/East
  }
  // Russia targets (near border)
  if (targetLat >= 50.0 && targetLat <= 55.0 && targetLng >= 30.0 && targetLng <= 45.0) {
    return { lat: 50.0, lng: 36.2, name: 'Kharkiv (Ukraine)' };
  }
  // Syria targets
  if (targetLat >= 32.5 && targetLat <= 37.5 && targetLng >= 35.5 && targetLng <= 42.5) {
    return { lat: 33.1, lng: 35.8, name: 'Israel (Golan Heights)' };
  }

  // Default fallback (local skirmish / unknown origin)
  return { 
    lat: targetLat + (Math.random() - 0.5) * 5, 
    lng: targetLng + (Math.random() - 0.5) * 5, 
    name: 'Unknown Origin' 
  };
}

function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

// Simple XML parsing for RSS
function parseRSSItems(xml: string): any[] {
  const items: any[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    const getTag = (tag: string) => {
      const m = itemXml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return (m?.[1] || m?.[2] || '').trim();
    };

    items.push({
      title: getTag('title').replace(/<[^>]+>/g, ''),
      link: getTag('link'),
    });
  }
  return items;
}

// Simulated fallback events if GDELT is truly dead, augmented with live RSS links if possible
let cachedFallbacks: any[] | null = null;
let lastFallbackFetch = 0;

async function getLiveFallbacks() {
  const now = Date.now();
  if (cachedFallbacks && now - lastFallbackFetch < 300000) return cachedFallbacks; // cache 5 mins

  const defaultFallbacks = [
    { targetLat: 31.7, targetLng: 35.2, name: 'Jerusalem, Israel', url: 'https://reuters.com/world/middle-east' },
    { targetLat: 35.68, targetLng: 51.38, name: 'Tehran, Iran', url: 'https://reuters.com/world/middle-east' },
    { targetLat: 33.88, targetLng: 35.49, name: 'Beirut, Lebanon', url: 'https://reuters.com/world/middle-east' },
    { targetLat: 50.45, targetLng: 30.52, name: 'Kyiv, Ukraine', url: 'https://reuters.com/world/europe' }
  ];

  try {
    const res = await fetch('https://www.aljazeera.com/xml/rss/all.xml', { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const xml = await res.text();
      const items = parseRSSItems(xml);
      
      const matchItem = (kw: string) => items.find(i => i.title.toLowerCase().includes(kw) || i.link.toLowerCase().includes(kw))?.link;

      cachedFallbacks = [
        { targetLat: 31.7, targetLng: 35.2, name: 'Jerusalem, Israel', url: matchItem('israel') || matchItem('gaza') || defaultFallbacks[0].url },
        { targetLat: 35.68, targetLng: 51.38, name: 'Tehran, Iran', url: matchItem('iran') || matchItem('tehran') || defaultFallbacks[1].url },
        { targetLat: 33.88, targetLng: 35.49, name: 'Beirut, Lebanon', url: matchItem('lebanon') || matchItem('beirut') || matchItem('hezbollah') || defaultFallbacks[2].url },
        { targetLat: 50.45, targetLng: 30.52, name: 'Kyiv, Ukraine', url: matchItem('ukraine') || matchItem('russia') || defaultFallbacks[3].url }
      ];
      lastFallbackFetch = now;
      return cachedFallbacks;
    }
  } catch (e) {
    console.warn('Live fallback RSS fetch failed', e);
  }

  return defaultFallbacks;
}


let liveAlertsState: any[] = [];
let lastFetch = 0;

export async function GET() {
  try {
    const now = Date.now();
    
    // Only fetch from GDELT every 60 seconds to avoid API bans
    if (now - lastFetch > 60000 || liveAlertsState.length === 0) {
      lastFetch = now;
      
      // Broader query to capture News Pings from Iran, Israel, etc.
      const query = '(Iran OR Israel OR Gaza OR Lebanon OR Ukraine OR Russia OR Yemen OR Syria) AND (conflict OR attack OR strike OR war OR missile OR rocket OR drone OR military)';
      const url = `https://api.gdeltproject.org/api/v2/geo/geo?query=${encodeURIComponent(query)}&mode=PointData&format=GeoJSON&timespan=24h&maxpoints=20`;
      
      let features = [];
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(8000)
        });

        if (res.ok) {
          const data = await res.json();
          features = data.features || [];
        }
      } catch (err) {
        console.warn('GDELT fetch timed out or failed, using fallback.');
      }

      // If GDELT returns 0 features or fails, use fallback
      if (features.length === 0) {
        const fallbacks = await getLiveFallbacks();
        features = fallbacks.map(e => ({
          geometry: { coordinates: [e.targetLng, e.targetLat] },
          properties: { name: e.name, url: e.url, html: 'Simulated News Ping due to API silence.' }
        }));
      }

      const newAlerts = features.map((f: any) => {
        const targetLng = f.geometry?.coordinates?.[0];
        const targetLat = f.geometry?.coordinates?.[1];
        if (!targetLat || !targetLng) return null;

        const originData = inferOrigin(targetLat, targetLng);
        const nameStr = (f.properties?.name || 'Unknown Location').split(',')[0];
        const htmlContent = f.properties?.html || '';
        
        let cleanUrl = f.properties?.url || '';
        if (!cleanUrl && htmlContent.includes('href="')) {
          cleanUrl = htmlContent.split('href="')[1].split('"')[0];
        }

        const text = (nameStr + ' ' + htmlContent).toLowerCase();
        let type = 'NEWS_PING';
        
        // Upgrade severity if specific kinetic keywords are found
        if (text.includes('ballistic')) type = 'BALLISTIC_MISSILE';
        else if (text.includes('cruise')) type = 'CRUISE_MISSILE';
        else if (text.includes('drone') || text.includes('uav')) type = 'DRONE_STRIKE';
        else if (text.includes('airstrike')) type = 'AIRSTRIKE';
        else if (text.includes('rocket')) type = 'ROCKET';
        else if (text.includes('attack') || text.includes('strike')) type = 'KINETIC_EVENT';

        // Flight duration between 2 to 4 minutes
        const flightDuration = 120000 + Math.random() * 120000;

        return {
          id: `alert-${generateId()}`,
          city: nameStr,
          originName: originData.name,
          type: type,
          launchTime: now,
          impactTime: now + flightDuration,
          origin: [originData.lng, originData.lat], // [lng, lat]
          target: [targetLng, targetLat],
          threatLevel: type.includes('MISSILE') ? 'CRITICAL' : type === 'NEWS_PING' ? 'ELEVATED' : 'HIGH',
          status: 'ACTIVE',
          source: f.properties?.url ? 'GDELT_LIVE_OSINT' : 'SIMULATED_PING',
          sourceUrl: cleanUrl
        };
      }).filter(Boolean);

      // Merge keeping max 12
      liveAlertsState = [...liveAlertsState, ...newAlerts].filter((a, i, self) => 
        a.impactTime > now && self.findIndex(t => t.city === a.city && t.type === a.type) === i
      ).slice(0, 12);
    }

    liveAlertsState = liveAlertsState.filter(a => a.impactTime > Date.now());

    const formattedAlerts = liveAlertsState.map(a => ({
      ...a,
      timeToImpactMs: Math.max(0, a.impactTime - Date.now())
    })).sort((a, b) => a.timeToImpactMs - b.timeToImpactMs);

    return NextResponse.json({
      alerts: formattedAlerts,
      defcon: formattedAlerts.some(a => a.threatLevel === 'CRITICAL') ? 2 : formattedAlerts.length > 0 ? 3 : 4,
      timestamp: new Date().toISOString()
    }, {
      headers: {
        'Cache-Control': 'no-store, max-age=0'
      }
    });

  } catch (error) {
    console.error('War simulator engine error:', error);
    return NextResponse.json({ alerts: [], error: 'OSINT engine failed' }, { status: 500 });
  }
}
