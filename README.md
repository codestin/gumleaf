# GumLeaf

Text a phone number, get a real answer back by SMS. Weather, facts, how-tos, all in a plain text message. It works anywhere a text works, including satellite messaging (iPhone satellite, Starlink direct-to-cell), because to the service a satellite text and a normal text look identical. No app, no internet needed on the sender's end.

> **Just want it to work?** The hosted version is live at **[gumleaf.pages.dev](https://gumleaf.pages.dev)**. Text a number and go, nothing to set up. See [why that might be worth it](#why-pay-for-the-hosted-version) below.

This is the open-source, self-hostable version. It runs on Cloudflare Workers and answers texts sent to a Twilio number you own, using your own OpenAI key.

Prefer not to run infrastructure? There's a hosted version that handles the setup and upkeep for you. See ["Why pay for the hosted version?"](#why-pay-for-the-hosted-version) below.

## What it does

- Answers any texted question with one concise SMS reply, from a capable OpenAI model.
- Real weather: geocodes the place (Open-Meteo) and pulls live forecasts from the US National Weather Service or MET Norway, then phrases them for SMS. Not a guess.
- Remembers your last exchange for about 30 minutes, so follow-ups like "what about tomorrow?" work.
- Screens messages with OpenAI's moderation API and returns crisis-line info for self-harm signals.
- Keeps replies in GSM-7 encoding (writes temperatures like "9C" instead of using a degree symbol, and avoids fancy punctuation) so each answer stays 160 characters per SMS segment instead of 70, which roughly halves your Twilio cost.
- Locks access to a phone-number allowlist so strangers can't run up your bill, with an optional monthly per-number cap.

## Self-host guide

You'll need free/low-cost accounts with Cloudflare, Twilio, and OpenAI.

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

Copy `wrangler.toml.example` to `wrangler.toml`, paste in the KV namespace `id` it printed, and set `WEATHER_USER_AGENT` to include your own contact (NWS and MET Norway reject anonymous clients).

### 3. Twilio

Buy an SMS-capable number in the [Twilio Console](https://console.twilio.com). Note your **Auth Token** (Account Info panel). US numbers need [A2P 10DLC registration](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc) before they'll reliably deliver, which takes time and paperwork (see the note below).

### 4. Secrets

```sh
npx wrangler secret put OPENAI_API_KEY      # your OpenAI key
npx wrangler secret put TWILIO_AUTH_TOKEN   # from the Twilio console
npx wrangler secret put ALLOWED_NUMBERS     # comma-separated E.164, e.g. +15551234567
```

Optional vars in `wrangler.toml`: `DEFAULT_LOCATION`, `OPENAI_MODEL`, `MONTHLY_LIMIT`.

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

## Why pay for the hosted version?

Self-hosting is real work, and the annoying parts aren't the code. If you'd rather skip them:

- **Twilio compliance.** Before a US number will reliably send app-to-person texts, you have to register for A2P 10DLC: a brand, a campaign, business details, sample messages, and a review that can take days to weeks. Getting a number approved is the single most tedious part, and it's out of your hands while you wait.
- **Keys and cost.** You hold your own OpenAI and Twilio keys, top up balances, and eat every message's cost, which is mostly Twilio (a couple of cents per answer). You're the one watching the bill.
- **Maintenance forever.** Someone has to keep the Worker deployed, rotate keys, follow Twilio/OpenAI/Cloudflare API changes, and fix things when a provider shifts something. Self-hosted means that someone is you, indefinitely.
- **Uptime and support.** No one is paged when it breaks at 2am but you.

The hosted version exists so you don't have to deal with any of that. If self-hosting sounds fun, this repo is yours to run. If it sounds like a chore, that's exactly what you'd be paying to avoid.

**→ Get the hosted version: [gumleaf.pages.dev](https://gumleaf.pages.dev)**

## Support

GumLeaf is free and MIT-licensed. If it's useful to you, [sponsoring the project](https://github.com/sponsors/codestin) (pay what you want, including nothing) keeps it maintained. Stars and issues are welcome too.

## Not an emergency service

GumLeaf gives informational answers only. They can be wrong, late, or undelivered, especially over satellite. Never rely on it for medical guidance, navigation, rescue, or anything where a missing or wrong answer could put someone at risk. In an emergency, contact local emergency services.
