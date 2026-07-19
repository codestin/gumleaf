import type { Env } from "./env";
import { transit_realtime } from "gtfs-realtime-bindings";
import { MTA_STATIONS, type MtaStation } from "./mta-stations";

// Live NYC subway times from the MTA's GTFS-Realtime feeds: free, keyless,
// ~30s freshness, one protobuf feed per line group. Raw feed bytes are cached
// in KV so one fetch serves every station on those lines for 60s. Replies are
// formatted deterministically, no LLM call, same as BART/Caltrain.

const CACHE_TTL_SECONDS = 60; // KV minimum; feeds refresh ~every 30s anyway

const FEED_BASE = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2F";

// Route -> feed group (api.mta.info, July 2026). The three "S" shuttles live
// in different feeds; they're resolved per-station by stop-id prefix below.
const ROUTE_FEED: Record<string, string> = {
  "1": "gtfs", "2": "gtfs", "3": "gtfs", "4": "gtfs", "5": "gtfs", "6": "gtfs", "7": "gtfs",
  A: "gtfs-ace", C: "gtfs-ace", E: "gtfs-ace",
  B: "gtfs-bdfm", D: "gtfs-bdfm", F: "gtfs-bdfm", M: "gtfs-bdfm",
  G: "gtfs-g",
  J: "gtfs-jz", Z: "gtfs-jz",
  N: "gtfs-nqrw", Q: "gtfs-nqrw", R: "gtfs-nqrw", W: "gtfs-nqrw",
  L: "gtfs-l",
  SIR: "gtfs-si",
};

interface Station {
  stopId: string;
  name: string;
  borough: string;
  routes: string[];
  northLabel: string;
  southLabel: string;
}

function toStation(row: MtaStation): Station {
  return {
    stopId: row[0],
    name: row[1],
    borough: row[2],
    routes: row[3].split(" "),
    northLabel: row[4],
    southLabel: row[5],
  };
}

// Feeds needed for a station: one per route. 42 St shuttle stops (901/902) ride
// the main "gtfs" feed; Franklin (S0x) and Rockaway (H0x) shuttles ride "ace".
function feedsFor(st: Station): string[] {
  const feeds = new Set<string>();
  for (const r of st.routes) {
    if (r === "S") feeds.add(st.stopId.startsWith("9") ? "gtfs" : "gtfs-ace");
    else feeds.add(ROUTE_FEED[r] ?? "gtfs");
  }
  return [...feeds];
}

// Common spelled-out street suffixes -> the abbreviations the MTA names use,
// so "bedford avenue" still hits "Bedford Av".
const SUFFIX_ALIASES: Record<string, string> = {
  avenue: "av",
  ave: "av",
  street: "st",
  boulevard: "blvd",
  road: "rd",
  square: "sq",
  parkway: "pkwy",
  place: "pl",
  heights: "hts",
  center: "ctr",
  fort: "ft",
};

// Words that carry no station information ("bedford av station", "the L train").
const FILLER = new Set(["station", "stop", "train", "the", "line", "subway"]);

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nameTokens(s: string): string[] {
  return normalize(s)
    .split(" ")
    .filter((t) => t && !FILLER.has(t))
    .map((t) => SUFFIX_ALIASES[t] ?? t);
}

// "SUBWAY bedford av" / "MTA 86 st Q" keyword prefixes. Only the leading word
// is claimed, so "is the subway running" still reads as a sentence and goes to
// the classifier instead.
export function parseSubwayCommand(body: string): { stop: string } | null {
  const m = body.trim().match(/^(subway|mta)\b[\s:,-]*([\s\S]*)$/i);
  if (!m) return null;
  return { stop: (m[2] ?? "").trim() };
}

export type SubwayResolution =
  | { kind: "station"; station: Station }
  | { kind: "ambiguous"; name: string; options: string[] }
  | null;

function isRouteToken(t: string): boolean {
  return /^[a-z]$/.test(t) || /^[1-7]$/.test(t) || t === "sir";
}

// Resolve free text to a station. Tries the full text first (so "1 Av" is the
// station, not route 1); when that misses or is ambiguous, peels a leading or
// trailing route token ("86 st Q", "L bedford") and filters by that line.
export function resolveSubwayStation(text: string): SubwayResolution {
  const tokens = nameTokens(text);
  if (tokens.length === 0) return null;

  const full = matchStations(tokens, null);
  if (full.length === 1) return { kind: "station", station: full[0]! };

  let hinted: Station[] = [];
  const last = tokens[tokens.length - 1]!;
  const first = tokens[0]!;
  if (tokens.length > 1 && isRouteToken(last)) {
    hinted = matchStations(tokens.slice(0, -1), last.toUpperCase());
  }
  if (hinted.length !== 1 && tokens.length > 1 && isRouteToken(first)) {
    hinted = matchStations(tokens.slice(1), first.toUpperCase());
  }
  if (hinted.length === 1) return { kind: "station", station: hinted[0]! };

  const pool = hinted.length > 1 ? hinted : full;
  if (pool.length > 1) {
    return {
      kind: "ambiguous",
      name: pool[0]!.name,
      options: pool.map((s) => `${s.name} (${s.routes.join(" ")}, ${s.borough})`),
    };
  }
  return null;
}

// All best-scoring stations whose name matches every query token (as a token
// prefix), optionally restricted to one route. Multiple winners usually means
// a shared name like "86 St" across lines.
function matchStations(qTokens: string[], route: string | null): Station[] {
  let best: Station[] = [];
  let bestScore = -1;
  for (const row of MTA_STATIONS) {
    const st = toStation(row);
    if (route && !st.routes.includes(route)) continue;
    const nTokens = nameTokens(st.name);
    const exact = nTokens.join(" ") === qTokens.join(" ");
    // Single-char tokens must match a name token exactly ("1 Av"), never as a
    // prefix - otherwise "L bedford" hits "...Lehman College" instead of the
    // route-hint path.
    const hit = exact || qTokens.every((t) => nTokens.some((nt) => (t.length === 1 ? nt === t : nt.startsWith(t))));
    if (!hit) continue;
    const score = (exact ? 1000 : 100) - (nTokens.length - qTokens.length);
    if (score > bestScore) {
      bestScore = score;
      best = [st];
    } else if (score === bestScore) {
      best.push(st);
    }
  }
  return best;
}

export function subwayHint(): string {
  return `Which subway station? e.g. "SUBWAY Bedford Av", "SUBWAY 86 St Q", or "SUBWAY Astoria Blvd".`;
}

interface Arrival {
  route: string;
  dir: "N" | "S";
  mins: number;
}

// protobufjs int64 fields decode as Long | number depending on environment.
function toEpochSeconds(v: number | { toNumber(): number } | null | undefined): number {
  if (v == null) return 0;
  return typeof v === "number" ? v : v.toNumber();
}

async function fetchFeed(env: Env, feed: string): Promise<transit_realtime.FeedMessage> {
  const kv = env.SMS_STATE;
  const cacheKey = `transit:mta:${feed}`;
  let buf = await kv.get(cacheKey, "arrayBuffer");
  if (!buf) {
    const res = await fetch(`${FEED_BASE}${feed}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`MTA ${feed} failed: HTTP ${res.status}`);
    buf = await res.arrayBuffer();
    await kv.put(cacheKey, buf, { expirationTtl: CACHE_TTL_SECONDS });
  }
  return transit_realtime.FeedMessage.decode(new Uint8Array(buf));
}

// Pull upcoming arrivals for one station (platform stop ids are "<id>N"/"<id>S")
// out of a decoded feed. Exported for tests against a synthetic feed.
export function extractArrivals(msg: transit_realtime.IFeedMessage, stopId: string, now: Date): Arrival[] {
  const out: Arrival[] = [];
  for (const entity of msg.entity ?? []) {
    const tu = entity.tripUpdate;
    if (!tu) continue;
    const route = tu.trip?.routeId || "?";
    for (const stu of tu.stopTimeUpdate ?? []) {
      const sid = stu.stopId ?? "";
      if (!sid.startsWith(stopId)) continue;
      const dir = sid.slice(stopId.length);
      if (dir !== "N" && dir !== "S") continue;
      const t = toEpochSeconds(stu.arrival?.time) || toEpochSeconds(stu.departure?.time);
      if (!t) continue;
      const mins = Math.round((t * 1000 - now.getTime()) / 60000);
      if (mins < -1 || mins > 120) continue;
      out.push({ route, dir, mins: Math.max(0, mins) });
    }
  }
  return out.sort((a, b) => a.mins - b.mins);
}

// "Subway Bedford Av (L): to Manhattan: 3, 7 min; to Canarsie-Rockaway Pkwy:
// 2, 9 min." Route letters are shown per train only at multi-line stations.
export function formatArrivals(station: Station, arrivals: Arrival[]): string {
  const multiRoute = station.routes.length > 1;
  const sides: string[] = [];
  for (const dir of ["N", "S"] as const) {
    const label = (dir === "N" ? station.northLabel : station.southLabel) || (dir === "N" ? "northbound" : "southbound");
    // "Last Stop" arrivals are trains terminating here - nothing to board.
    if (label === "Last Stop") continue;
    const list = arrivals.filter((a) => a.dir === dir).slice(0, multiRoute ? 4 : 3);
    if (list.length === 0) continue;
    const times = list.map((a) => (multiRoute ? `${a.route} ${a.mins}` : `${a.mins}`)).join(", ");
    sides.push(`to ${label}: ${times} min`);
  }
  const head = `Subway ${station.name} (${station.routes.join(" ")})`;
  if (sides.length === 0) {
    return `${head}: no trains reported right now.`;
  }
  return `${head}: ${sides.join("; ")}. Live from MTA.`;
}

export async function subwayAnswer(env: Env, stopText: string): Promise<{ answer: string; answered: boolean }> {
  const resolved = resolveSubwayStation(stopText);
  if (!resolved) {
    return { answer: subwayHint(), answered: false };
  }
  if (resolved.kind === "ambiguous") {
    return {
      answer: `Which ${resolved.name}? Add the line, e.g. "SUBWAY ${resolved.name} ${firstRoute(resolved.options)}" - options: ${resolved.options.join("; ")}.`,
      answered: false,
    };
  }
  const station = resolved.station;
  try {
    const feeds = await Promise.all(feedsFor(station).map((f) => fetchFeed(env, f)));
    const now = new Date();
    const arrivals = feeds.flatMap((msg) => extractArrivals(msg, station.stopId, now));
    arrivals.sort((a, b) => a.mins - b.mins);
    return { answer: formatArrivals(station, arrivals), answered: true };
  } catch (err) {
    console.error("subway failed:", err instanceof Error ? err.message : String(err));
    return { answer: `Couldn't reach live MTA data just now - try again in a minute.`, answered: false };
  }
}

// First route letter from "Name (4 5 6, M)"-style option strings, for the
// disambiguation example.
function firstRoute(options: string[]): string {
  const m = options[0]?.match(/\(([^\s,)]+)/);
  return m?.[1] ?? "Q";
}
