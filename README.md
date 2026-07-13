# GumLeaf

Text a phone number, get a real answer back by SMS. Weather, facts, how-tos, all in a plain text message. It works anywhere a text works, including satellite messaging (iPhone satellite, Starlink direct-to-cell), because to the service a satellite text and a normal text look identical. No app, no internet needed on the sender's end.

> **Just want it to work?** The hosted version is live at **[gumleaf.pages.dev](https://gumleaf.pages.dev)**. Text a number and go, nothing to set up. See [why that might be worth it](#why-pay-for-the-hosted-version) below.

This is the open-source, self-hostable version. It runs on Cloudflare Workers and answers texts sent to a Twilio number you own, using the LLM of your choice (any OpenAI-compatible API: OpenAI, OpenRouter, Groq, a local model, and so on).

Prefer not to run infrastructure? There's a hosted version that handles the setup and upkeep for you. See ["Why pay for the hosted version?"](#why-pay-for-the-hosted-version) below.

## What it does

- Answers any texted question with one concise SMS reply, from the LLM you point it at.
- Real weather: geocodes the place (Open-Meteo) and pulls live forecasts from the US National Weather Service or MET Norway, then phrases them for SMS. Not a guess.
- Remembers your last exchange for about 30 minutes, so follow-ups like "what about tomorrow?" work.
- Screens messages with OpenAI's free moderation endpoint and returns crisis-line info for self-harm signals. Optional: it fails open, and non-OpenAI setups can skip it or point it at an OpenAI key (see [Choosing your LLM](#choosing-your-llm)).
- Keeps replies in GSM-7 encoding (writes temperatures like "9C" instead of using a degree symbol, and avoids fancy punctuation) so each answer stays 160 characters per SMS segment instead of 70, which roughly halves your Twilio cost.
- Locks access to a phone-number allowlist so strangers can't run up your bill, with an optional monthly per-number cap.

## Self-host guide

You'll need free/low-cost accounts with Cloudflare, Twilio, and an LLM provider (OpenAI, OpenRouter, Groq, or a local model, see [Choosing your LLM](#choosing-your-llm)).

### 1. Get the code

```sh
git clone https://github.com/codestin/gumleaf.git
cd gumleaf
npm install
```

### 2. Cloudflare

```sh
npx wrangler login
npx wrangler kv namespace create SMS_STATE
```

Copy `wrangler.toml.example` to `wrangler.toml`, paste in the KV namespace `id` it printed, and set `WEATHER_USER_AGENT` to include your own **real** contact email or URL. NWS and MET Norway reject anonymous clients, and MET Norway specifically returns HTTP 403 for placeholder contacts (anything with `example.com`), which silently breaks non-US weather. Use a real address.

### 3. Twilio

Buy an SMS-capable number in the [Twilio Console](https://console.twilio.com). Note your **Auth Token** (Account Info panel). US numbers need [A2P 10DLC registration](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc) before they'll reliably deliver — a Brand + Campaign registration, a compliant privacy policy and signup form, and a carrier review that can take days to weeks. **Heads up: this is the tedious part.** See ["Why pay for the hosted version?"](#why-pay-for-the-hosted-version) below for exactly what it involves before you commit to self-hosting.

### 4. Secrets

```sh
npx wrangler secret put LLM_API_KEY         # your LLM provider's API key
npx wrangler secret put TWILIO_AUTH_TOKEN   # from the Twilio console
npx wrangler secret put ALLOWED_NUMBERS     # comma-separated E.164, e.g. +15551234567
# npx wrangler secret put MODERATION_API_KEY  # optional OpenAI key, only if your LLM isn't OpenAI
```

Optional vars in `wrangler.toml`: `DEFAULT_LOCATION`, `LLM_MODEL`, `LLM_BASE_URL`, `MONTHLY_LIMIT`.

### 5. Deploy and wire up Twilio

```sh
npx wrangler deploy
```

In the Twilio Console, set your number's **"A message comes in"** webhook to `https://<your-worker-url>/sms` (HTTP POST). Text your number from an allowlisted phone.

### Local testing

Copy `.dev.vars.example` to `.dev.vars`, run `npx wrangler dev`, and simulate an inbound message:

```sh
curl -s http://localhost:8787/sms \
  --data-urlencode "Body=weather in Oslo" \
  --data-urlencode "From=+15551234567" \
  --data-urlencode "To=+15550000000"
```

(`SKIP_SIGNATURE_VALIDATION=true` in `.dev.vars` skips Twilio's signature check for local curling. It only works on localhost.)

## Choosing your LLM

Answers come from any OpenAI-compatible chat API, so you can use whoever you like. Set two optional vars in `wrangler.toml` and put the key in as a secret:

| Provider | `LLM_BASE_URL` | example `LLM_MODEL` |
| --- | --- | --- |
| OpenAI (default) | `https://api.openai.com` | `gpt-4o` |
| OpenRouter | `https://openrouter.ai/api` | `anthropic/claude-3.5-sonnet` |
| Groq | `https://api.groq.com/openai` | `llama-3.3-70b-versatile` |
| Local (Ollama, LM Studio) | `http://localhost:11434` | `llama3.1` |

`LLM_BASE_URL` defaults to OpenAI, so if that's what you're using you can leave it unset. Whatever you pick, set `LLM_MODEL` to a model that provider actually serves.

**Moderation.** On by default. Incoming messages are screened by OpenAI's free `/v1/moderations` endpoint, which is what flags self-harm so GumLeaf can reply with crisis-line info. If your `LLM_API_KEY` is an OpenAI key, this just works. If it isn't, either set `MODERATION_API_KEY` to an OpenAI key to keep it on, or leave it unset and moderation is skipped (it fails open, so messages still go through). To turn it off entirely, set `MODERATION_ENABLED = "false"` — worth considering for a fully-local setup, since otherwise message text is also sent to OpenAI's moderation endpoint. The Worker logs its moderation state on first request.

## Why pay for the hosted version?

Self-hosting is real work, and the annoying parts aren't the code. If you'd rather skip them:

- **Twilio A2P registration — the real gauntlet.** Before a US number reliably sends app-to-person texts, you must register for A2P 10DLC, and it's more than a form. You register a **Brand** (business identity), then a **Campaign** where you pick a use case, write a campaign description, describe your exact **opt-in / message flow**, provide **sample messages**, and declare your message contents (links, phone numbers). You need a **privacy policy** that contains specific mandated clauses — mobile-number **non-sharing**, **message frequency**, and a **"message and data rates may apply"** disclosure — or it's rejected. Your **signup form** must have an **unchecked consent checkbox** (not pre-ticked), plus frequency, rates, HELP + STOP, and links to your terms and privacy policy. Then you **wait** for carrier review (hours to weeks), and any missing piece bounces you back to fix and resubmit. It's the single most tedious part of running this, and it's entirely out of your hands while you wait.
- **Keys and cost.** You hold your own LLM and Twilio keys, top up balances, and eat every message's cost, which is mostly Twilio (a couple of cents per answer). You're the one watching the bill.
- **Maintenance forever.** Someone has to keep the Worker deployed, rotate keys, follow Twilio/LLM/Cloudflare API changes, and fix things when a provider shifts something. Self-hosted means that someone is you, indefinitely.
- **Uptime and support.** No one is paged when it breaks at 2am but you.

The hosted version exists so you don't have to deal with any of that. If self-hosting sounds fun, this repo is yours to run. If it sounds like a chore, that's exactly what you'd be paying to avoid.

**→ Get the hosted version: [gumleaf.pages.dev](https://gumleaf.pages.dev)**

## Support

GumLeaf is free and MIT-licensed. If it's useful to you, [sponsoring the project](https://github.com/sponsors/codestin) (pay what you want, including nothing) keeps it maintained. Stars and issues are welcome too.

## Not an emergency service

GumLeaf gives informational answers only. They can be wrong, late, or undelivered, especially over satellite. Never rely on it for medical guidance, navigation, rescue, or anything where a missing or wrong answer could put someone at risk. In an emergency, contact local emergency services.
