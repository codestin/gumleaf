import type { ForecastPeriod } from "./weather";

interface MetnoTimestep {
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

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

export async function getMetnoForecast(
  lat: number,
  lon: number,
  timezone: string | undefined,
  userAgent: string
): Promise<ForecastPeriod[]> {
  const res = await fetch(
    `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`,
    { headers: { "User-Agent": userAgent } }
  );
  if (!res.ok) throw new Error(`MET Norway forecast fetch failed: HTTP ${res.status}`);
  const data = (await res.json()) as { properties?: { timeseries?: MetnoTimestep[] } };
  const series = data.properties?.timeseries ?? [];
  const first = series[0];
  if (!first) throw new Error("MET Norway returned no forecast data");

  const startMs = new Date(first.time).getTime();
  const picked = [first];
  for (const offsetHours of [6, 12, 24, 36, 48]) {
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
  return picked.map((step, n) => toPeriod(step, n === 0 ? "Now" : label(step.time)));
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
  const windDirection =
    details.wind_from_direction !== undefined
      ? COMPASS[Math.round(details.wind_from_direction / 22.5) % 16] ?? ""
      : "";

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
