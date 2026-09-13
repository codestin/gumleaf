import { UpstreamError } from "./weather";
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

async function chatJson(env: Env, systemPrompt: string, userContent: string, timeoutMs = 8000): Promise<unknown> {
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
    signal: AbortSignal.timeout(timeoutMs),
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

// GSM-7 keeps replies at 160 chars/segment (vs 70 for UCS-2), roughly halving
// Twilio cost. Western European letters (æ ø å ä ö ü é...) are IN the GSM-7
// basic set, so answers about e.g. Norwegian words can spell them properly -
// forcing ASCII there once collapsed "smågodt"/"smaker godt" into the same
// string and sent the model into a repetition spiral. Only the typographic
// niceties (curly quotes, dashes, emoji, degree signs) flip a message to UCS-2.
const GSM_RULE =
  'Write GSM-friendly plain text: straight quotes, hyphens not dashes, no emoji, temperatures like "9C" not "9°C". Western European letters (æ ø å ä ö ü é è ñ) are fine - use them when spelling non-English words instead of flattening them to ASCII. Say each thing once; never repeat a phrase.';

// "Fri, 18 Jul 2026 12:00" — grounds date-relative questions ("days until
// Labor Day?"), which the model otherwise answers from its training cutoff.
// Including the time also varies the prompt through the day, so repeat casual
// asks ("tell me a joke") stop landing on the model's single modal output.
function dateLine(now: Date): string {
  return `Today is ${now.toUTCString().slice(0, 22)} UTC.`;
}

// Exported for tests. The 450-char aim keeps good answers inside 3 concatenated
// GSM-7 segments; short questions should still get short answers.
export function classifyPrompt(now: Date): string {
  return `You are a sharp, warm assistant answering SMS messages for one person, who may be texting over a slow satellite link with no internet. ${dateLine(now)} ${GSM_RULE} Respond ONLY with a JSON object:
{"kind": "weather" | "general" | "transit" | "flight", "location": string or null, "agency": "bart" | "caltrain" | "subway" | null, "stop": string or null, "flight": string or null, "flight_date": string or null, "answer": string}

- kind: "weather" if the message asks about weather/forecast/conditions/sunrise/sunset/daylight hours. "transit" if it asks about NYC subway, BART, or Caltrain trains/departures/schedules. "flight" if it asks about a specific flight's status/delay/gate and gives a flight number. Otherwise "general".
- location: for "weather", the place asked about, or null if none. Format "City" or "City, Region" (e.g. "Bergen, Norway"). Otherwise null.
- agency: for "transit", "subway" (NYC subway/MTA), "bart", or "caltrain"; null otherwise. Questions about other transit systems are "general" - answer normally and note that live train times cover the NYC subway, BART, and Caltrain so far.
- stop: for "transit", the station/stop name asked about, or null if none given. For the subway, include the line if the message gives one (e.g. "Bedford Av L").
- flight: for "flight", the flight number like "UA123", or null if none given.
- flight_date: for "flight", the specific date asked about as "YYYY-MM-DD" (resolve relative dates like "tomorrow" or "7/24" using today's date; assume the next future occurrence), or null when no date is mentioned.
- answer: the reply, plain text, no markdown. If the message refers to a photo or image but none came through, ask them to resend the photo and their question together in one message (no history is kept between texts). For factual or how-to questions, lead with the direct answer and pack in the specifics you're sure of. Accuracy beats completeness: for specific facts (numbers, dates, names, stats), state only what you actually know; if you're unsure, say so briefly or leave the detail out - a confidently wrong number is the worst possible answer. For jokes, riddles, or casual chat, just be fun - no lectures or disclaimers - and reach for something fresh rather than your most predictable material (there is no conversation history, so your obvious first choice is what they already heard). Aim for under 450 characters, and use that space only when the question needs it: a short question deserves a short answer. If kind is "weather", "transit", or "flight", set answer to "" (real data is fetched separately).`;
}

// LLM-down net for the one message shape that dominates traffic. Anything
// fancier ("will it rain tomorrow in X") still needs the model. Exported for tests.
export function regexClassify(body: string): Classified | null {
  const m = /^(?:(?:what|how)(?:'?s| is) the )?(?:weather|forecast|conditions?)\b\s*(?:like\s+)?(?:(?:in|for|at|near)\s+)?(.*?)[?!.\s]*$/i.exec(
    body.trim()
  );
  if (!m) return null;
  const location = m[1]?.trim() || null;
  return { kind: "weather", location, agency: null, stop: null, flight: null, flight_date: null, answer: "" };
}

export async function classifyAndAnswer(env: Env, message: string): Promise<Classified> {
  let raw: Partial<Classified>;
  try {
    raw = (await chatJson(env, classifyPrompt(new Date()), message)) as Partial<Classified>;
  } catch (err) {
    const fallback = regexClassify(message);
    if (fallback) {
      console.error("classify failed, using regex fallback:", err instanceof Error ? err.message : String(err));
      return fallback;
    }
    throw new UpstreamError("llm", err instanceof Error ? err.message : String(err));
  }
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
  return `You summarize a real weather forecast for an SMS reply. ${dateLine(now)} Use ONLY the forecast data provided; do not invent conditions or numbers. Keep units as given but ${GSM_RULE} Respond ONLY with a JSON object:
{"answer": string}

- answer: the key forecast info answering the question, under 450 characters, plain text, no markdown. Include temps and conditions. If sunrise/sunset times are included in the data, mention them ONLY when the question asks about them. If the question asks about dates beyond the forecast's range, say the forecast only goes about a week out and summarize the latest days provided.`;
}

export async function summarizeForecast(
  env: Env,
  question: string,
  locationName: string,
  periods: ForecastPeriod[],
  sunText?: string,
  timeoutMs = 8000
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
    `Question: ${question}\nLocation: ${locationName}\nForecast:\n${forecastText}`,
    timeoutMs
  )) as { answer?: string };
  if (typeof raw.answer !== "string") {
    throw new Error("LLM weather summary missing answer field");
  }
  return raw.answer;
}

// MMS photo questions: one vision call on the same model, image as a data URL.
// Uses the OpenAI-style image_url content part, which most OpenAI-compatible
// providers accept for their vision models; a text-only provider errors here
// and the caller replies with a friendly failure text. Exported for tests.
export function visionPrompt(now: Date): string {
  return `You are a sharp, warm assistant answering an SMS that came with a photo. ${dateLine(now)} ${GSM_RULE} Look at the photo and answer the sender's question about it; with no question, identify or describe what's shown and share the most useful details. Read specifics from the image itself - labels, text, landmarks. If you're not sure what something is, say so rather than guessing. Respond ONLY with a JSON object: {"answer": string} - plain text, no markdown, under 450 characters.`;
}

const VISION_DEFAULT_QUESTION = "What is in this photo? Identify it and share the most useful details.";

export async function visionAnswer(env: Env, question: string, imageDataUrl: string, timeoutMs = 10_000): Promise<string> {
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
        { role: "system", content: visionPrompt(new Date()) },
        {
          role: "user",
          content: [
            { type: "text", text: question || VISION_DEFAULT_QUESTION },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM vision request failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM vision returned no content");
  const raw = JSON.parse(content) as { answer?: string };
  if (typeof raw.answer !== "string" || !raw.answer.trim()) {
    throw new Error("LLM vision answer missing answer field");
  }
  return raw.answer;
}
