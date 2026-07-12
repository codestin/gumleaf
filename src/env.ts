export interface Env {
  SMS_STATE: KVNamespace;
  OPENAI_API_KEY: string;
  TWILIO_AUTH_TOKEN: string;
  WEATHER_USER_AGENT: string;
  // Comma-separated E.164 numbers allowed to use this bot. Anyone else is ignored
  // so strangers can't run up your Twilio/OpenAI bill.
  ALLOWED_NUMBERS: string;
  // Optional per-number monthly answer cap (cost guard). Unlimited if unset.
  MONTHLY_LIMIT?: string;
  DEFAULT_LOCATION?: string;
  OPENAI_MODEL?: string;
  OPENAI_BASE_URL?: string;
  SKIP_SIGNATURE_VALIDATION?: string;
}
