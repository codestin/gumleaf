// Sender timezone, derived per request and never stored. Twilio's inbound SMS
// webhook carries FromCountry/FromState (area-code geography) for North
// American numbers; WhatsApp sends neither, so the E.164 prefix is the last
// resort. The point is the date line in the model prompts: a UTC stamp was a
// day ahead of a Saturday-evening question from California.

// US states and territories -> dominant zone. Split states (TX, FL, ID, KY,
// TN, ND, SD, NE, KS, OR, MI, IN) take the zone most of their people live in;
// worst case is an hour off, never a day.
const US_STATE_ZONE: Record<string, string> = {
  CT: "America/New_York", DC: "America/New_York", DE: "America/New_York", FL: "America/New_York",
  GA: "America/New_York", IN: "America/New_York", KY: "America/New_York", MA: "America/New_York",
  MD: "America/New_York", ME: "America/New_York", MI: "America/New_York", NC: "America/New_York",
  NH: "America/New_York", NJ: "America/New_York", NY: "America/New_York", OH: "America/New_York",
  PA: "America/New_York", RI: "America/New_York", SC: "America/New_York", VA: "America/New_York",
  VT: "America/New_York", WV: "America/New_York",
  AL: "America/Chicago", AR: "America/Chicago", IA: "America/Chicago", IL: "America/Chicago",
  KS: "America/Chicago", LA: "America/Chicago", MN: "America/Chicago", MO: "America/Chicago",
  MS: "America/Chicago", ND: "America/Chicago", NE: "America/Chicago", OK: "America/Chicago",
  SD: "America/Chicago", TN: "America/Chicago", TX: "America/Chicago", WI: "America/Chicago",
  CO: "America/Denver", ID: "America/Denver", MT: "America/Denver", NM: "America/Denver",
  UT: "America/Denver", WY: "America/Denver",
  AZ: "America/Phoenix",
  CA: "America/Los_Angeles", NV: "America/Los_Angeles", OR: "America/Los_Angeles", WA: "America/Los_Angeles",
  AK: "America/Anchorage",
  HI: "Pacific/Honolulu",
  PR: "America/Puerto_Rico", VI: "America/St_Thomas", GU: "Pacific/Guam", MP: "Pacific/Saipan", AS: "Pacific/Pago_Pago",
};

const CA_PROVINCE_ZONE: Record<string, string> = {
  NL: "America/St_Johns",
  NS: "America/Halifax", NB: "America/Halifax", PE: "America/Halifax",
  QC: "America/Toronto", ON: "America/Toronto",
  MB: "America/Winnipeg",
  SK: "America/Regina",
  AB: "America/Edmonton",
  BC: "America/Vancouver",
  YT: "America/Whitehorse", NT: "America/Yellowknife", NU: "America/Iqaluit",
};

// Countries where one zone covers (nearly) everyone. US and Canada are
// deliberately absent: without a state they stay unknown rather than guessed.
const COUNTRY_ZONE: Record<string, string> = {
  GB: "Europe/London", IE: "Europe/Dublin", PT: "Europe/Lisbon",
  NO: "Europe/Oslo", SE: "Europe/Stockholm", DK: "Europe/Copenhagen", FI: "Europe/Helsinki", IS: "Atlantic/Reykjavik",
  DE: "Europe/Berlin", FR: "Europe/Paris", NL: "Europe/Amsterdam", BE: "Europe/Brussels", ES: "Europe/Madrid",
  IT: "Europe/Rome", AT: "Europe/Vienna", CH: "Europe/Zurich", PL: "Europe/Warsaw", CZ: "Europe/Prague",
  HU: "Europe/Budapest", GR: "Europe/Athens", RO: "Europe/Bucharest", TR: "Europe/Istanbul",
  IL: "Asia/Jerusalem", AE: "Asia/Dubai", IN: "Asia/Kolkata", SG: "Asia/Singapore", HK: "Asia/Hong_Kong",
  TW: "Asia/Taipei", CN: "Asia/Shanghai", JP: "Asia/Tokyo", KR: "Asia/Seoul", PH: "Asia/Manila",
  TH: "Asia/Bangkok", VN: "Asia/Ho_Chi_Minh", MY: "Asia/Kuala_Lumpur", ID: "Asia/Jakarta",
  AU: "Australia/Sydney", NZ: "Pacific/Auckland",
  MX: "America/Mexico_City", BR: "America/Sao_Paulo", AR: "America/Argentina/Buenos_Aires",
  CL: "America/Santiago", CO: "America/Bogota", PE: "America/Lima",
  ZA: "Africa/Johannesburg", KE: "Africa/Nairobi", NG: "Africa/Lagos", EG: "Africa/Cairo",
};

// E.164 calling code -> ISO country, for numbers that arrive without geo
// hints. +1 is shared by the US, Canada and the Caribbean, so it maps to
// nothing on purpose. Longest prefix wins.
const PREFIX_COUNTRY: Record<string, string> = {
  "44": "GB", "353": "IE", "351": "PT",
  "47": "NO", "46": "SE", "45": "DK", "358": "FI", "354": "IS",
  "49": "DE", "33": "FR", "31": "NL", "32": "BE", "34": "ES", "39": "IT", "43": "AT", "41": "CH",
  "48": "PL", "420": "CZ", "36": "HU", "30": "GR", "40": "RO", "90": "TR",
  "972": "IL", "971": "AE", "91": "IN", "65": "SG", "852": "HK", "886": "TW", "86": "CN", "81": "JP",
  "82": "KR", "63": "PH", "66": "TH", "84": "VN", "60": "MY", "62": "ID",
  "61": "AU", "64": "NZ",
  "52": "MX", "55": "BR", "54": "AR", "56": "CL", "57": "CO", "51": "PE",
  "27": "ZA", "254": "KE", "234": "NG", "20": "EG",
};

export interface SenderHints {
  country?: string; // Twilio FromCountry, ISO 3166-1 alpha-2
  state?: string; // Twilio FromState: US state or Canadian province code
  from?: string; // E.164 number, used only when the geo hints are missing
}

function countryFromNumber(from: string): string | undefined {
  const digits = from.replace(/[^0-9]/g, "");
  for (const len of [3, 2, 1]) {
    const hit = PREFIX_COUNTRY[digits.slice(0, len)];
    if (hit) return hit;
  }
  return undefined;
}

// IANA zone for the sender, or undefined when nothing trustworthy is known.
export function senderTimezone(hints: SenderHints): string | undefined {
  const country = (hints.country?.trim().toUpperCase() || (hints.from ? countryFromNumber(hints.from) : undefined)) ?? "";
  const state = hints.state?.trim().toUpperCase() ?? "";
  if (country === "US") return US_STATE_ZONE[state];
  if (country === "CA") return CA_PROVINCE_ZONE[state];
  return COUNTRY_ZONE[country];
}
