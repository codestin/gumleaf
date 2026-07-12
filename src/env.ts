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
  SKIP_SIGNATURE_VALIDATION?: string;
}
