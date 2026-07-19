import type { Env } from "./env";
import { parseFormBody, twimlResponse, twimlResponseWithMedia, validateTwilioSignature } from "./twilio";
import { classifyAndAnswer, summarizeForecast } from "./llm";
import { geocode, getForecast, formatLocationName, getSunTimes, formatSunTimes } from "./weather";
import { getMetnoForecast } from "./metno";
import { getUsage, incrementUsage, isFirstContact, markSeen } from "./quota";
import { moderate } from "./moderation";
import { parseTransitCommand, transitAnswer } from "./transit";
import { parseFlightCommand, flightAnswer } from "./flight";
import * as msg from "./messages";

// Logged once per isolate (not per request) so `wrangler tail`/dev shows the
// moderation state without spamming every message.
let statusLogged = false;
function logModerationStatus(env: Env, enabled: boolean): void {
  if (statusLogged) return;
  statusLogged = true;
  if (!enabled) {
    console.log("moderation: disabled (MODERATION_ENABLED=false)");
    return;
  }
  const dedicated = !!env.MODERATION_API_KEY;
  const llmIsOpenAI = !env.LLM_BASE_URL || env.LLM_BASE_URL.includes("api.openai.com");
  if (dedicated || llmIsOpenAI) {
    console.log("moderation: on");
  } else {
    console.warn(
      "moderation: on, but LLM_BASE_URL isn't OpenAI and MODERATION_API_KEY is unset - " +
        "the moderation call fails open (is skipped). Set MODERATION_API_KEY to an OpenAI key to keep crisis detection."
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/sms") {
      return new Response("Not found", { status: 404 });
    }

    const missing = ["LLM_API_KEY", "TWILIO_AUTH_TOKEN", "WEATHER_USER_AGENT", "ALLOWED_NUMBERS"].filter(
      (name) => !(env as unknown as Record<string, string | undefined>)[name]
    );
    if (missing.length > 0) {
      return new Response(`Server misconfigured: missing ${missing.join(", ")}`, { status: 500 });
    }

    const params = await parseFormBody(request);

    // The dev bypass only works on localhost so it can't weaken production.
    const isLocalDev = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (!(env.SKIP_SIGNATURE_VALIDATION === "true" && isLocalDev)) {
      const signature = request.headers.get("X-Twilio-Signature") ?? "";
      const valid = await validateTwilioSignature(request.url, params, signature, env.TWILIO_AUTH_TOKEN);
      if (!valid) return new Response("Invalid signature", { status: 403 });
    }

    const from = params["From"] ?? "";
    const body = (params["Body"] ?? "").trim();
    const lowered = body.toLowerCase();

    // Allowlist: strangers are ignored so they can't burn your Twilio/LLM.
    const allowed = env.ALLOWED_NUMBERS.split(",").map((n) => n.trim()).filter(Boolean);
    if (!allowed.includes(from)) {
      return twimlResponse();
    }

    if (!body) return twimlResponse(msg.emptyBodyHint());
    if (lowered === "help") return twimlResponse(msg.helpText());
    // Text back the contact card (only when a card is configured; see VCARD_URL).
    if (env.VCARD_URL && (lowered === "contact" || lowered === "vcard" || lowered === "card" || lowered === "save")) {
      return twimlResponseWithMedia(msg.vcardKeywordReply(), msg.vcardIntro(), env.VCARD_URL);
    }

    // Moderation is on by default; set MODERATION_ENABLED=false to opt out.
    // Runs before the cost cap so crisis resources are never withheld.
    const moderationEnabled = env.MODERATION_ENABLED !== "false";
    logModerationStatus(env, moderationEnabled);
    if (moderationEnabled) {
      const verdict = await moderate(env, body);
      if (verdict === "self-harm") return twimlResponse(msg.crisisResources());
      if (verdict === "blocked") return twimlResponse(msg.moderationRefusal());
    }

    // Optional monthly cost cap.
    const limit = env.MONTHLY_LIMIT ? parseInt(env.MONTHLY_LIMIT, 10) : 0;
    if (limit > 0 && (await getUsage(env.SMS_STATE, from)) >= limit) {
      return twimlResponse(msg.capReached());
    }

    const firstContact = await isFirstContact(env.SMS_STATE, from);

    // No conversation memory, by design: every question is answered standalone
    // and nothing anyone asks is stored.
    let answer: Answer;
    try {
      answer = await handleQuestion(env, body);
    } catch (err) {
      console.error("answer failed:", err instanceof Error ? err.message : String(err));
      return twimlResponse("Sorry, something went wrong - please try again in a minute.");
    }

    if (answer.answered) {
      await incrementUsage(env.SMS_STATE, from);
    }
    if (firstContact) await markSeen(env.SMS_STATE, from);

    let reply = msg.clampSms(msg.toGsm7(answer.answer));
    if (firstContact) {
      reply += `\n\n${msg.welcomeFooter()}`;
      // First contact also gets the contact card as a follow-up MMS, if configured.
      if (env.VCARD_URL) return twimlResponseWithMedia(reply, msg.vcardIntro(), env.VCARD_URL);
    }
    return twimlResponse(reply);
  },
};

interface Answer {
  answer: string;
  answered: boolean;
}

async function handleQuestion(env: Env, body: string): Promise<Answer> {
  // "BART <station>" / "CALTRAIN <stop>" / "FLIGHT UA123 [on 7/24]" skip the
  // model entirely: live data, formatted deterministically.
  const transitCmd = parseTransitCommand(body);
  if (transitCmd) {
    return transitAnswer(env, transitCmd.agency, transitCmd.stop);
  }
  const flightCmd = parseFlightCommand(body);
  if (flightCmd) {
    return flightAnswer(env, flightCmd.flight, flightCmd.date);
  }

  const classified = await classifyAndAnswer(env, body);

  if (classified.kind === "flight") {
    if (!classified.flight) {
      return { answer: 'Which flight? Give me the airline code + number, e.g. "FLIGHT UA123".', answered: false };
    }
    return flightAnswer(env, classified.flight, classified.flight_date);
  }

  if (classified.kind === "transit") {
    if (!classified.agency) {
      return { answer: 'I have live train times for BART and Caltrain so far. Try "BART Embarcadero" or "CALTRAIN Palo Alto".', answered: false };
    }
    return transitAnswer(env, classified.agency, classified.stop ?? "");
  }

  if (classified.kind !== "weather") {
    return { answer: classified.answer, answered: true };
  }

  const locationQuery = classified.location ?? env.DEFAULT_LOCATION;
  if (!locationQuery) {
    const text = 'Which location? Try e.g. "weather in Oslo" or "weather in Boulder, CO".';
    return { answer: text, answered: false };
  }

  const geo = await geocode(locationQuery);
  if (!geo) {
    const text = `Couldn't find a place called "${locationQuery}". Try a city name or zip code.`;
    return { answer: text, answered: false };
  }

  // Sun times ride along with every forecast fetch; their failure must never
  // break the weather answer.
  const [periods, sun] = await Promise.all([
    geo.country_code === "US"
      ? getForecast(geo.latitude, geo.longitude, env.WEATHER_USER_AGENT)
      : getMetnoForecast(geo.latitude, geo.longitude, geo.timezone, env.WEATHER_USER_AGENT),
    getSunTimes(geo.latitude, geo.longitude).catch(() => null),
  ]);
  const sunText = sun && sun.length > 0 ? formatSunTimes(sun) : undefined;
  const answer = await summarizeForecast(env, body, formatLocationName(geo), periods, sunText);
  return { answer, answered: true };
}
