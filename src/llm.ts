import type { ForecastPeriod } from "./weather";
import type { Env } from "./env";

export interface Classified {
  kind: "weather" | "general" | "transit" | "flight";
  location: string | null;
  agency: "bart" | "caltrain" | "subway" | null;
  stop: string | null;
  flight: string | null;
  flight_date: string | null;
  answer: string;
}

function model(env: Env): string {
  return env.LLM_MODEL ?? "gpt-4o";
}

async function chatJson(env: Env, systemPrompt: string, userContent: string): Promise<unknown> {
  const baseUrl = env.LLM_BASE_URL ?? "https://api.openai.com";
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.LLM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model(env),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM request failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM returned no content");
  return JSON.parse(content);
}

// Plain-ASCII instruction keeps replies in GSM-7 (160 chars/segment vs 70 for
// UCS-2), which roughly halves the Twilio cost of each answer.
const ASCII_RULE =
  'Use plain ASCII only: write temperatures like "9C" not "9°C", use straight quotes, hyphens not dashes, no emoji.';

// "Fri, 18 Jul 2026" — grounds date-relative questions ("days until Labor
// Day?"), which the model otherwise answers from its training cutoff.
function dateLine(now: Date): string {
  return `Today is ${now.toUTCString().slice(0, 16)} (UTC).`;
}

// Exported for tests. The 450-char aim keeps good answers inside 3 concatenated
// GSM-7 segments; short questions should still get short answers.
export function classifyPrompt(now: Date): string {
  return `You are a sharp, warm assistant answering SMS messages for one person, who may be texting over a slow satellite link with no internet. ${dateLine(now)} ${ASCII_RULE} Respond ONLY with a JSON object:
{"kind": "weather" | "general" | "transit" | "flight", "location": string or null, "agency": "bart" | "caltrain" | "subway" | null, "stop": string or null, "flight": string or null, "flight_date": string or null, "answer": string}

- kind: "weather" if the message asks about weather/forecast/conditions/sunrise/sunset/daylight hours. "transit" if it asks about NYC subway, BART, or Caltrain trains/departures/schedules. "flight" if it asks about a specific flight's status/delay/gate and gives a flight number. Otherwise "general".
- location: for "weather", the place asked about, or null if none. Format "City" or "City, Region" (e.g. "Bergen, Norway"). Otherwise null.
- agency: for "transit", "subway" (NYC subway/MTA), "bart", or "caltrain"; null otherwise. Questions about other transit systems are "general" - answer normally and note that live train times cover the NYC subway, BART, and Caltrain so far.
- stop: for "transit", the station/stop name asked about, or null if none given. For the subway, include the line if the message gives one (e.g. "Bedford Av L").
- flight: for "flight", the flight number like "UA123", or null if none given.
- flight_date: for "flight", the specific date asked about as "YYYY-MM-DD" (resolve relative dates like "tomorrow" or "7/24" using today's date; assume the next future occurrence), or null when no date is mentioned.
- answer: the reply, plain text, no markdown. For factual or how-to questions, lead with the direct answer and pack in the useful specifics. For jokes, riddles, or casual chat, just be fun - no lectures or disclaimers. Aim for under 450 characters, and use that space only when the question needs it: a short question deserves a short answer. If kind is "weather", "transit", or "flight", set answer to "" (real data is fetched separately).`;
}

export async function classifyAndAnswer(env: Env, message: string): Promise<Classified> {
  const raw = (await chatJson(env, classifyPrompt(new Date()), message)) as Partial<Classified>;
  const kind =
    raw.kind === "weather" || raw.kind === "transit" || raw.kind === "flight" ? raw.kind : "general";
  return {
    kind,
    location: typeof raw.location === "string" && raw.location.trim() ? raw.location : null,
    agency: raw.agency === "bart" || raw.agency === "caltrain" || raw.agency === "subway" ? raw.agency : null,
    stop: typeof raw.stop === "string" && raw.stop.trim() ? raw.stop : null,
    flight: typeof raw.flight === "string" && raw.flight.trim() ? raw.flight : null,
    flight_date:
      typeof raw.flight_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.flight_date) ? raw.flight_date : null,
    answer: typeof raw.answer === "string" ? raw.answer : "",
  };
}

// Exported for tests.
export function weatherPrompt(now: Date): string {
  return `You summarize a real weather forecast for an SMS reply. ${dateLine(now)} Use ONLY the forecast data provided; do not invent conditions or numbers. Keep units as given but ${ASCII_RULE} Respond ONLY with a JSON object:
{"answer": string}

- answer: the key forecast info answering the question, under 450 characters, plain text, no markdown. Include temps and conditions. If sunrise/sunset times are included in the data, mention them ONLY when the question asks about them.`;
}

export async function summarizeForecast(
  env: Env,
  question: string,
  locationName: string,
  periods: ForecastPeriod[],
  sunText?: string
): Promise<string> {
  const forecastText =
    periods
      .map(
        (p) =>
          `${p.name}: ${p.temperature}${p.temperatureUnit}, wind ${p.windSpeed} ${p.windDirection}. ${p.detailedForecast}`
      )
      .join("\n") + (sunText ? `\n${sunText}` : "");
  const raw = (await chatJson(
    env,
    weatherPrompt(new Date()),
    `Question: ${question}\nLocation: ${locationName}\nForecast:\n${forecastText}`
  )) as { answer?: string };
  if (typeof raw.answer !== "string") {
    throw new Error("LLM weather summary missing answer field");
  }
  return raw.answer;
}
