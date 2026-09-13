import { compassDir } from "./weather";
import type { ForecastPeriod } from "./weather";

export interface MetnoTimestep {
  time: string;
  data: {
    instant: {
      details: {
        air_temperature?: number;
        wind_speed?: number;
        wind_from_direction?: number;
        relative_humidity?: number;
      };
    };
    next_1_hours?: { summary?: { symbol_code?: string }; details?: { precipitation_amount?: number } };
    next_6_hours?: { summary?: { symbol_code?: string }; details?: { precipitation_amount?: number } };
    next_12_hours?: { summary?: { symbol_code?: string } };
  };
}

const SYMBOL_NAMES: Record<string, string> = {
  clearsky: "Clear sky",
  fair: "Fair",
  partlycloudy: "Partly cloudy",
  cloudy: "Cloudy",
  fog: "Fog",
  lightrain: "Light rain",
  rain: "Rain",
  heavyrain: "Heavy rain",
  lightrainshowers: "Light rain showers",
  rainshowers: "Rain showers",
  heavyrainshowers: "Heavy rain showers",
  lightsleet: "Light sleet",
  sleet: "Sleet",
  heavysleet: "Heavy sleet",
  sleetshowers: "Sleet showers",
  lightsnow: "Light snow",
  snow: "Snow",
  heavysnow: "Heavy snow",
  snowshowers: "Snow showers",
};

export async function getMetnoForecast(
  lat: number,
  lon: number,
  timezone: string | undefined,
  userAgent: string
): Promise<ForecastPeriod[]> {
  const res = await fetch(
    `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`,
    { headers: { "User-Agent": userAgent }, signal: AbortSignal.timeout(4000) }
  );
  if (!res.ok) throw new Error(`MET Norway forecast fetch failed: HTTP ${res.status}`);
  const data = (await res.json()) as { properties?: { timeseries?: MetnoTimestep[] } };
  return metnoSeriesToPeriods(data.properties?.timeseries ?? [], timezone);
}

// Turns the full ~9-day timeseries into periods: 6-hourly detail for the first
// 48h, then one aggregated period per local calendar day. Exported for tests.
export function metnoSeriesToPeriods(series: MetnoTimestep[], timezone: string | undefined): ForecastPeriod[] {
  const first = series[0];
  if (!first) throw new Error("MET Norway returned no forecast data");

  const startMs = new Date(first.time).getTime();
  const picked = [first];
  for (const offsetHours of [6, 12, 18, 24, 30, 36, 42, 48]) {
    const targetMs = startMs + offsetHours * 3600_000;
    let best = first;
    let bestDiff = Infinity;
    for (const step of series) {
      const diff = Math.abs(new Date(step.time).getTime() - targetMs);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = step;
      }
    }
    if (!picked.includes(best)) picked.push(best);
  }

  const label = makeLabeler(timezone);
  const periods = picked.map((step, n) => toPeriod(step, n === 0 ? "Now" : label(step.time)));

  const dateKey = makeDateKeyer(timezone);
  const lastDetailDate = dateKey(picked[picked.length - 1]!.time);
  const byDay = new Map<string, MetnoTimestep[]>();
  for (const step of series) {
    const key = dateKey(step.time);
    if (key <= lastDetailDate) continue;
    const bucket = byDay.get(key);
    if (bucket) bucket.push(step);
    else byDay.set(key, [step]);
  }

  const dayLabel = makeDayLabeler(timezone);
  for (const steps of byDay.values()) {
    // A day with a single step (the ragged end of the series) would report a
    // fake high/low from one sample.
    if (steps.length < 2) continue;
    periods.push(aggregateDay(steps, dayLabel(steps[0]!.time)));
  }
  return periods;
}

function aggregateDay(steps: MetnoTimestep[], name: string): ForecastPeriod {
  let high = -Infinity;
  let low = Infinity;
  let windMax = -1;
  let windDir = "";
  let precip = 0;
  const symbolCounts = new Map<string, number>();

  for (const step of steps) {
    const details = step.data.instant.details;
    if (details.air_temperature !== undefined) {
      high = Math.max(high, details.air_temperature);
      low = Math.min(low, details.air_temperature);
    }
    if (details.wind_speed !== undefined && details.wind_speed > windMax) {
      windMax = details.wind_speed;
      windDir = details.wind_from_direction !== undefined ? compassDir(details.wind_from_direction) : "";
    }
    // Hourly steps always carry next_1_hours; the 6-hourly tail only has
    // next_6_hours. Preferring next_1_hours when present sums each hour of
    // precipitation exactly once across the switchover.
    precip += step.data.next_1_hours
      ? step.data.next_1_hours.details?.precipitation_amount ?? 0
      : step.data.next_6_hours?.details?.precipitation_amount ?? 0;
    const symbol = step.data.next_6_hours?.summary?.symbol_code ?? step.data.next_12_hours?.summary?.symbol_code;
    if (symbol) {
      const base = symbol.replace(/_(day|night|polartwilight)$/, "");
      symbolCounts.set(base, (symbolCounts.get(base) ?? 0) + 1);
    }
  }

  let dominant = "";
  let dominantCount = 0;
  for (const [base, count] of symbolCounts) {
    if (count > dominantCount) {
      dominant = base;
      dominantCount = count;
    }
  }
  const shortForecast = dominant ? humanizeSymbol(dominant) : "";

  const highR = Math.round(high === -Infinity ? 0 : high);
  const lowR = Math.round(low === Infinity ? 0 : low);
  const windR = Math.round(Math.max(windMax, 0));
  const precipR = Math.round(precip * 10) / 10;

  const parts: string[] = [];
  if (shortForecast) parts.push(`${shortForecast}.`);
  parts.push(`High ${highR}C, low ${lowR}C.`);
  if (precipR > 0) parts.push(`Precip ${precipR} mm.`);
  parts.push(`Wind up to ${windR} m/s${windDir ? ` ${windDir}` : ""}.`);

  return {
    name,
    temperature: highR,
    temperatureUnit: "C",
    windSpeed: `${windR} m/s`,
    windDirection: windDir,
    shortForecast,
    detailedForecast: parts.join(" "),
  };
}

// "2026-07-21" in the location's local time, for grouping steps into days.
function makeDateKeyer(timezone: string | undefined): (iso: string) => string {
  const opts = { year: "numeric", month: "2-digit", day: "2-digit" } as const;
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone ?? "UTC", ...opts });
    return (iso) => fmt.format(new Date(iso));
  } catch {
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", ...opts });
    return (iso) => fmt.format(new Date(iso));
  }
}

// "Tue Jul 21" labels for the aggregated days.
function makeDayLabeler(timezone: string | undefined): (iso: string) => string {
  const opts = { weekday: "short", month: "short", day: "numeric" } as const;
  try {
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: timezone ?? "UTC", ...opts });
    return (iso) => fmt.format(new Date(iso)).replace(",", "");
  } catch {
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts });
    return (iso) => fmt.format(new Date(iso)).replace(",", "");
  }
}

function makeLabeler(timezone: string | undefined): (iso: string) => string {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone ?? "UTC",
      weekday: "short",
      hour: "numeric",
      hour12: true,
    });
    const suffix = timezone ? "" : " UTC";
    return (iso) => fmt.format(new Date(iso)) + suffix;
  } catch {
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", hour: "numeric", hour12: true });
    return (iso) => fmt.format(new Date(iso)) + " UTC";
  }
}

function toPeriod(step: MetnoTimestep, name: string): ForecastPeriod {
  const details = step.data.instant.details;
  const temperature = Math.round(details.air_temperature ?? 0);
  const windSpeed = `${Math.round(details.wind_speed ?? 0)} m/s`;
  const windDirection = details.wind_from_direction !== undefined ? compassDir(details.wind_from_direction) : "";

  const symbol =
    step.data.next_6_hours?.summary?.symbol_code ??
    step.data.next_1_hours?.summary?.symbol_code ??
    step.data.next_12_hours?.summary?.symbol_code ??
    "";
  const shortForecast = symbol ? humanizeSymbol(symbol) : "";

  const parts: string[] = [];
  if (shortForecast) parts.push(`${shortForecast}.`);
  parts.push(`${temperature}°C${details.relative_humidity !== undefined ? `, humidity ${Math.round(details.relative_humidity)}%` : ""}.`);
  const precip = step.data.next_6_hours?.details?.precipitation_amount ?? step.data.next_1_hours?.details?.precipitation_amount;
  const precipWindow = step.data.next_6_hours?.details ? "6 hours" : "hour";
  if (precip !== undefined && precip > 0) parts.push(`Precipitation next ${precipWindow}: ${precip} mm.`);

  return {
    name,
    temperature,
    temperatureUnit: "C",
    windSpeed,
    windDirection,
    shortForecast,
    detailedForecast: parts.join(" "),
  };
}

function humanizeSymbol(code: string): string {
  const base = code.replace(/_(day|night|polartwilight)$/, "");
  const known = SYMBOL_NAMES[base];
  if (known) return known;
  const spaced = base
    .replace(/andthunder/, " and thunder")
    .replace(/showers/, " showers")
    .replace(/^light(?=\w)/, "light ")
    .replace(/^heavy(?=\w)/, "heavy ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
