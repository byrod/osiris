/**
 * OSIRIS — API Configuration
 * All API routes are Next.js serverless functions (Vercel-compatible)
 */

// In Next.js App Router, API routes are relative (same origin)
export const API_BASE = '';

// Polling intervals (ms)
export const FAST_POLL_INTERVAL = 60_000;   // 60s — flights, ships, satellites
export const SLOW_POLL_INTERVAL = 120_000;  // 120s — news, markets, earthquakes

// External data source URLs (used by API routes)
export const DATA_SOURCES = {
  ADSB_LOL: 'https://api.adsb.lol',
  CELESTRAK: 'https://celestrak.org',
  USGS: 'https://earthquake.usgs.gov',
  GDELT: 'https://api.gdeltproject.org',
  DEEPSTATE: 'https://deepstatemap.live',
  NOMINATIM: 'https://nominatim.openstreetmap.org',
  REST_COUNTRIES: 'https://restcountries.com/v3.1',
  WIKIDATA: 'https://query.wikidata.org',
  WIKIPEDIA: 'https://en.wikipedia.org/api',
  NASA_GIBS: 'https://gibs.earthdata.nasa.gov',
  CARTO_TILES: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  CDC_SOCRATA: 'https://data.cdc.gov/resource',
  ECDC_OPENDATA: 'https://opendata.ecdc.europa.eu/covid19',
  WHO_GHO: 'https://ghoapi.azureedge.net/api',
} as const;

// Map style URLs
export const MAP_STYLES = {
  DEFAULT: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  SATELLITE: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json', // Satellite layer added as overlay
} as const;
