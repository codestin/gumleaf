import type { Env } from "./env";

// Flight status by number, on an all-free stack (July 2026 research):
//   1. AeroDataBox via RapidAPI free tier (600 units/mo, status = 2 units):
//      schedule/revised times, terminal + gate where the airport is live-tracked.
//   2. aviationstack free tier (100 req/mo): same shape, emergency fallback.
//   3. adsbdb.com (free, keyless): airline + route only - the degraded answer.
// Plus, always: the FAA NAS Status feed (free, keyless, XML) for airport-level
// ground stops/delay programs at the departure/arrival airports.
// Responses are cached in KV so SMS re-polls of the same flight are free.

const FLIGHT_CACHE_TTL = 300; // 5 min: flight status moves slowly
const FAA_CACHE_TTL = 120;

// "FLIGHT UA123" / "FLT DL 456" / "FLIGHT SK936 on 7/24" keyword prefix.
export function parseFlightCommand(body: string, now: Date = new Date()): { flight: string; date: string | null } | null {
  const m = body
    .trim()
    .match(/^(?:flight|flt)\b[\s:,-]*([A-Za-z0-9]{2}\s?[0-9]{1,4}[A-Za-z]?)(?:\s+(?:on\s+)?(.{3,20}))?$/i);
  if (!m || !m[1]) return null;
  const flight = normalizeFlightNo(m[1]);
  if (!flight) return null;
  const date = m[2] ? parseDateHint(m[2], now) : null;
  if (m[2] && !date) return null; // trailing junk that isn't a date: not a command
  return { flight, date };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// "7/24", "07-24", "jul 24", "july 24", "tomorrow", "today" -> ISO date.
// Year is inferred as the next occurrence (dates more than 2 days past roll
// into next year - nobody asks about last week's flight by bare month/day).
export function parseDateHint(text: string, now: Date = new Date()): string | null {
  const t = text.trim().toLowerCase();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (t === "today" || t === "tonight") return today.toISOString().slice(0, 10);
  if (t === "tomorrow" || t === "tmrw") {
    const d = new Date(today.getTime() + 86400_000);
    return d.toISOString().slice(0, 10);
  }
  let month: number | null = null;
  let day: number | null = null;
  const numeric = t.match(/^(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?$/);
  const named = t.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?$/) ?? t.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})$/);
  if (numeric) {
    month = parseInt(numeric[1] as string, 10);
    day = parseInt(numeric[2] as string, 10);
    if (numeric[3]) {
      let year = parseInt(numeric[3], 10);
      if (year < 100) year += 2000;
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
      return null;
    }
  } else if (named) {
    const [a, b] = [named[1] as string, named[2] as string];
    const monthName = /^\d/.test(a) ? b : a;
    const dayStr = /^\d/.test(a) ? a : b;
    const idx = MONTHS.findIndex((mn) => monthName.startsWith(mn));
    if (idx === -1) return null;
    month = idx + 1;
    day = parseInt(dayStr, 10);
  } else {
    return null;
  }
  if (month === null || day === null || month < 1 || month > 12 || day < 1 || day > 31) return null;
  let year = now.getUTCFullYear();
  const candidate = Date.UTC(year, month - 1, day);
  if (candidate < today.getTime() - 2 * 86400_000) year += 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// "ua 123" -> "UA123". IATA airline designator (2 alphanumeric, letter first
// allowed) + 1-4 digit number + optional operational suffix letter.
export function normalizeFlightNo(text: string): string | null {
  const compact = text.toUpperCase().replace(/\s+/g, "");
  const m = compact.match(/^([A-Z][A-Z0-9]|[0-9][A-Z])([0-9]{1,4})([A-Z]?)$/);
  if (!m) return null;
  return `${m[1]}${m[2]}${m[3] ?? ""}`;
}

// IATA airline code -> ICAO callsign prefix, for adsbdb lookups (majors only;
// unknown codes are tried as-is).
const IATA_TO_ICAO: Record<string, string> = {
  UA: "UAL", AA: "AAL", DL: "DAL", WN: "SWA", AS: "ASA", B6: "JBU", NK: "NKS",
  F9: "FFT", HA: "HAL", G4: "AAY", SY: "SCX", AC: "ACA", WS: "WJA", BA: "BAW",
  LH: "DLH", AF: "AFR", KL: "KLM", EK: "UAE", QF: "QFA", NZ: "ANZ", JL: "JAL",
  NH: "ANA", SQ: "SIA", VS: "VIR", IB: "IBE", AM: "AMX", SK: "SAS", LX: "SWR",
  OS: "AUA", AY: "FIN", TK: "THY", EI: "EIN", TP: "TAP", LO: "LOT",
};

export function toCallsign(flightNo: string): string {
  const m = flightNo.match(/^([A-Z][A-Z0-9]|[0-9][A-Z])([0-9]{1,4}[A-Z]?)$/);
  if (!m) return flightNo;
  const icao = IATA_TO_ICAO[m[1] as string];
  return icao ? `${icao}${m[2]}` : flightNo;
}

// "2026-07-18 14:20-05:00" or ISO-T variants -> "2:20pm".
export function fmtLocalTime(isoLocal: string | undefined | null): string | null {
  if (!isoLocal) return null;
  const m = isoLocal.match(/[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  const h = parseInt(m[1] as string, 10);
  const ampm = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]}${ampm}`;
}

function minutesBetween(aIso?: string, bIso?: string): number | null {
  if (!aIso || !bIso) return null;
  const a = Date.parse(aIso.replace(" ", "T"));
  const b = Date.parse(bIso.replace(" ", "T"));
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 60000);
}

// ---------- FAA NAS Status (airport-level context) ----------

export interface FaaEvent {
  arpt: string;
  note: string;
}

// The feed is XML; Workers have no DOMParser, so scan the delay blocks with
// tolerant regexes. Structure per FAA: Ground_Stop_List / Ground_Delay_List /
// Arrival_Departure_Delay_List / Airport_Closure_List, each entry carrying an
// <ARPT> code plus Reason and (varying) time fields.
export function parseFaaNasXml(xml: string): FaaEvent[] {
  const events: FaaEvent[] = [];
  const push = (arpt: string | undefined, note: string) => {
    if (arpt) events.push({ arpt: arpt.trim().toUpperCase(), note });
  };
  const field = (block: string, tag: string): string | undefined =>
    block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, "i"))?.[1]?.trim() || undefined;

  for (const m of xml.matchAll(/<Ground_Stop_List>([\s\S]*?)<\/Ground_Stop_List>/gi)) {
    for (const p of (m[1] as string).matchAll(/<Program>([\s\S]*?)<\/Program>/gi)) {
      const b = p[1] as string;
      const reason = field(b, "Reason");
      const end = field(b, "End_Time");
      push(field(b, "ARPT"), `ground stop${reason ? ` (${reason})` : ""}${end ? ` until ${end}` : ""}`);
    }
  }
  for (const m of xml.matchAll(/<Ground_Delay_List>([\s\S]*?)<\/Ground_Delay_List>/gi)) {
    for (const p of (m[1] as string).matchAll(/<Ground_Delay>([\s\S]*?)<\/Ground_Delay>/gi)) {
      const b = p[1] as string;
      const reason = field(b, "Reason");
      const avg = field(b, "Avg");
      push(field(b, "ARPT"), `ground delays${avg ? ` avg ${avg}` : ""}${reason ? ` (${reason})` : ""}`);
    }
  }
  for (const m of xml.matchAll(/<Arrival_Departure_Delay_List>([\s\S]*?)<\/Arrival_Departure_Delay_List>/gi)) {
    for (const p of (m[1] as string).matchAll(/<Delay>([\s\S]*?)<\/Delay>/gi)) {
      const b = p[1] as string;
      const reason = field(b, "Reason");
      const min = field(b, "Min");
      const max = field(b, "Max");
      const span = min && max ? ` ${min}-${max}` : "";
      push(field(b, "ARPT"), `delays${span}${reason ? ` (${reason})` : ""}`);
    }
  }
  for (const m of xml.matchAll(/<Airport_Closure_List>([\s\S]*?)<\/Airport_Closure_List>/gi)) {
    for (const p of (m[1] as string).matchAll(/<Airport>([\s\S]*?)<\/Airport>/gi)) {
      const b = p[1] as string;
      const reason = field(b, "Reason");
      push(field(b, "ARPT"), `CLOSED${reason ? ` (${reason})` : ""}`);
    }
  }
  return events;
}

async function faaContext(env: Env, airports: string[]): Promise<string[]> {
  try {
    const kv = env.SMS_STATE;
    let xml = await kv.get("faa:nas");
    if (!xml) {
      const res = await fetch("https://nasstatus.faa.gov/api/airport-status-information", {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return [];
      xml = await res.text();
      await kv.put("faa:nas", xml, { expirationTtl: FAA_CACHE_TTL });
    }
    const events = parseFaaNasXml(xml);
    const want = new Set(airports.map((a) => a.toUpperCase()));
    return events.filter((e) => want.has(e.arpt)).map((e) => `${e.arpt}: ${e.note}`);
  } catch {
    return []; // context only - never break the answer
  }
}

// ---------- Tier 1: AeroDataBox ----------

interface AdbMovement {
  airport?: { iata?: string; municipalityName?: string; name?: string };
  scheduledTime?: { local?: string; utc?: string };
  revisedTime?: { local?: string; utc?: string };
  terminal?: string;
  gate?: string;
}
interface AdbFlight {
  number?: string;
  status?: string;
  departure?: AdbMovement;
  arrival?: AdbMovement;
  airline?: { name?: string };
}

function movementText(label: string, mv: AdbMovement | undefined): string | null {
  if (!mv) return null;
  const sched = fmtLocalTime(mv.scheduledTime?.local);
  const revised = fmtLocalTime(mv.revisedTime?.local);
  const late = minutesBetween(mv.scheduledTime?.local, mv.revisedTime?.local);
  let t = revised && late !== null && Math.abs(late) >= 5 ? `${revised} (sched ${sched})` : (sched ?? revised);
  if (!t) return null;
  const place: string[] = [];
  if (mv.terminal) place.push(`T${mv.terminal}`);
  if (mv.gate) place.push(`gate ${mv.gate}`);
  return `${label} ${t}${place.length ? ` ${place.join(" ")}` : ""}`;
}

function pickRelevant(flights: AdbFlight[]): AdbFlight | undefined {
  const active = flights.filter((f) => f.status !== "Arrived" && f.status !== "Canceled" && f.status !== "CanceledUncertain");
  return active[0] ?? flights[0];
}

export function formatAdbFlight(flightNo: string, flights: AdbFlight[]): string | null {
  const f = pickRelevant(flights);
  if (!f) return null;
  const depIata = f.departure?.airport?.iata ?? f.departure?.airport?.municipalityName ?? "?";
  const arrIata = f.arrival?.airport?.iata ?? f.arrival?.airport?.municipalityName ?? "?";
  const dep = movementText("dep", f.departure);
  const arr = movementText("arr", f.arrival);
  const delayMin = minutesBetween(f.departure?.scheduledTime?.local, f.departure?.revisedTime?.local);
  const status =
    f.status === "Expected" || f.status === "CheckIn" || f.status === "Boarding" || f.status === "GateClosed"
      ? delayMin !== null && delayMin >= 5
        ? `delayed ~${delayMin} min`
        : "on time"
      : (f.status ?? "scheduled").toLowerCase();
  const parts = [dep, arr].filter(Boolean);
  return `${flightNo} ${depIata}-${arrIata}: ${status}. ${parts.join("; ")}.`;
}

async function fromAeroDataBox(
  env: Env,
  flightNo: string,
  label: string,
  dateIso: string | null,
  dayWord: string
): Promise<{ text: string; airports: string[] } | null> {
  if (!env.AERODATABOX_KEY) return null;
  const path = dateIso
    ? `flights/number/${encodeURIComponent(flightNo)}/${dateIso}`
    : `flights/number/${encodeURIComponent(flightNo)}`;
  const res = await fetch(`https://aerodatabox.p.rapidapi.com/${path}?withAircraftImage=false&withLocation=false`, {
    headers: {
      "X-RapidAPI-Key": env.AERODATABOX_KEY,
      "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) {
    return {
      text: `No flight ${flightNo} found for ${dayWord}. Double-check the number - and schedules more than a few days out may not be loaded yet.`,
      airports: [],
    };
  }
  if (!res.ok) throw new Error(`AeroDataBox HTTP ${res.status}`);
  const flights = (await res.json()) as AdbFlight[];
  if (!Array.isArray(flights) || flights.length === 0) {
    return {
      text: `No flight ${flightNo} found for ${dayWord}. Double-check the number - and schedules more than a few days out may not be loaded yet.`,
      airports: [],
    };
  }
  const text = formatAdbFlight(label, flights);
  if (!text) return null;
  const f = pickRelevant(flights);
  const airports = [f?.departure?.airport?.iata, f?.arrival?.airport?.iata].filter((a): a is string => !!a);
  return { text, airports };
}

// ---------- Tier 2: aviationstack ----------

interface AvsFlight {
  flight_status?: string;
  departure?: { iata?: string; terminal?: string | null; gate?: string | null; delay?: number | null; scheduled?: string; estimated?: string };
  arrival?: { iata?: string; terminal?: string | null; gate?: string | null; scheduled?: string; estimated?: string };
}

export function formatAvsFlight(flightNo: string, f: AvsFlight): string {
  const dep = f.departure ?? {};
  const arr = f.arrival ?? {};
  const depT = fmtLocalTime(dep.estimated ?? dep.scheduled);
  const arrT = fmtLocalTime(arr.estimated ?? arr.scheduled);
  const bits: string[] = [];
  if (depT) bits.push(`dep ${depT}${dep.terminal ? ` T${dep.terminal}` : ""}${dep.gate ? ` gate ${dep.gate}` : ""}`);
  if (arrT) bits.push(`arr ${arrT}${arr.terminal ? ` T${arr.terminal}` : ""}${arr.gate ? ` gate ${arr.gate}` : ""}`);
  const status = dep.delay && dep.delay >= 5 ? `delayed ~${dep.delay} min` : (f.flight_status ?? "scheduled");
  return `${flightNo} ${dep.iata ?? "?"}-${arr.iata ?? "?"}: ${status}. ${bits.join("; ")}.`;
}

async function fromAviationstack(env: Env, flightNo: string): Promise<{ text: string; airports: string[] } | null> {
  if (!env.AVIATIONSTACK_KEY) return null;
  const res = await fetch(
    `https://api.aviationstack.com/v1/flights?access_key=${env.AVIATIONSTACK_KEY}&flight_iata=${encodeURIComponent(flightNo)}&limit=3`,
    { signal: AbortSignal.timeout(10_000) }
  );
  if (!res.ok) throw new Error(`aviationstack HTTP ${res.status}`);
  const data = (await res.json()) as { data?: AvsFlight[] };
  const f = data.data?.find((x) => x.flight_status !== "landed" && x.flight_status !== "cancelled") ?? data.data?.[0];
  if (!f) return null;
  return {
    text: formatAvsFlight(flightNo, f),
    airports: [f.departure?.iata, f.arrival?.iata].filter((a): a is string => !!a),
  };
}

// ---------- Tier 3: adsbdb (route only, keyless) ----------

async function fromAdsbdb(flightNo: string): Promise<{ text: string; airports: string[] } | null> {
  const callsign = toCallsign(flightNo);
  const res = await fetch(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`, {
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    response?: { flightroute?: { airline?: { name?: string }; origin?: { iata_code?: string; municipality?: string }; destination?: { iata_code?: string; municipality?: string } } };
  };
  const r = data.response?.flightroute;
  if (!r?.origin?.iata_code || !r.destination?.iata_code) return null;
  const airline = r.airline?.name ? `${r.airline.name} ` : "";
  return {
    text: `${flightNo} is ${airline}${r.origin.municipality ?? r.origin.iata_code} (${r.origin.iata_code}) to ${r.destination.municipality ?? r.destination.iata_code} (${r.destination.iata_code}). Live times aren't available right now - check your airline's app when you have data.`,
    airports: [r.origin.iata_code, r.destination.iata_code],
  };
}

// ---------- Entry point ----------

export async function flightAnswer(
  env: Env,
  rawFlightNo: string,
  dateIso: string | null = null
): Promise<{ answer: string; answered: boolean }> {
  const flightNo = normalizeFlightNo(rawFlightNo);
  if (!flightNo) {
    return { answer: `Which flight? Use the airline code + number, e.g. "FLIGHT UA123" or "FLIGHT DL 456 on 7/24".`, answered: false };
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const isToday = !dateIso || dateIso === todayIso;
  // "Jul 24" label on the answer whenever a specific non-today date was asked.
  const monthName = isToday ? "" : (MONTHS[parseInt(dateIso.slice(5, 7), 10) - 1] ?? "");
  const dayWord = isToday
    ? "today"
    : `${monthName.charAt(0).toUpperCase()}${monthName.slice(1)} ${parseInt(dateIso.slice(8, 10), 10)}`;
  const label = isToday ? flightNo : `${flightNo} (${dayWord})`;

  const kv = env.SMS_STATE;
  const cacheKey = `flight:${flightNo}:${dateIso ?? todayIso}`;
  const cached = await kv.get(cacheKey);
  if (cached) return { answer: cached, answered: true };

  let result: { text: string; airports: string[] } | null = null;
  try {
    result = await fromAeroDataBox(env, flightNo, label, isToday ? null : dateIso, dayWord);
  } catch (err) {
    console.error("aerodatabox failed:", err instanceof Error ? err.message : String(err));
  }
  // The fallbacks only know about today: for other dates, an honest miss
  // beats a silently-wrong answer about the wrong day.
  if (!result && isToday) {
    try {
      result = await fromAviationstack(env, flightNo);
    } catch (err) {
      console.error("aviationstack failed:", err instanceof Error ? err.message : String(err));
    }
  }
  if (!result && isToday) {
    try {
      result = await fromAdsbdb(flightNo);
    } catch (err) {
      console.error("adsbdb failed:", err instanceof Error ? err.message : String(err));
    }
  }
  if (!result) {
    return {
      answer: `Couldn't find flight ${flightNo} for ${dayWord} right now. Double-check the number, or try again in a minute.`,
      answered: false,
    };
  }

  // Airport ground-stop context only makes sense for today's operations.
  const context = isToday ? await faaContext(env, result.airports) : [];
  const answer = context.length ? `${result.text} Airport status - ${context.join("; ")}.` : result.text;
  await kv.put(cacheKey, answer, { expirationTtl: FLIGHT_CACHE_TTL });
  return { answer, answered: true };
}
