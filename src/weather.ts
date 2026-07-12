export interface GeoResult {
  name: string;
  latitude: number;
  longitude: number;
  admin1?: string;
  country?: string;
  country_code?: string;
  timezone?: string;
}

export interface ForecastPeriod {
  name: string;
  temperature: number;
  temperatureUnit: string;
  windSpeed: string;
  windDirection: string;
  shortForecast: string;
  detailedForecast: string;
}

const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  DC: "District of Columbia",
};

// Open-Meteo's search fuzzy-matches the whole string, so "City, Region" queries
// need splitting: search the city name alone, then pick the result whose
// country/state matches the region hint. Without a hint, trust Open-Meteo's
// population ranking (bare "Oslo" must mean Norway, not Oslo MN).
export async function geocode(query: string): Promise<GeoResult | null> {
  const q = query.trim();

  const commaIdx = q.lastIndexOf(",");
  if (commaIdx !== -1) {
    const name = q.slice(0, commaIdx).trim();
    const hint = q.slice(commaIdx + 1).trim();
    return (await search(name, hint || null)) ?? search(q.replace(/,/g, " "), null);
  }

  const words = q.split(/\s+/);
  const last = words[words.length - 1] ?? "";
  if (words.length > 1 && /^[A-Za-z]{2}$/.test(last)) {
    return (await search(words.slice(0, -1).join(" "), last)) ?? search(q, null);
  }

  const direct = await search(q, null);
  if (direct) return direct;
  return words.length > 1 ? search(words.slice(0, -1).join(" "), last) : null;
}

async function search(name: string, hint: string | null): Promise<GeoResult | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=10`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocoding failed: HTTP ${res.status}`);
  const data = (await res.json()) as { results?: GeoResult[] };
  const results = data.results ?? [];
  if (results.length === 0) return null;

  if (hint) {
    const target = hint.toLowerCase();
    const stateName = US_STATES[hint.toUpperCase()]?.toLowerCase();
    const match = results.find((r) =>
      [r.country_code, r.country, r.admin1].some(
        (field) =>
          field &&
          (field.toLowerCase() === target || (stateName !== undefined && field.toLowerCase() === stateName))
      )
    );
    if (match) return match;
  }
  return results[0] ?? null;
}

export async function getForecast(lat: number, lon: number, userAgent: string): Promise<ForecastPeriod[]> {
  const headers = { "User-Agent": userAgent, Accept: "application/geo+json" };
  const pointsRes = await fetch(
    `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`,
    { headers }
  );
  if (!pointsRes.ok) {
    throw new Error(`NWS points lookup failed: HTTP ${pointsRes.status} (NWS only covers US locations)`);
  }
  const points = (await pointsRes.json()) as { properties?: { forecast?: string } };
  const forecastUrl = points.properties?.forecast;
  if (!forecastUrl) throw new Error("NWS returned no forecast URL for this location");

  const forecastRes = await fetch(forecastUrl, { headers });
  if (!forecastRes.ok) throw new Error(`NWS forecast fetch failed: HTTP ${forecastRes.status}`);
  const forecast = (await forecastRes.json()) as { properties?: { periods?: ForecastPeriod[] } };
  const periods = forecast.properties?.periods;
  if (!periods || periods.length === 0) throw new Error("NWS returned no forecast periods");
  return periods.slice(0, 6);
}

export function formatLocationName(geo: GeoResult): string {
  return [geo.name, geo.admin1, geo.country].filter(Boolean).join(", ");
}
