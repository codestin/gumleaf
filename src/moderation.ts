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
// are the backstop.
export async function moderate(env: Env, text: string): Promise<ModerationVerdict> {
  const baseUrl = env.MODERATION_BASE_URL ?? "https://api.openai.com";
  const key = env.MODERATION_API_KEY ?? env.LLM_API_KEY;
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/moderations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "omni-moderation-latest", input: text }),
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
