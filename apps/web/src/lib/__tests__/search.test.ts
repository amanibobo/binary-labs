import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LabId } from "../ids";
import { embedQuery, searchWithFallback, type SearchFilesArgs } from "../search";

const labId = LabId.parse("6f1c2c39-5a4e-4c55-9d7b-0c3c1a7a0001");
const vector = Array.from({ length: 1024 }, (_, i) => (i % 7) / 10);

const row = {
  sha256: "a".repeat(64),
  score: 0.032,
  keyword_rank: 1,
  vector_rank: null,
  snippet: "P450 gel, batch 3",
  file_kind: "image",
  mime: "image/jpeg",
  size: 2048,
  has_preview: true,
  locations: [
    {
      id: "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7a0002",
      source_id: "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7a0003",
      source_kind: "dropbox",
      path: "/Lab/Gels/IMG_4821.jpg",
      original_name: "IMG_4821.jpg",
      modified_at: "2026-10-14T09:30:00+00:00",
    },
  ],
  label: null,
};

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const servers: Server[] = [];

async function serve(handler: Handler): Promise<string> {
  const server = createServer((req, res) => {
    if (req.headers.authorization !== "Bearer test-key") return void res.writeHead(401).end();
    handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === "string") throw new Error("server has no port");
  return `http://127.0.0.1:${address.port}/embed`;
}

let slowUrl = "";
let failingUrl = "";
let fastUrl = "";
let badShapeUrl = "";

beforeAll(async () => {
  slowUrl = await serve((_req, res) => {
    setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ embedding: vector })), 600);
  });
  failingUrl = await serve((_req, res) => res.writeHead(500).end("boom"));
  fastUrl = await serve((_req, res) =>
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ embedding: vector })),
  );
  badShapeUrl = await serve((_req, res) =>
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ embedding: [1, 2, 3] })),
  );
});

afterAll(async () => {
  for (const s of servers) s.closeAllConnections();
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
});

async function runAgainst(url: string) {
  const calls: SearchFilesArgs[] = [];
  const started = performance.now();
  const response = await searchWithFallback({
    labId,
    params: { q: "p450 gels", kind: "image" },
    embed: (text) => embedQuery({ config: { kind: "configured", url, apiKey: "test-key" }, text }),
    searchFiles: async (args) => {
      calls.push(args);
      return [row];
    },
  });
  return { response, calls, elapsedMs: performance.now() - started };
}

describe("search fallback", () => {
  it("returns the keyword variant when the embedder is slower than 250 ms", async () => {
    const { response, calls, elapsedMs } = await runAgainst(slowUrl);
    expect(response.kind).toBe("keyword");
    if (response.kind === "keyword") expect(response.reason).toBe("embed_timeout");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.p_query_embedding).toBeNull();
    expect(elapsedMs).toBeLessThan(500);
  });

  it("returns the keyword variant when the embedder answers 500", async () => {
    const { response, calls } = await runAgainst(failingUrl);
    expect(response).toMatchObject({ kind: "keyword", reason: "embed_error" });
    expect(calls[0]?.p_query_embedding).toBeNull();
  });

  it("returns the keyword variant when the embedding has the wrong length", async () => {
    const { response } = await runAgainst(badShapeUrl);
    expect(response).toMatchObject({ kind: "keyword", reason: "embed_error" });
  });

  // The fast server answers 401 without the bearer key, so hybrid also proves the header.
  it("returns hybrid with the embedding passed to search_files when the embedder is fast", async () => {
    const { response, calls } = await runAgainst(fastUrl);
    expect(response.kind).toBe("hybrid");
    expect(calls[0]?.p_query_embedding).toBe(`[${vector.join(",")}]`);
    expect(calls[0]?.p_file_kinds).toEqual(["image"]);
    expect(response.results[0]?.matchedBy).toEqual(["words"]);
    expect(response.results[0]?.locations[0].path).toBe("/Lab/Gels/IMG_4821.jpg");
  });

  it("reports unconfigured when there is no embedder", async () => {
    const outcome = await embedQuery({ config: { kind: "unconfigured" }, text: "x" });
    expect(outcome).toEqual({ kind: "failed", reason: "embed_unconfigured" });
  });
});
