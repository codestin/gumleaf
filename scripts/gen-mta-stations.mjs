// Generate src/mta-stations.ts from the MTA Subway Stations dataset
// (data.ny.gov 39hk-dx4f). Run: node scripts/gen-mta-stations.mjs
import { writeFileSync } from "node:fs";

const CSV_URL = "https://data.ny.gov/api/views/39hk-dx4f/rows.csv?accessType=DOWNLOAD";
const OUT = new URL("../src/mta-stations.ts", import.meta.url);

// The dataset's direction labels are sometimes just "Inbound"/"Outbound";
// riders think in terminals, so those are replaced with each route's terminal
// names ("/"-joined across a station's routes). Real labels ("Manhattan",
// "Uptown", "Last Stop") pass through untouched.
const TERMINALS = {
  1: ["Van Cortlandt Park", "South Ferry"],
  2: ["Wakefield-241 St", "Flatbush Av"],
  3: ["Harlem-148 St", "New Lots Av"],
  4: ["Woodlawn", "Utica Av"],
  5: ["Dyre Av", "Flatbush Av"],
  6: ["Pelham Bay Park", "Brooklyn Bridge"],
  7: ["Flushing-Main St", "34 St-Hudson Yards"],
  A: ["Inwood-207 St", "Far Rockaway/Ozone Park"],
  B: ["Bedford Park Blvd", "Brighton Beach"],
  C: ["168 St", "Euclid Av"],
  D: ["Norwood-205 St", "Coney Island"],
  E: ["Jamaica Center", "World Trade Center"],
  F: ["Jamaica-179 St", "Coney Island"],
  G: ["Court Sq", "Church Av"],
  J: ["Jamaica Center", "Broad St"],
  Z: ["Jamaica Center", "Broad St"],
  L: ["8 Av", "Canarsie-Rockaway Pkwy"],
  M: ["Forest Hills-71 Av", "Middle Village"],
  N: ["Astoria-Ditmars Blvd", "Coney Island"],
  Q: ["96 St", "Coney Island"],
  R: ["Forest Hills-71 Av", "Bay Ridge-95 St"],
  W: ["Astoria-Ditmars Blvd", "Whitehall St"],
  SIR: ["St George", "Tottenville"],
};

// The three "S" shuttles are distinguished by stop-id prefix (9xx = 42 St,
// H = Rockaway Park, S0x = Franklin Av), same rule as feed selection in mta.ts.
function shuttleTerminal(stopId, dirIx) {
  if (stopId.startsWith("9")) return dirIx === 0 ? "Times Sq" : "Grand Central";
  if (stopId.startsWith("H")) return dirIx === 0 ? "Broad Channel" : "Rockaway Park";
  return dirIx === 0 ? "Franklin Av" : "Prospect Park";
}

function fixLabel(label, routes, stopId, dirIx, stationName) {
  if (label && label !== "Inbound" && label !== "Outbound") return label;
  const names = [];
  for (const r of routes.split(" ")) {
    const t = r === "S" ? shuttleTerminal(stopId, dirIx) : TERMINALS[r]?.[dirIx];
    if (!t) continue;
    // A station never labels a direction with itself ("to Broad Channel" at
    // Broad Channel, where the shuttle only leaves the other way).
    for (const part of t.split("/")) if (part !== stationName && !names.includes(part)) names.push(part);
  }
  return names.join("/") || label;
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const res = await fetch(CSV_URL);
if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
const rows = parseCsv(await res.text());
const header = rows[0];
const col = (name) => {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`missing column ${name}`);
  return i;
};
const iStop = col("GTFS Stop ID");
const iName = col("Stop Name");
const iBoro = col("Borough");
const iRoutes = col("Daytime Routes");
const iNorth = col("North Direction Label");
const iSouth = col("South Direction Label");

const seen = new Set();
const entries = [];
for (const r of rows.slice(1)) {
  if (!r[iStop]) continue;
  if (seen.has(r[iStop])) continue; // dataset occasionally duplicates rows
  seen.add(r[iStop]);
  const routes = r[iRoutes].trim().split(/\s+/).join(" ");
  const stopId = r[iStop];
  entries.push([
    stopId,
    r[iName].trim(),
    r[iBoro].trim(),
    routes,
    fixLabel(r[iNorth].trim(), routes, stopId, 0, r[iName].trim()),
    fixLabel(r[iSouth].trim(), routes, stopId, 1, r[iName].trim()),
  ]);
}
entries.sort((a, b) => a[0].localeCompare(b[0]));

// Sanity: report route tokens and S-shuttle stop-id prefixes for feed mapping.
const routeSet = new Set();
for (const e of entries) e[3].split(" ").forEach((x) => routeSet.add(x));
console.error("route tokens:", [...routeSet].sort().join(" "));
console.error("S-only rows:", entries.filter((e) => e[3].split(" ").includes("S")).map((e) => `${e[0]}:${e[3]}`).join(", "));
console.error("SIR rows:", entries.filter((e) => e[3].includes("SIR")).length);
console.error("total:", entries.length);

const lines = entries.map((e) => `  ${JSON.stringify(e)},`);
writeFileSync(OUT, `// NYC subway stations: [gtfsStopId, name, borough, routes, northLabel, southLabel].
// Generated from the MTA Subway Stations dataset (data.ny.gov 39hk-dx4f, July 2026)
// by scripts/gen-mta-stations.mjs - regenerate rather than hand-editing.
// Bare "Inbound"/"Outbound" dataset labels are replaced with route terminal
// names at generation time; "Last Stop" directions are skipped at format time.
// Borough: M=Manhattan, Bk=Brooklyn, Q=Queens, Bx=Bronx, SI=Staten Island.
export type MtaStation = [string, string, string, string, string, string];

export const MTA_STATIONS: MtaStation[] = [
${lines.join("\n")}
];
`);
