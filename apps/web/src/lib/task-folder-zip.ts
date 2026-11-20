import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { crc32, deflateRawSync } from "node:zlib";

// Writes a zip to a file on disk. Bytes already in memory (the written parts, scrubbed text)
// are deflated; a stream (a file copied from the store) is stored as it is, since images and
// workbooks are already compressed, and is never held in memory whole. No zip64: the folder
// builder keeps a folder under 1 GB.

export type ZipEntry = { path: string; data: Uint8Array | (() => Promise<AsyncIterable<Uint8Array>>) };
export type ZipWritten = { bytes: number; sha256: string; entries: { path: string; bytes: number; sha256: string }[] };

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const UTF8_NAMES = 0x0800;

function dosTime(at: Date): { time: number; date: number } {
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1),
    date: ((Math.max(1980, at.getUTCFullYear()) - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

type Written = { name: Buffer; method: number; crc: number; packed: number; size: number; offset: number };

function localHeader(e: Written, stamp: { time: number; date: number }): Buffer {
  const head = Buffer.alloc(30);
  head.writeUInt32LE(LOCAL, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(UTF8_NAMES, 6);
  head.writeUInt16LE(e.method, 8);
  head.writeUInt16LE(stamp.time, 10);
  head.writeUInt16LE(stamp.date, 12);
  head.writeUInt32LE(e.crc, 14);
  head.writeUInt32LE(e.packed, 18);
  head.writeUInt32LE(e.size, 22);
  head.writeUInt16LE(e.name.length, 26);
  return Buffer.concat([head, e.name]);
}

function centralHeader(e: Written, stamp: { time: number; date: number }): Buffer {
  const head = Buffer.alloc(46);
  head.writeUInt32LE(CENTRAL, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(20, 6);
  head.writeUInt16LE(UTF8_NAMES, 8);
  head.writeUInt16LE(e.method, 10);
  head.writeUInt16LE(stamp.time, 12);
  head.writeUInt16LE(stamp.date, 14);
  head.writeUInt32LE(e.crc, 16);
  head.writeUInt32LE(e.packed, 20);
  head.writeUInt32LE(e.size, 24);
  head.writeUInt16LE(e.name.length, 28);
  head.writeUInt32LE(e.offset, 42);
  return Buffer.concat([head, e.name]);
}

export async function writeZip(file: string, entries: readonly ZipEntry[], at: Date): Promise<ZipWritten> {
  const stamp = dosTime(at);
  const out = await open(file, "w");
  const done: Written[] = [];
  const hashes: ZipWritten["entries"] = [];
  let offset = 0;
  const write = async (bytes: Uint8Array) => {
    await out.write(bytes, 0, bytes.length, offset);
    offset += bytes.length;
  };
  try {
    for (const entry of entries) {
      const name = Buffer.from(entry.path, "utf8");
      const hash = createHash("sha256");
      if (entry.data instanceof Uint8Array) {
        const packed = deflateRawSync(entry.data);
        const e = { name, method: 8, crc: crc32(entry.data), packed: packed.length, size: entry.data.length, offset };
        await write(localHeader(e, stamp));
        await write(packed);
        hash.update(entry.data);
        done.push(e);
      } else {
        // The sizes and checksum aren't known until the stream ends, so the header is written
        // twice: a placeholder now, the real one over it afterwards.
        const e = { name, method: 0, crc: 0, packed: 0, size: 0, offset };
        await write(localHeader(e, stamp));
        for await (const chunk of await entry.data()) {
          e.crc = crc32(chunk, e.crc);
          e.size += chunk.length;
          hash.update(chunk);
          await write(chunk);
        }
        e.packed = e.size;
        const head = localHeader(e, stamp);
        await out.write(head, 0, head.length, e.offset);
        done.push(e);
      }
      const written = done[done.length - 1];
      hashes.push({ path: entry.path, bytes: written?.size ?? 0, sha256: hash.digest("hex") });
    }
    const directoryAt = offset;
    for (const e of done) await write(centralHeader(e, stamp));
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END, 0);
    end.writeUInt16LE(done.length, 8);
    end.writeUInt16LE(done.length, 10);
    end.writeUInt32LE(offset - directoryAt, 12);
    end.writeUInt32LE(directoryAt, 16);
    await write(end);
  } finally {
    await out.close();
  }
  const whole = createHash("sha256");
  for await (const chunk of createReadStream(file)) whole.update(chunk);
  return { bytes: offset, sha256: whole.digest("hex"), entries: hashes };
}
