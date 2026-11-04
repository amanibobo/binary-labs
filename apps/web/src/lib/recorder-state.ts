// The recorder's states, apart from the browser APIs that drive them, so the timing and the
// order of what can happen next are testable on their own.

// One recording, made here or picked from the device, ready to send.
export type Take = { blob: Blob; url: string; name: string; type: string; durationMs: number | null; madeHere: boolean };

export type RecorderState =
  | { kind: "idle"; problem: string | null }
  | { kind: "starting" }
  | { kind: "recording"; since: number; banked: number }
  | { kind: "paused"; banked: number }
  | { kind: "recorded"; take: Take; capped: boolean }
  | { kind: "sending"; take: Take; sent: number }
  | { kind: "send_failed"; take: Take; message: string; retryable: boolean }
  | { kind: "sent" };

export type RecorderAction =
  | { type: "start" }
  | { type: "started"; at: number }
  | { type: "problem"; message: string }
  | { type: "pause"; at: number }
  | { type: "resume"; at: number }
  | { type: "stopped"; take: Take; capped: boolean }
  | { type: "picked"; take: Take }
  | { type: "discard" }
  | { type: "send" }
  | { type: "progress"; sent: number }
  | { type: "send_failed"; message: string; retryable: boolean }
  | { type: "sent" };

export function elapsedMs(state: RecorderState, now: number): number {
  switch (state.kind) {
    case "recording":
      return state.banked + (now - state.since);
    case "paused":
      return state.banked;
    case "recorded":
    case "sending":
    case "send_failed":
      return state.take.durationMs ?? 0;
    case "idle":
    case "starting":
    case "sent":
      return 0;
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

export function takeOf(state: RecorderState): Take | null {
  return state.kind === "recorded" || state.kind === "sending" || state.kind === "send_failed" ? state.take : null;
}

export function recorderReducer(state: RecorderState, action: RecorderAction): RecorderState {
  switch (action.type) {
    case "start":
      return state.kind === "idle" ? { kind: "starting" } : state;
    case "started":
      return state.kind === "starting" ? { kind: "recording", since: action.at, banked: 0 } : state;
    case "problem":
      return { kind: "idle", problem: action.message };
    case "pause":
      return state.kind === "recording" ? { kind: "paused", banked: state.banked + (action.at - state.since) } : state;
    case "resume":
      return state.kind === "paused" ? { kind: "recording", since: action.at, banked: state.banked } : state;
    case "stopped":
      return { kind: "recorded", take: action.take, capped: action.capped };
    case "picked":
      return { kind: "recorded", take: action.take, capped: false };
    case "discard":
      return { kind: "idle", problem: null };
    case "send": {
      const take = takeOf(state);
      return take === null ? state : { kind: "sending", take, sent: 0 };
    }
    case "progress":
      return state.kind === "sending" ? { ...state, sent: action.sent } : state;
    case "send_failed":
      return state.kind === "sending" ? { kind: "send_failed", take: state.take, message: action.message, retryable: action.retryable } : state;
    case "sent":
      return { kind: "sent" };
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}
