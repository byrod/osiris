import { NextResponse } from 'next/server';

/**
 * OSIRIS — Region Dossier API
 * Provides country intelligence for any coordinate (right-click on map)
 */

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const lat = parseFloat(searchParams.get('lat') || '0');
  const lng = parseFloat(searchParams.get('lng') || '0');

  try {
    // Step 1: Reverse geocode to get country
    const geoRes = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=5&addressdetails=1`,
      {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'OsirisIntelPlatform/1.0' },
      }
    );

    let countryName = '';
    let countryCode = '';
    let locationInfo: any = {};

    if (geoRes.ok) {
      const geoData = await geoRes.json();
      const addr = geoData.address || {};
      countryName = addr.country || '';
      countryCode = addr.country_code?.toUpperCase() || '';
      locationInfo = {
        city: addr.city || addr.town || addr.village || '',
        state: addr.state || addr.region || '',
        country: countryName,
        country_code: countryCode,
        display_name: geoData.display_name,
      };
    }

    // Step 2: Fetch country details from RestCountries
    let countryData: any = null;
    if (countryCode) {
      try {
        const countryRes = await fetch(
          `https://restcountries.com/v3.1/alpha/${countryCode}?fields=name,capital,population,area,region,subregion,languages,currencies,flag,flags,timezones`,
          { signal: AbortSignal.timeout(5000) }
        );
        if (countryRes.ok) {
          countryData = await countryRes.json();
        }
      } catch (e) { console.warn('[OSIRIS] Suppressed error in ' + __filename.split(/[/\\]/).pop(), e); }
    }

    // Step 3: Fetch Wikipedia summary
    let wikiSummary: any = null;
    const wikiQuery = locationInfo.city || countryName;
    if (wikiQuery) {
      try {
        const wikiRes = await fetch(
          `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(wikiQuery)}`,
          { signal: AbortSignal.timeout(5000) }
        );
        if (wikiRes.ok) {
          const wiki = await wikiRes.json();
          wikiSummary = {
            title: wiki.title,
            extract: wiki.extract?.substring(0, 500),
            thumbnail: wiki.thumbnail?.source,
          };
        }
      } catch (e) { console.warn('[OSIRIS] Suppressed error in ' + __filename.split(/[/\\]/).pop(), e); }
    }

    // Step 4: Fetch head of state from Wikidata
    let headOfState: any = null;
    if (countryName) {
      try {
        const safeCountryName = countryName.replace(/[\\"]/g, '\\$&');
        const sparql = `
          SELECT ?leader ?leaderLabel ?positionLabel WHERE {
            ?country wdt:P31 wd:Q6256;
                     rdfs:label "${safeCountryName}"@en;
                     wdt:P6 ?leader.
            OPTIONAL { ?leader wdt:P39 ?position. }
            SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
          } LIMIT 1
        `;
        const wdRes = await fetch(
          `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`,
          {
            signal: AbortSignal.timeout(5000),
            headers: { 'User-Agent': 'OsirisIntelPlatform/1.0' },
          }
        );
        if (wdRes.ok) {
          const wd = await wdRes.json();
          const binding = wd.results?.bindings?.[0];
          if (binding) {
            headOfState = {
              name: binding.leaderLabel?.value,
              position: binding.positionLabel?.value || 'Head of State',
            };
          }
        }
      } catch (e) { console.warn('[OSIRIS] Suppressed error in ' + __filename.split(/[/\\]/).pop(), e); }
    }

    return NextResponse.json({
      coordinates: { lat, lng },
      location: locationInfo,
      country: countryData ? {
        name: countryData.name?.common,
        official_name: countryData.name?.official,
        capital: countryData.capital?.[0],
        population: countryData.population,
        area: countryData.area,
        region: countryData.region,
        subregion: countryData.subregion,
        languages: countryData.languages ? Object.values(countryData.languages) : [],
        currencies: countryData.currencies ? Object.entries(countryData.currencies).map(([code, info]: [string, any]) => `${info.name} (${info.symbol || code})`) : [],
        flag: countryData.flag,
        flag_url: countryData.flags?.svg,
        timezones: countryData.timezones,
      } : null,
      head_of_state: headOfState,
      wikipedia: wikiSummary,
      timestamp: new Date().toISOString(),
    }, {
      headers: {
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200',
      },
    });
  } catch (error) {
    console.error('Region dossier error:', error);
    return NextResponse.json({ error: 'Failed to fetch region data' }, { status: 500 });
  }
}
