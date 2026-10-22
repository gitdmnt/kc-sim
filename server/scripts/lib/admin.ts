// Calls the worker's admin API. Local `wrangler dev` (ENVIRONMENT=development) needs no credentials; a
// deployed worker sits behind Cloudflare Access, so set DATA_API and an Access service token
// (CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET, docs/DEPLOY.md "Access").

const BASE = process.env.DATA_API ?? "http://127.0.0.1:8787";

function accessHeaders(): Record<string, string> {
  const id = process.env.CF_ACCESS_CLIENT_ID;
  const secret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (!id || !secret) return {};
  return { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret };
}

export async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...accessHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 500)}`);
  return JSON.parse(text);
}
