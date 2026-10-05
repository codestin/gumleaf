import type { Env } from "./env";
import { parseFormBody, twimlResponse, twimlResponseWithMedia, validateTwilioSignature, pickImageUrl, fetchTwilioMedia } from "./twilio";
import { classifyAndAnswer, summarizeForecast, visionAnswer } from "./llm";
import { senderTimezone } from "./tz";
import { geocode, getForecast, formatLocationName, getSunTimes, formatSunTimes, fallbackForecastText, UpstreamError } from "./weather";
import { getMetnoForecast } from "./metno";
import { getUsage, incrementUsage, isFirstContact, markSeen } from "./quota";
import { moderate } from "./moderation";
import { parseTransitCommand, transitAnswer } from "./transit";
import { parseSubwayCommand, subwayAnswer } from "./mta";
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
    const receivedAt = Date.now();
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/status") {
      return handleStatusCallback(request, env, url);
    }

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

    // Idempotency: Twilio redelivers a webhook (retry after a slow response,
    // carrier duplicates) with the same MessageSid. Answering twice sends the
    // user two different replies and double-counts usage - drop repeats with
    // an empty TwiML. Best-effort: KV is eventually consistent, which is fine
    // for the seconds-later retry case that actually happens.
    const messageSid = params["MessageSid"] ?? "";
    if (messageSid) {
      const sidKey = `sid:${messageSid}`;
      if (await env.SMS_STATE.get(sidKey)) {
        return twimlResponse();
      }
      await env.SMS_STATE.put(sidKey, "1", { expirationTtl: 600 });
    }

    const from = params["From"] ?? "";
    // Derived fresh from this request's geo hints; nothing about it is kept.
    const timezone = senderTimezone({ country: params["FromCountry"], state: params["FromState"], from });
    const body = (params["Body"] ?? "").trim();
    const lowered = body.toLowerCase();

    // Allowlist: strangers are ignored so they can't burn your Twilio/LLM.
    const allowed = env.ALLOWED_NUMBERS.split(",").map((n) => n.trim()).filter(Boolean);
    if (!allowed.includes(from)) {
      return twimlResponse();
    }

    // MMS photo, if attached: fetched up front so both moderation and the
    // vision answer see it. Nothing is stored - strictly this one message.
    const imageUrl = pickImageUrl(params);
    let image: string | null = null;
    if (imageUrl) {
      image = await fetchTwilioMedia(env, imageUrl);
      if (!image) {
        return twimlResponse(msg.photoLoadFailed());
      }
    }

    if (!body && !image) return twimlResponse(msg.emptyBodyHint());
    if (lowered === "help") return twimlResponse(msg.helpText());
    // Text back the contact card (only when a card is configured; see VCARD_URL).
    if (env.VCARD_URL && (lowered === "contact" || lowered === "vcard" || lowered === "card" || lowered === "save")) {
      return twimlResponseWithMedia(msg.vcardKeywordReply(), msg.vcardIntro(), env.VCARD_URL);
    }

    // FEEDBACK <note>: stored in KV for the operator, never metered. Read with
    // `wrangler kv key list --prefix=feedback:` (see README); self-expires
    // after 180 days so an unattended deployment doesn't accumulate keys.
    const feedback = msg.parseFeedback(body);
    if (feedback === "hint") {
      return twimlResponse(msg.feedbackHint());
    }
    if (feedback) {
      const ts = new Date().toISOString();
      await env.SMS_STATE.put(
        `feedback:${ts}:${from}`,
        JSON.stringify({ v: 1, source: "sms", from, text: feedback.text, ts }),
        { expirationTtl: 180 * 24 * 3600 }
      );
      return twimlResponse(msg.feedbackThanks());
    }

    // Moderation is on by default; set MODERATION_ENABLED=false to opt out.
    // Runs before the cost cap so crisis resources are never withheld.
    const moderationEnabled = env.MODERATION_ENABLED !== "false";
    logModerationStatus(env, moderationEnabled);
    if (moderationEnabled) {
      const verdict = await moderate(env, body, image ?? undefined);
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
      answer = await handleQuestion(env, body, image ?? undefined, receivedAt, timezone);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      const stage = err instanceof UpstreamError ? err.stage : "unknown";
      console.error(`answer failed [${stage}] ${e.name}: ${e.message}`, e.stack ?? "");
      return twimlResponse(
        err instanceof UpstreamError ? msg.upstreamDown() : "Sorry, something went wrong - please try again in a minute."
      );
    }

    if (answer.answered) {
      await incrementUsage(env.SMS_STATE, from);
    }
    if (firstContact) await markSeen(env.SMS_STATE, from);

    let reply = msg.clampSms(msg.toGsm7(answer.answer));
    // Track delivery of the real answer so a carrier content-filter (30007)
    // triggers an out-of-band notice instead of the user seeing pure silence.
    const statusCb = `${url.origin}/status`;
    if (firstContact) {
      reply += `\n\n${msg.welcomeFooter()}`;
      // First contact also gets the contact card as a follow-up MMS, if configured.
      if (env.VCARD_URL) return twimlResponseWithMedia(reply, msg.vcardIntro(), env.VCARD_URL, statusCb);
    }
    return twimlResponse(reply, statusCb);
  },
};

// Twilio POSTs delivery status here for every answer (statusCallback on the
// TwiML). The only status worth acting on is a carrier content-filter (30007):
// the answer was sent but silently discarded, so tell the user out-of-band.
// Needs TWILIO_ACCOUNT_SID + TWILIO_FROM_NUMBER to send the notice; without
// them the callback is acknowledged and only logged.
async function handleStatusCallback(request: Request, env: Env, url: URL): Promise<Response> {
  const params = await parseFormBody(request);
  const isLocalDev = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (!(env.SKIP_SIGNATURE_VALIDATION === "true" && isLocalDev)) {
    const signature = request.headers.get("X-Twilio-Signature") ?? "";
    const valid = await validateTwilioSignature(request.url, params, signature, env.TWILIO_AUTH_TOKEN);
    if (!valid) return new Response("Invalid signature", { status: 403 });
  }

  const to = params["To"] ?? "";
  const sid = params["MessageSid"] ?? "";
  if (params["ErrorCode"] === "30007") {
    console.error(`carrier filtered an answer (30007) to ${to}`);
    if (to && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER) {
      // Twilio can fire the callback more than once; notify at most once per SID.
      const dedupeKey = `statusnotified:${sid}`;
      if (!(await env.SMS_STATE.get(dedupeKey))) {
        await env.SMS_STATE.put(dedupeKey, "1", { expirationTtl: 3600 });
        try {
          const base = env.TWILIO_API_BASE ?? "https://api.twilio.com";
          // No StatusCallback on this send: a plain notice can't be filtered, and
          // omitting it means no callback, so a notice can never notify itself.
          await fetch(`${base}/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
            method: "POST",
            headers: {
              Authorization: "Basic " + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ To: to, From: env.TWILIO_FROM_NUMBER, Body: msg.carrierBlockedNotice() }),
          });
        } catch (err) {
          console.error("carrier-block notice failed:", err instanceof Error ? err.message : String(err));
        }
      }
    }
  }
  return new Response("", { status: 200 });
}

interface Answer {
  answer: string;
  answered: boolean;
}

// Twilio abandons a webhook (and the user gets SILENCE - worse than any error
// text) at ~15s. Slow optional stages budget against the webhook's arrival
// time so a reply, even a degraded one, is always composed inside the window.
const WEBHOOK_DEADLINE_MS = 12_500;

function windowLeft(startedAt: number): number {
  return WEBHOOK_DEADLINE_MS - (Date.now() - startedAt);
}

// timezone: the sender's IANA zone when Twilio's per-request geo hints give
// one (never stored); grounds "today" in the model prompts.
async function handleQuestion(
  env: Env,
  body: string,
  image?: string,
  startedAt: number = Date.now(),
  timezone?: string
): Promise<Answer> {
  // A photo makes it a vision question: one model call, image + any caption,
  // metered like any answer. Strictly per-message - a follow-up text can't
  // see an earlier photo (no history, by design), so the reply hints at that
  // pairing only via the classify prompt when someone references a photo.
  if (image) {
    // Media fetch + moderation may have burned seconds already; cap the vision
    // call so even its failure lands in-window as an error reply, not silence.
    return { answer: await visionAnswer(env, body, image, Math.max(2000, Math.min(10_000, windowLeft(startedAt))), timezone), answered: true };
  }

  // "BART <station>" / "CALTRAIN <stop>" / "FLIGHT UA123 [on 7/24]" skip the
  // model entirely: live data, formatted deterministically.
  const transitCmd = parseTransitCommand(body);
  if (transitCmd) {
    return transitAnswer(env, transitCmd.agency, transitCmd.stop);
  }
  const subwayCmd = parseSubwayCommand(body);
  if (subwayCmd) {
    return subwayAnswer(env, subwayCmd.stop);
  }
  const flightCmd = parseFlightCommand(body);
  if (flightCmd) {
    return flightAnswer(env, flightCmd.flight, flightCmd.date);
  }

  const classified = await classifyAndAnswer(env, body, timezone);

  if (classified.kind === "flight") {
    if (!classified.flight) {
      return { answer: 'Which flight? Give me the airline code + number, e.g. "FLIGHT UA123".', answered: false };
    }
    return flightAnswer(env, classified.flight, classified.flight_date);
  }

  if (classified.kind === "transit") {
    if (!classified.agency) {
      return { answer: 'I have live train times for the NYC subway, BART, and Caltrain so far. Try "SUBWAY Bedford Av", "BART Embarcadero", or "CALTRAIN Palo Alto".', answered: false };
    }
    if (classified.agency === "subway") {
      return subwayAnswer(env, classified.stop ?? "");
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

  // Sun times are computed locally and ride along with every forecast; their
  // failure must never break the weather answer.
  const periods =
    geo.country_code === "US"
      ? await getForecast(geo.latitude, geo.longitude, env.WEATHER_USER_AGENT)
      : await getMetnoForecast(geo.latitude, geo.longitude, geo.timezone, env.WEATHER_USER_AGENT);
  let sunText: string | undefined;
  try {
    const sun = getSunTimes(geo.latitude, geo.longitude, geo.timezone);
    sunText = sun.length > 0 ? formatSunTimes(sun) : undefined;
  } catch {
    sunText = undefined;
  }
  let answer: string;
  try {
    // Geocode retries can eat most of the window; with the data already in
    // hand, the raw forecast beats a timed-out webhook.
    const budgetMs = Math.min(8000, windowLeft(startedAt));
    if (budgetMs < 2500) {
      throw new Error(`skipped: only ${budgetMs}ms left in the webhook window`);
    }
    // The forecast's own zone wins over the sender's: "tomorrow in Bergen"
    // means Bergen's tomorrow.
    answer = await summarizeForecast(env, body, formatLocationName(geo), periods, sunText, budgetMs, geo.timezone ?? timezone);
  } catch (err) {
    // LLM down with the data already in hand: send the data itself.
    console.error("summarize failed, sending raw forecast:", err instanceof Error ? err.message : String(err));
    answer = fallbackForecastText(formatLocationName(geo), periods);
  }
  return { answer, answered: true };
}
