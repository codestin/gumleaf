import type { Env } from "./env";

// Live Bay Area transit: BART via the legacy JSON API (free key), Caltrain via
// 511.org SIRI StopMonitoring (free token, 60 req/hr — hence the mandatory KV
// cache). Replies are formatted deterministically, no LLM call: faster,
// cheaper, and exact, which is what a satellite user wants from a timetable.

const CACHE_TTL_SECONDS = 60; // KV minimum; keeps 511 usage far under 60/hr

// Station list from api.bart.gov stn.aspx (July 2026).
const BART_STATIONS: [string, string][] = [
  ["12TH", "12th St. Oakland City Center"],
  ["16TH", "16th St. Mission"],
  ["19TH", "19th St. Oakland"],
  ["24TH", "24th St. Mission"],
  ["ANTC", "Antioch"],
  ["ASHB", "Ashby"],
  ["BALB", "Balboa Park"],
  ["BAYF", "Bay Fair"],
  ["BERY", "Berryessa/North San Jose"],
  ["CAST", "Castro Valley"],
  ["CIVC", "Civic Center/UN Plaza"],
  ["COLS", "Coliseum"],
  ["COLM", "Colma"],
  ["CONC", "Concord"],
  ["DALY", "Daly City"],
  ["DBRK", "Downtown Berkeley"],
  ["DUBL", "Dublin/Pleasanton"],
  ["DELN", "El Cerrito del Norte"],
  ["PLZA", "El Cerrito Plaza"],
  ["EMBR", "Embarcadero"],
  ["FRMT", "Fremont"],
  ["FTVL", "Fruitvale"],
  ["GLEN", "Glen Park"],
  ["HAYW", "Hayward"],
  ["LAFY", "Lafayette"],
  ["LAKE", "Lake Merritt"],
  ["MCAR", "MacArthur"],
  ["MLBR", "Millbrae"],
  ["MLPT", "Milpitas"],
  ["MONT", "Montgomery St."],
  ["NBRK", "North Berkeley"],
  ["NCON", "North Concord/Martinez"],
  ["OAKL", "Oakland International Airport"],
  ["ORIN", "Orinda"],
  ["PITT", "Pittsburg/Bay Point"],
  ["PCTR", "Pittsburg Center"],
  ["PHIL", "Pleasant Hill/Contra Costa Centre"],
  ["POWL", "Powell St."],
  ["RICH", "Richmond"],
  ["ROCK", "Rockridge"],
  ["SBRN", "San Bruno"],
  ["SFIA", "San Francisco International Airport"],
  ["SANL", "San Leandro"],
  ["SHAY", "South Hayward"],
  ["SSAN", "South San Francisco"],
  ["UCTY", "Union City"],
  ["WCRK", "Walnut Creek"],
  ["WARM", "Warm Springs/South Fremont"],
  ["WDUB", "West Dublin/Pleasanton"],
  ["WOAK", "West Oakland"],
];

// Caltrain stations north to south; matched against 511's StopPointName
// (e.g. "Palo Alto Caltrain Station") by normalized inclusion.
const CALTRAIN_STOPS: string[] = [
  "San Francisco",
  "22nd Street",
  "Bayshore",
  "South San Francisco",
  "San Bruno",
  "Millbrae",
  "Broadway",
  "Burlingame",
  "San Mateo",
  "Hayward Park",
  "Hillsdale",
  "Belmont",
  "San Carlos",
  "Redwood City",
  "Menlo Park",
  "Palo Alto",
  "Stanford",
  "California Avenue",
  "San Antonio",
  "Mountain View",
  "Sunnyvale",
  "Lawrence",
  "Santa Clara",
  "College Park",
  "San Jose Diridon",
  "Tamien",
  "Capitol",
  "Blossom Hill",
  "Morgan Hill",
  "San Martin",
  "Gilroy",
];

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type TransitAgency = "bart" | "caltrain";

// "BART embarcadero" / "CALTRAIN palo alto" keyword prefixes. Only the leading
// word is claimed, so "is bart running today" still reads as a sentence and
// goes to the classifier instead.
export function parseTransitCommand(body: string): { agency: TransitAgency; stop: string } | null {
  const m = body.trim().match(/^(bart|caltrain)\b[\s:,-]*([\s\S]*)$/i);
  if (!m) return null;
  const agency = (m[1] as string).toLowerCase() as TransitAgency;
  return { agency, stop: (m[2] ?? "").trim() };
}

// Resolve free text to a station. BART: 4-letter code first, then name tokens.
// Caltrain: name tokens against the stop list. Returns null when nothing fits.
export function resolveStation(agency: TransitAgency, text: string): { code: string; name: string } | null {
  const q = normalize(text);
  if (!q) return null;

  if (agency === "bart") {
    const asCode = q.toUpperCase().replace(/\s/g, "");
    const byCode = BART_STATIONS.find(([code]) => code === asCode);
    if (byCode) return { code: byCode[0], name: byCode[1] };
    return matchByName(
      BART_STATIONS.map(([code, name]) => ({ code, name })),
      q
    );
  }
  return matchByName(
    CALTRAIN_STOPS.map((name) => ({ code: name, name })),
    q
  );
}

function matchByName(stations: { code: string; name: string }[], q: string): { code: string; name: string } | null {
  const qTokens = q.split(" ");
  let best: { code: string; name: string } | null = null;
  let bestScore = 0;
  for (const st of stations) {
    const n = normalize(st.name);
    if (n === q) return st;
    const nTokens = n.split(" ");
    // Every query token must appear (as a prefix) somewhere in the name.
    const hit = qTokens.every((t) => nTokens.some((nt) => nt.startsWith(t)));
    if (!hit) continue;
    // Prefer the tightest name (fewest extra tokens).
    const score = 100 - (nTokens.length - qTokens.length);
    if (score > bestScore) {
      bestScore = score;
      best = st;
    }
  }
  return best;
}

export function stationHint(agency: TransitAgency): string {
  return agency === "bart"
    ? `Which BART station? e.g. "BART Embarcadero", "BART Downtown Berkeley", or a code like "BART EMBR".`
    : `Which Caltrain stop? e.g. "CALTRAIN Palo Alto" or "CALTRAIN Millbrae".`;
}

interface BartEstimate {
  minutes: string;
  delay?: string;
}
interface BartEtd {
  destination: string;
  estimate: BartEstimate[];
}

export async function getBartDepartures(env: Env, code: string, name: string): Promise<string> {
  const kv = env.SMS_STATE;
  const cacheKey = `transit:bart:${code}`;
  const cached = await kv.get(cacheKey);
  if (cached) return cached;

  const key = env.BART_API_KEY ?? "MW9S-E7SL-26DU-VV8V"; // BART's published demo key
  const res = await fetch(`https://api.bart.gov/api/etd.aspx?cmd=etd&orig=${code}&key=${key}&json=y`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`BART etd failed: HTTP ${res.status}`);
  const data = (await res.json()) as {
    root?: { station?: { name?: string; etd?: BartEtd[] }[] };
  };
  const station = data.root?.station?.[0];
  const etds = station?.etd ?? [];
  let text: string;
  if (etds.length === 0) {
    text = `BART ${name}: no trains reported right now (station may be closed).`;
  } else {
    const lines = etds.map((e) => {
      const times = e.estimate
        .slice(0, 3)
        .map((est) => (est.minutes === "Leaving" ? "now" : est.minutes))
        .join(", ");
      return `${e.destination} ${times} min`;
    });
    text = `BART ${name}: ${lines.join("; ")}. Live from bart.gov.`;
  }
  await kv.put(cacheKey, text, { expirationTtl: CACHE_TTL_SECONDS });
  return text;
}

interface SiriVisit {
  MonitoredVehicleJourney?: {
    DestinationName?: string;
    DirectionRef?: string;
    LineRef?: string;
    MonitoredCall?: {
      StopPointName?: string;
      AimedDepartureTime?: string;
      ExpectedDepartureTime?: string | null;
    };
  };
}

export async function getCaltrainDepartures(env: Env, stopName: string, now: Date = new Date()): Promise<string> {
  if (!env.TRANSIT_511_TOKEN) {
    return `Caltrain times aren't hooked up just yet - BART works today ("BART Embarcadero"). Caltrain is coming soon.`;
  }
  const kv = env.SMS_STATE;
  const cacheKey = `transit:ct:all`;
  let raw = await kv.get(cacheKey);
  if (!raw) {
    const res = await fetch(
      `https://api.511.org/transit/StopMonitoring?api_key=${env.TRANSIT_511_TOKEN}&agency=CT&format=json`,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) throw new Error(`511 StopMonitoring failed: HTTP ${res.status}`);
    // 511 responses arrive with a UTF-8 BOM that breaks JSON.parse.
    raw = await res.text();
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    await kv.put(cacheKey, raw, { expirationTtl: CACHE_TTL_SECONDS });
  }

  const data = JSON.parse(raw) as {
    ServiceDelivery?: { StopMonitoringDelivery?: { MonitoredStopVisit?: SiriVisit[] } };
  };
  const visits = data.ServiceDelivery?.StopMonitoringDelivery?.MonitoredStopVisit ?? [];
  const want = normalize(stopName);
  const matched = visits.filter((v) =>
    normalize(v.MonitoredVehicleJourney?.MonitoredCall?.StopPointName ?? "").includes(want)
  );
  if (matched.length === 0) {
    return `Caltrain ${stopName}: no upcoming departures reported right now.`;
  }
  const lines = matched
    .map((v) => {
      const j = v.MonitoredVehicleJourney!;
      const call = j.MonitoredCall!;
      const timeIso = call.ExpectedDepartureTime || call.AimedDepartureTime;
      if (!timeIso) return null;
      const mins = Math.round((new Date(timeIso).getTime() - now.getTime()) / 60000);
      if (mins < -1 || mins > 180) return null;
      // "San Jose Diridon Caltrain Station" -> "San Jose Diridon"; direction as NB/SB.
      const dest = (j.DestinationName ?? "").replace(/\s*Caltrain( Station)?(\s+(north|south)bound)?$/i, "").trim();
      const dir = j.DirectionRef === "N" ? "NB" : j.DirectionRef === "S" ? "SB" : "";
      const label = [dir, dest ? `to ${dest}` : ""].filter(Boolean).join(" ") || "departure";
      return { mins: Math.max(0, mins), text: `${label} ${Math.max(0, mins)} min` };
    })
    .filter((x): x is { mins: number; text: string } => x !== null)
    .sort((a, b) => a.mins - b.mins)
    .slice(0, 4);
  if (lines.length === 0) {
    return `Caltrain ${stopName}: no departures in the next 3 hours.`;
  }
  return `Caltrain ${stopName}: ${lines.map((l) => l.text).join("; ")}. Live from 511.org.`;
}

export async function transitAnswer(env: Env, agency: TransitAgency, stopText: string): Promise<{ answer: string; answered: boolean }> {
  const station = resolveStation(agency, stopText);
  if (!station) {
    return { answer: stationHint(agency), answered: false };
  }
  try {
    const answer =
      agency === "bart"
        ? await getBartDepartures(env, station.code, station.name)
        : await getCaltrainDepartures(env, station.name);
    return { answer, answered: true };
  } catch (err) {
    console.error("transit failed:", err instanceof Error ? err.message : String(err));
    return {
      answer: `Couldn't reach live ${agency === "bart" ? "BART" : "Caltrain"} data just now - try again in a minute.`,
      answered: false,
    };
  }
}
