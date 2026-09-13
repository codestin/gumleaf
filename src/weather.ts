// A named upstream being down, distinguishable from a bug: the catch in
// index.ts tells the user honestly instead of the generic apology.
export class UpstreamError extends Error {
  constructor(
    public stage: string,
    message: string
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

export function compassDir(deg: number): string {
  return COMPASS[Math.round(deg / 22.5) % 16] ?? "";
}

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
  // One retry: a geocoding blip must not kill the whole answer.
  let res: Response | null = null;
  for (let attempt = 0; attempt < 2 && !res?.ok; attempt++) {
    res = await fetch(url, { signal: AbortSignal.timeout(3000) }).catch(() => null);
  }
  if (!res?.ok) throw new UpstreamError("geocode", `Geocoding failed: HTTP ${res ? res.status : "timeout"}`);
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
    { headers, signal: AbortSignal.timeout(4000) }
  );
  if (!pointsRes.ok) {
    throw new Error(`NWS points lookup failed: HTTP ${pointsRes.status} (NWS only covers US locations)`);
  }
  const points = (await pointsRes.json()) as { properties?: { forecast?: string } };
  const forecastUrl = points.properties?.forecast;
  if (!forecastUrl) throw new Error("NWS returned no forecast URL for this location");

  const forecastRes = await fetch(forecastUrl, { headers, signal: AbortSignal.timeout(4000) });
  if (!forecastRes.ok) throw new Error(`NWS forecast fetch failed: HTTP ${forecastRes.status}`);
  const forecast = (await forecastRes.json()) as { properties?: { periods?: ForecastPeriod[] } };
  const periods = forecast.properties?.periods;
  if (!periods || periods.length === 0) throw new Error("NWS returned no forecast periods");
  return trimNwsPeriods(periods);
}

// Keep NWS's full week (14 day/night periods), but past the first 6 swap the
// 200-400 char detailedForecast for the ~30 char shortForecast so the LLM
// payload stays lean.
export function trimNwsPeriods(periods: ForecastPeriod[]): ForecastPeriod[] {
  return periods.slice(0, 14).map((p, i) => (i >= 6 ? { ...p, detailedForecast: p.shortForecast } : p));
}

export function formatLocationName(geo: GeoResult): string {
  return [geo.name, geo.admin1, geo.country].filter(Boolean).join(", ");
}

// LLM-down net: the location plus the period lines verbatim, whole lines
// only, aimed under 600 chars so the 640 clampSms never truncates mid-line.
export function fallbackForecastText(locationName: string, periods: ForecastPeriod[]): string {
  let text = `Forecast for ${locationName}:`;
  for (const p of periods) {
    const line = `\n${p.name}: ${p.detailedForecast}`;
    if (text.length + line.length > 600) break;
    text += line;
  }
  return text;
}

export interface SunTimes {
  date: string; // "2026-07-18"
  sunrise: string; // local ISO, "2026-07-18T05:58"
  sunset: string;
}

// Sun times are computed locally (NOAA solar position equations) instead of
// fetched — no API, no key, and nothing that can stall the forecast. Accurate
// to ~1 minute, plenty for an SMS answer. Returns [] for polar day/night dates
// and when the timezone is unknown; callers treat that as "no sun data".
export function getSunTimes(lat: number, lon: number, timezone: string | undefined, now: Date = new Date()): SunTimes[] {
  if (!timezone) return [];
  const out: SunTimes[] = [];
  for (let i = 0; i < 3; i++) {
    const at = new Date(now.getTime() + i * 86_400_000);
    const localDate = isoDateInZone(at, timezone);
    if (!localDate) return [];
    const events = solarEventsUtc(Date.parse(`${localDate}T12:00:00Z`), lat, lon);
    if (!events) continue; // polar day or night: no rise/set that date
    const sunrise = localClockInZone(events.sunrise, timezone);
    const sunset = localClockInZone(events.sunset, timezone);
    if (!sunrise || !sunset) continue;
    out.push({ date: localDate, sunrise: `${localDate}T${sunrise}`, sunset: `${localDate}T${sunset}` });
  }
  return out;
}

// NOAA/Wikipedia "sunrise equation": mean solar noon -> equation of center ->
// solar transit -> hour angle at -0.833deg (standard refraction + solar disc).
// Returns UTC ms for sunrise/sunset, or null when the sun never crosses the
// horizon that day (polar summer/winter).
export function solarEventsUtc(dayUtcMs: number, lat: number, lon: number): { sunrise: number; sunset: number } | null {
  const rad = Math.PI / 180;
  const jDate = dayUtcMs / 86_400_000 + 2440587.5;
  const n = Math.ceil(jDate - 2451545.0009 + 69.184 / 86400);
  const jStar = n + 0.0009 - lon / 360;
  const mDeg = (357.5291 + 0.98560028 * jStar) % 360;
  const m = mDeg * rad;
  const cDeg = 1.9148 * Math.sin(m) + 0.02 * Math.sin(2 * m) + 0.0003 * Math.sin(3 * m);
  const lDeg = (mDeg + cDeg + 180 + 102.9372) % 360;
  const lambda = lDeg * rad;
  const jTransit = 2451545.0 + jStar + 0.0053 * Math.sin(m) - 0.0069 * Math.sin(2 * lambda);
  const sinDecl = Math.sin(lambda) * Math.sin(23.4397 * rad);
  const cosDecl = Math.cos(Math.asin(sinDecl));
  const cosHour =
    (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * sinDecl) / (Math.cos(lat * rad) * cosDecl);
  if (cosHour < -1 || cosHour > 1) return null;
  const hourFrac = Math.acos(cosHour) / rad / 360;
  const toMs = (jd: number) => (jd - 2440587.5) * 86_400_000;
  return { sunrise: toMs(jTransit - hourFrac), sunset: toMs(jTransit + hourFrac) };
}

// "2026-07-20" for the given instant in the given IANA zone; null if the zone
// name is bad (Workers support full Intl timezones).
function isoDateInZone(at: Date, timezone: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, dateStyle: "short" }).format(at);
  } catch {
    return null;
  }
}

// "05:58" local wall clock for a UTC ms instant.
function localClockInZone(utcMs: number, timezone: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(utcMs));
  } catch {
    return null;
  }
}

// "Sun (local): Sat Jul 18 rise 5:58am set 8:31pm; Sun Jul 19 ..." — appended
// to the forecast text so the summarizer can answer sunrise/sunset questions.
export function formatSunTimes(days: SunTimes[]): string {
  const parts = days.map((d) => {
    const dayName = new Date(`${d.date}T12:00:00Z`).toUTCString().slice(0, 11).replace(",", "");
    return `${dayName.trim()} rise ${clock(d.sunrise)} set ${clock(d.sunset)}`;
  });
  return `Sun times (local): ${parts.join("; ")}`;
}

function clock(isoLocal: string): string {
  const t = isoLocal.slice(11, 16); // "05:58"
  const [hStr, m] = t.split(":");
  const h = parseInt(hStr ?? "", 10);
  if (Number.isNaN(h) || m === undefined) return t;
  const ampm = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m}${ampm}`;
}
