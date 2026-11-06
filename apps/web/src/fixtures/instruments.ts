import { InstrumentId } from "@/lib/ids";
import type { Instrument } from "@/lib/instruments";
import type { PairingCode } from "@/app/settings/actions";

const NOW = Date.parse("2026-11-05T15:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const id = (n: number) => InstrumentId.parse(`00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`);

export const fixturePairing: PairingCode = {
  instrumentId: id(1),
  name: "qPCR, room 214",
  code: "K7QM-4XPA",
  expiresAt: ago(-14),
  server: "https://binary.example.edu",
};

// The first is the instrument the pairing code is for; it shows as paired in ?code=paired.
export const instruments: Instrument[] = [
  { id: id(1), name: "qPCR, room 214", files: 3, state: { kind: "paired", pairedAt: ago(1), seenSecondsAgo: 20 } },
  { id: id(2), name: "Plate reader, room 214", files: 1284, state: { kind: "paired", pairedAt: ago(60 * 24 * 9), seenSecondsAgo: 40 } },
  { id: id(3), name: "NanoDrop, bench 3", files: 412, state: { kind: "paired", pairedAt: ago(60 * 24 * 20), seenSecondsAgo: 26 * 3600 } },
  { id: id(4), name: "Gel imager", files: 0, state: { kind: "expired" } },
  { id: id(5), name: "Old plate reader", files: 96, state: { kind: "revoked", revokedAt: ago(60 * 24 * 30) } },
];

export const waitingInstrument: Instrument = { ...instruments[0]!, files: 0, state: { kind: "waiting", expiresAt: ago(-14) } };
