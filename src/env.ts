export interface Env {
  SMS_STATE: KVNamespace;
  // Any OpenAI-compatible LLM. Set LLM_BASE_URL/LLM_MODEL to point at your provider.
  LLM_API_KEY: string;
  TWILIO_AUTH_TOKEN: string;
  WEATHER_USER_AGENT: string;
  // Comma-separated E.164 numbers allowed to use this bot. Anyone else is ignored
  // so strangers can't run up your Twilio/LLM bill.
  ALLOWED_NUMBERS: string;
  // Optional per-number monthly answer cap (cost guard). Unlimited if unset.
  MONTHLY_LIMIT?: string;
  DEFAULT_LOCATION?: string;
  LLM_MODEL?: string;
  LLM_BASE_URL?: string;
  // Optional. Moderation uses OpenAI's free /v1/moderations endpoint. If your LLM
  // isn't OpenAI, set MODERATION_API_KEY to an OpenAI key to keep crisis detection;
  // otherwise moderation fails open (is skipped). See README.
  MODERATION_API_KEY?: string;
  MODERATION_BASE_URL?: string;
  // Moderation is on by default (routes self-harm messages to crisis resources).
  // Set to "false" to disable, e.g. a fully-local/private setup where you don't
  // want message text sent to OpenAI's moderation endpoint.
  MODERATION_ENABLED?: string;
  // Optional. Twilio Account SID (AC...). Enables two nice-to-haves: Basic auth
  // when fetching MMS photo media (needed if your account enforces HTTP auth on
  // media), and the out-of-band carrier-block notice (see TWILIO_FROM_NUMBER).
  TWILIO_ACCOUNT_SID?: string;
  // Optional. Your Twilio number in E.164. With TWILIO_ACCOUNT_SID set, the
  // worker texts the sender a heads-up when a carrier silently filters an
  // answer (Twilio error 30007) - otherwise that failure looks like silence.
  TWILIO_FROM_NUMBER?: string;
  // Test hook: override the Twilio API host.
  TWILIO_API_BASE?: string;
  // Optional. Public URL of a .vcf contact card (host it anywhere, e.g. Cloudflare
  // Pages with Content-Type: text/vcard). When set, first contact and the
  // CONTACT/VCARD/CARD/SAVE keyword send it as an MMS so people can save the bot
  // to their contacts. Note: MMS doesn't deliver over satellite links.
  VCARD_URL?: string;
  // Optional live-data keys. All features degrade gracefully when unset.
  // 511.org SF Bay token (free, 60 req/hr) for Caltrain real-time; CALTRAIN
  // replies say "coming soon" until set.
  TRANSIT_511_TOKEN?: string;
  // Registered BART API key; BART works out of the box on the published demo key.
  BART_API_KEY?: string;
  // RapidAPI key subscribed to AeroDataBox (free tier: 600 units/mo) for FLIGHT
  // status with gates. Without it, flights degrade to aviationstack, then to
  // the keyless adsbdb route lookup (no times).
  AERODATABOX_KEY?: string;
  // aviationstack access key (free tier: 100 req/mo) - flight fallback.
  AVIATIONSTACK_KEY?: string;
  SKIP_SIGNATURE_VALIDATION?: string;
}
