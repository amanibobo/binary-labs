import "server-only";
import { createReadStream } from "node:fs";
import { parseRange } from "./byte-range";

// A file from the local store as an HTTP answer, honoring one byte range, so a video element
// can seek in dev the way it does against R2.
export function fileResponse({
  path,
  size,
  range,
  headers,
}: {
  path: string;
  size: number;
  range: string | null;
  headers: Record<string, string>;
}): Response {
  const asked = parseRange(range, size);
  const common = { ...headers, "accept-ranges": "bytes" };
  switch (asked.kind) {
    case "whole":
      return new Response(size === 0 ? null : stream(path, 0, size - 1), {
        status: 200,
        headers: { ...common, "content-length": String(size) },
      });
    case "part":
      return new Response(stream(path, asked.start, asked.end), {
        status: 206,
        headers: {
          ...common,
          "content-length": String(asked.end - asked.start + 1),
          "content-range": `bytes ${asked.start}-${asked.end}/${size}`,
        },
      });
    case "unsatisfiable":
      return new Response(null, { status: 416, headers: { ...common, "content-range": `bytes */${size}` } });
    default: {
      const _exhaustive: never = asked;
      return _exhaustive;
    }
  }
}

function stream(path: string, start: number, end: number): ReadableStream<Uint8Array> {
  const chunks: AsyncIterator<Uint8Array> = createReadStream(path, { start, end })[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done === true) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await chunks.return?.();
    },
  });
}
