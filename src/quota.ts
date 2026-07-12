// 40 days: outlives the calendar month it meters, then self-cleans.
const USAGE_TTL_SECONDS = 40 * 24 * 3600;

export function monthKey(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function getUsage(kv: KVNamespace, from: string): Promise<number> {
  const raw = await kv.get(`usage:${from}:${monthKey()}`);
  return raw ? parseInt(raw, 10) || 0 : 0;
}

export async function incrementUsage(kv: KVNamespace, from: string): Promise<number> {
  const next = (await getUsage(kv, from)) + 1;
  await kv.put(`usage:${from}:${monthKey()}`, String(next), { expirationTtl: USAGE_TTL_SECONDS });
  return next;
}

export async function isFirstContact(kv: KVNamespace, from: string): Promise<boolean> {
  return (await kv.get(`seen:${from}`)) === null;
}

export async function markSeen(kv: KVNamespace, from: string): Promise<void> {
  await kv.put(`seen:${from}`, "1");
}
