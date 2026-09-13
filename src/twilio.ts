import type { Env } from "./env";

export async function parseFormBody(request: Request): Promise<Record<string, string>> {
  const form = await request.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") params[key] = value;
  }
  return params;
}

// Twilio signs webhooks with HMAC-SHA1(authToken) over the full request URL
// followed by every POST param's name+value concatenated in sorted-key order,
// then base64-encodes the digest and sends it as X-Twilio-Signature.
export async function validateTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string,
  authToken: string
): Promise<boolean> {
  let data = url;
  for (const key of Object.keys(params).sort()) {
    data += key + params[key];
  }
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return timingSafeEqual(expected, signature);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// First image attachment on an inbound MMS, if any. Twilio lists attachments
// as MediaUrlN/MediaContentTypeN with NumMedia as the count.
export function pickImageUrl(params: Record<string, string>): string | null {
  const n = parseInt(params["NumMedia"] ?? "0", 10) || 0;
  for (let i = 0; i < n && i < 10; i++) {
    const url = params[`MediaUrl${i}`];
    const type = params[`MediaContentType${i}`] ?? "";
    if (url && type.startsWith("image/")) return url;
  }
  return null;
}

// Fetch Twilio-hosted MMS media and return it as a data URL for the vision
// call. Basic auth works whether or not the account enforces HTTP auth on
// media (and Workers strip the header on the cross-origin S3 redirect).
// Returns null on any failure - the caller replies with a retry hint.
export async function fetchTwilioMedia(env: Env, url: string): Promise<string | null> {
  try {
    const headers: Record<string, string> = {};
    if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
      headers["Authorization"] = "Basic " + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
    }
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const type = res.headers.get("Content-Type")?.split(";")[0] ?? "image/jpeg";
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > 5_000_000) return null; // MMS cap; guard runaway payloads
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return `data:${type};base64,${btoa(binary)}`;
  } catch {
    return null;
  }
}

// statusCallback, when set, asks Twilio to POST delivery status (delivered,
// undelivered + ErrorCode) back to that URL - how the worker learns a carrier
// filtered an answer after the fact.
export function twimlResponse(message?: string, statusCallback?: string): Response {
  const cb = statusCallback ? ` statusCallback="${escapeXml(statusCallback)}"` : "";
  const body = message
    ? `<Response><Message${cb}>${escapeXml(message)}</Message></Response>`
    : `<Response></Response>`;
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
    headers: { "Content-Type": "text/xml" },
  });
}

// Two-message TwiML reply: the normal answer plus a follow-up MMS carrying
// media. Used for the contact card (VCARD_URL) on first contact and keywords.
export function twimlResponseWithMedia(message: string, mediaBody: string, mediaUrl: string, statusCallback?: string): Response {
  const cb = statusCallback ? ` statusCallback="${escapeXml(statusCallback)}"` : "";
  const body =
    `<Response>` +
    `<Message${cb}>${escapeXml(message)}</Message>` +
    `<Message><Body>${escapeXml(mediaBody)}</Body><Media>${escapeXml(mediaUrl)}</Media></Message>` +
    `</Response>`;
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
    headers: { "Content-Type": "text/xml" },
  });
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
