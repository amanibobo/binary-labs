import { z } from "zod";

// How the run record's API files talk to their routes. Shared by the foundation's methods and
// each slice's, so a failure reads the same wherever it comes from.

const ErrorBody = z.object({ error: z.string() });

export function failure(json: unknown, fallback = "We couldn't save that. Try again."): Error {
  const parsed = ErrorBody.safeParse(json);
  return new Error(parsed.success ? parsed.data.error : fallback);
}

export async function getJson(path: string, params: Record<string, string | readonly string[]>, signal: AbortSignal): Promise<unknown> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) for (const v of typeof value === "string" ? [value] : value) query.append(key, v);
  const text = query.toString();
  const res = await fetch(text === "" ? path : `${path}?${text}`, { signal, headers: { accept: "application/json" } });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) throw failure(json, "We couldn't load that. Try again.");
  return json;
}

// Resolves with the route's JSON, or rejects with an Error whose message can be shown.
export async function send(url: string, method: "POST" | "DELETE", body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) throw failure(json);
  return json;
}

// What a slice's method does until that slice is built.
export function notBuilt(): Promise<never> {
  return Promise.reject(new Error("This part of the run record isn't built yet."));
}
