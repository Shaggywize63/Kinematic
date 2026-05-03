/**
 * Helper for invoking Supabase Edge Functions from the API server.
 */
const baseUrl = process.env.SUPABASE_EDGE_FUNCTIONS_URL;
const secret = process.env.SUPABASE_EDGE_SECRET;

export async function triggerEdgeFunction(name: string, payload: Record<string, unknown>): Promise<unknown> {
  if (!baseUrl) return null;
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Edge ${name} ${res.status}`);
  return res.json().catch(() => null);
}
