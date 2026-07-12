import type { Env } from "./env";
import { parseFormBody, twimlResponse, validateTwilioSignature } from "./twilio";
import { classifyAndAnswer, summarizeForecast } from "./llm";
import { geocode, getForecast, formatLocationName } from "./weather";
import { getMetnoForecast } from "./metno";
import { getContext, setContext } from "./state";
import { getUsage, incrementUsage, isFirstContact, markSeen } from "./quota";
import { moderate } from "./moderation";
import * as msg from "./messages";

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

    // Allowlist: strangers are ignored so they can't burn your Twilio/OpenAI.
    const allowed = env.ALLOWED_NUMBERS.split(",").map((n) => n.trim()).filter(Boolean);
    if (!allowed.includes(from)) {
      return twimlResponse();
    }

    if (!body) return twimlResponse(msg.emptyBodyHint());
    if (lowered === "help") return twimlResponse(msg.helpText());

    // Moderation before the cost cap so crisis resources are never withheld.
    const verdict = await moderate(env, body);
    if (verdict === "self-harm") return twimlResponse(msg.crisisResources());
    if (verdict === "blocked") return twimlResponse(msg.moderationRefusal());

    // Optional monthly cost cap.
    const limit = env.MONTHLY_LIMIT ? parseInt(env.MONTHLY_LIMIT, 10) : 0;
    if (limit > 0 && (await getUsage(env.SMS_STATE, from)) >= limit) {
      return twimlResponse(msg.capReached());
    }

    const firstContact = await isFirstContact(env.SMS_STATE, from);
    const prior = await getContext(env.SMS_STATE, from);
    const priorText = prior ? `You: ${prior.question}\nBot: ${prior.answer}` : undefined;

    let answer: Answer;
    try {
      answer = await handleQuestion(env, body, priorText);
    } catch (err) {
      console.error("answer failed:", err instanceof Error ? err.message : String(err));
      return twimlResponse("Sorry, something went wrong - please try again in a minute.");
    }

    if (answer.answered) {
      await setContext(env.SMS_STATE, from, { question: body, answer: answer.answer, location: answer.location });
      await incrementUsage(env.SMS_STATE, from);
    }
    if (firstContact) await markSeen(env.SMS_STATE, from);

    let reply = msg.toGsm7(answer.answer);
    if (firstContact) reply += `\n\n${msg.welcomeFooter()}`;
    return twimlResponse(reply);
  },
};

interface Answer {
  answer: string;
  answered: boolean;
  location?: string;
}

async function handleQuestion(env: Env, body: string, context?: string): Promise<Answer> {
  const classified = await classifyAndAnswer(env, body, context);

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

  const periods =
    geo.country_code === "US"
      ? await getForecast(geo.latitude, geo.longitude, env.WEATHER_USER_AGENT)
      : await getMetnoForecast(geo.latitude, geo.longitude, geo.timezone, env.WEATHER_USER_AGENT);
  const answer = await summarizeForecast(env, body, formatLocationName(geo), periods);
  return { answer, answered: true, location: formatLocationName(geo) };
}
