import type { ForecastPeriod } from "./weather";
import type { Env } from "./env";

export interface Classified {
  kind: "weather" | "general";
  location: string | null;
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

const CLASSIFY_PROMPT = `You answer SMS messages for one person, who may be texting over a slow satellite link with no internet. ${ASCII_RULE} If earlier context is given, use it to resolve follow-ups. Respond ONLY with a JSON object:
{"kind": "weather" | "general", "location": string or null, "answer": string}

- kind: "weather" if the message asks about weather/forecast/conditions, otherwise "general".
- location: the place asked about, or null if none. Format "City" or "City, Region" (e.g. "Bergen, Norway"). For a weather follow-up with no new place, reuse the location from the earlier context. For "general", null.
- answer: a direct, useful answer under 300 characters, plain text, no markdown. If kind is "weather", set answer to "" (a real forecast is fetched separately).`;

export async function classifyAndAnswer(env: Env, message: string, context?: string): Promise<Classified> {
  const input = context ? `Earlier context:\n${context}\n\nNew message: ${message}` : message;
  const raw = (await chatJson(env, CLASSIFY_PROMPT, input)) as Partial<Classified>;
  const kind = raw.kind === "weather" ? "weather" : "general";
  return {
    kind,
    location: typeof raw.location === "string" && raw.location.trim() ? raw.location : null,
    answer: typeof raw.answer === "string" ? raw.answer : "",
  };
}

const WEATHER_PROMPT = `You summarize a real weather forecast for an SMS reply. Use ONLY the forecast data provided; do not invent conditions or numbers. Keep units as given but ${ASCII_RULE} Respond ONLY with a JSON object:
{"answer": string}

- answer: the key forecast info answering the question, under 300 characters, plain text, no markdown. Include temps and conditions.`;

export async function summarizeForecast(
  env: Env,
  question: string,
  locationName: string,
  periods: ForecastPeriod[]
): Promise<string> {
  const forecastText = periods
    .map(
      (p) =>
        `${p.name}: ${p.temperature}${p.temperatureUnit}, wind ${p.windSpeed} ${p.windDirection}. ${p.detailedForecast}`
    )
    .join("\n");
  const raw = (await chatJson(
    env,
    WEATHER_PROMPT,
    `Question: ${question}\nLocation: ${locationName}\nForecast:\n${forecastText}`
  )) as { answer?: string };
  if (typeof raw.answer !== "string") {
    throw new Error("LLM weather summary missing answer field");
  }
  return raw.answer;
}
