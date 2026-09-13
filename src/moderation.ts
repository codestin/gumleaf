import type { Env } from "./env";

export type ModerationVerdict = "ok" | "blocked" | "self-harm";

interface ModerationResponse {
  results?: {
    flagged?: boolean;
    categories?: Record<string, boolean>;
  }[];
}

// Moderation targets OpenAI's free /v1/moderations endpoint (its input format is
// OpenAI-specific). If your LLM isn't OpenAI, set MODERATION_API_KEY to an OpenAI
// key to keep crisis detection. Fails open: if the endpoint is unreachable or the
// key isn't valid there, the message proceeds and the answer model's own refusals
// are the backstop. imageUrl (a data URL for MMS photos) rides along when
// present; omni-moderation screens both.
export async function moderate(env: Env, text: string, imageUrl?: string): Promise<ModerationVerdict> {
  const baseUrl = env.MODERATION_BASE_URL ?? "https://api.openai.com";
  const key = env.MODERATION_API_KEY ?? env.LLM_API_KEY;
  const input = imageUrl
    ? [...(text ? [{ type: "text", text }] : []), { type: "image_url", image_url: { url: imageUrl } }]
    : text;
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/moderations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "omni-moderation-latest", input }),
      // Bounded so a hung moderation call can't eat into Twilio's ~15s window
      // (it already fails open on error; a hang is the only unbounded path).
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    return "ok";
  }
  if (!res.ok) return "ok";

  let data: ModerationResponse;
  try {
    data = (await res.json()) as ModerationResponse;
  } catch {
    return "ok";
  }

  const result = data.results?.[0];
  if (!result?.flagged) return "ok";

  const cats = result.categories ?? {};
  const selfHarm = Object.entries(cats).some(([name, hit]) => hit && name.startsWith("self-harm"));
  return selfHarm ? "self-harm" : "blocked";
}
