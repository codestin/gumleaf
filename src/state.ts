export interface Context {
  question: string;
  answer: string;
  location?: string;
}

// Short-lived conversation memory (Plus only) so follow-ups like "what about
// tomorrow?" resolve against the last exchange.
const CONTEXT_TTL_SECONDS = 30 * 60;

export async function getContext(kv: KVNamespace, from: string): Promise<Context | null> {
  return kv.get<Context>(`ctx:${from}`, "json");
}

export async function setContext(kv: KVNamespace, from: string, ctx: Context): Promise<void> {
  await kv.put(`ctx:${from}`, JSON.stringify(ctx), { expirationTtl: CONTEXT_TTL_SECONDS });
}
