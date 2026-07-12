import type { Env } from "./env";

export type ModerationVerdict = "ok" | "blocked" | "self-harm";

interface ModerationResponse {
  results?: {
    flagged?: boolean;
    categories?: Record<string, boolean>;
  }[];
}

// Fails open: if the moderation endpoint is unreachable, the message proceeds —
// the answer model's own refusals are the backstop.
export async function moderate(env: Env, text: string): Promise<ModerationVerdict> {
  const baseUrl = env.OPENAI_BASE_URL ?? "https://api.openai.com";
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/moderations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
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
