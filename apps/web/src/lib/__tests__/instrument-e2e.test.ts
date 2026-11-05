import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { NextRequest } from "next/server";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { pgInstrumentDb } from "./pg-instrument-db";

// Driven by scripts/e2e-instrument.sh: serves the uploader's real route handlers over HTTP on
// local Postgres and a local store (only the database client is swapped), so the real uploader
// binary can pair and send to it. Logs every part PUT and stops when the stop file appears.
// Skipped in the normal unit run.
const env = z
  .object({
    E2E_DATABASE_URL: z.string(),
    E2E_USER: z.string().min(1),
    E2E_LAB: z.string().min(1),
    E2E_PORT: z.coerce.number().int(),
    E2E_CODE_FILE: z.string().min(1),
    E2E_PART_LOG: z.string().min(1),
    E2E_STOP_FILE: z.string().min(1),
    E2E_PART_DELAY_MS: z.coerce.number().int().default(0),
  })
  .safeParse(process.env);

vi.mock("server-only", () => ({}));

function bodyOf(req: IncomingMessage): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      req.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      req.on("end", () => controller.close());
      req.on("error", (err) => controller.error(err));
    },
  });
}

// A route and the path segments its pattern captured.
type Handler = (request: NextRequest, captured: string[]) => Promise<Response>;

describe.runIf(env.success)("the uploader's routes over HTTP", () => {
  it("serves the real uploader until told to stop", { timeout: 15 * 60_000 }, async () => {
    if (!env.success) return;
    const e = env.data;
    const db = new Client({ connectionString: e.E2E_DATABASE_URL });
    await db.connect();
    vi.doMock("@/lib/instrument-db", () => ({ instrumentDb: () => pgInstrumentDb(db) }));
    const { newPairingCode } = await import("../instrument-upload");
    const { displayCode } = await import("../instruments");
    const pair = await import("@/app/api/instruments/pair/route");
    const heartbeat = await import("@/app/api/instruments/heartbeat/route");
    const check = await import("@/app/api/instruments/files/check/route");
    const uploads = await import("@/app/api/instruments/uploads/route");
    const upload = await import("@/app/api/instruments/uploads/[id]/route");
    const parts = await import("@/app/api/instruments/uploads/[id]/parts/[n]/route");
    const complete = await import("@/app/api/instruments/uploads/[id]/complete/route");

    const { code, hash } = newPairingCode();
    await db.query("begin");
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: e.E2E_USER })]);
    await db.query("select create_instrument($1, 'Plate reader, room 214', $2)", [e.E2E_LAB, hash]);
    await db.query("commit");

    const ctx = <T,>(params: T) => ({ params: Promise.resolve(params) });
    const ID = "([0-9a-f-]{36})";
    const routes: [string, RegExp, Handler][] = [
      ["POST", /^\/api\/instruments\/pair$/, (r) => pair.POST(r)],
      ["POST", /^\/api\/instruments\/heartbeat$/, (r) => heartbeat.POST(r)],
      ["POST", /^\/api\/instruments\/files\/check$/, (r) => check.POST(r)],
      ["POST", /^\/api\/instruments\/uploads$/, (r) => uploads.POST(r)],
      ["DELETE", new RegExp(`^/api/instruments/uploads/${ID}$`), (r, [id = ""]) => upload.DELETE(r, ctx({ id }))],
      ["POST", new RegExp(`^/api/instruments/uploads/${ID}/parts/(\\d+)$`), (r, [id = "", n = ""]) => parts.POST(r, ctx({ id, n }))],
      ["PUT", new RegExp(`^/api/instruments/uploads/${ID}/parts/(\\d+)$`), (r, [id = "", n = ""]) => parts.PUT(r, ctx({ id, n }))],
      ["POST", new RegExp(`^/api/instruments/uploads/${ID}/complete$`), (r, [id = ""]) => complete.POST(r, ctx({ id }))],
    ];

    async function handle(req: IncomingMessage, res: ServerResponse) {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${e.E2E_PORT}`);
      const route = routes.find(([method, pattern]) => method === req.method && pattern.test(url.pathname));
      if (route === undefined) {
        res.writeHead(404).end();
        return;
      }
      const captured = route[1].exec(url.pathname)?.slice(1) ?? [];
      if (req.method === "PUT") await new Promise((r) => setTimeout(r, e.E2E_PART_DELAY_MS));
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const request = new NextRequest(url, {
        method: req.method,
        headers,
        body: hasBody ? bodyOf(req) : undefined,
        duplex: "half",
      });
      const response = await route[2](request, captured);
      if (req.method === "PUT") appendFileSync(e.E2E_PART_LOG, `${captured.join(" ")} ${response.status}\n`);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    }

    const server = createServer((req, res) => {
      handle(req, res).catch((err: unknown) => {
        process.stderr.write(`${String(err)}\n`);
        res.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(e.E2E_PORT, "127.0.0.1", resolve));
    writeFileSync(e.E2E_CODE_FILE, displayCode(code));
    while (!existsSync(e.E2E_STOP_FILE)) await new Promise((r) => setTimeout(r, 500));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.end();
    expect(existsSync(e.E2E_PART_LOG)).toBe(true);
  });
});
