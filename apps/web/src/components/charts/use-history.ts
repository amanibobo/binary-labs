"use client";
import { useCallback, useState } from "react";

// Undo and redo over a value. Each change is a step, except that changes with the same `group`
// within a second of each other (typing in one field) are one step.
type History<T> = { past: T[]; present: T; future: T[]; group: string | null; at: number };

const LIMIT = 100;
const GROUP_MS = 1000;

export function useHistory<T>(initial: () => T) {
  const [history, setHistory] = useState<History<T>>(() => ({ past: [], present: initial(), future: [], group: null, at: 0 }));

  const change = useCallback((f: (value: T) => T, group?: string) => {
    const now = Date.now();
    setHistory((h) => {
      const next = f(h.present);
      if (Object.is(next, h.present)) return h;
      const joined = group !== undefined && group === h.group && now - h.at < GROUP_MS;
      return { past: joined ? h.past : [...h.past.slice(-(LIMIT - 1)), h.present], present: next, future: [], group: group ?? null, at: now };
    });
  }, []);

  const undo = useCallback(() => {
    setHistory((h) => {
      const previous = h.past.at(-1);
      return previous === undefined ? h : { past: h.past.slice(0, -1), present: previous, future: [h.present, ...h.future], group: null, at: 0 };
    });
  }, []);

  const redo = useCallback(() => {
    setHistory((h) => {
      const [next, ...rest] = h.future;
      return next === undefined ? h : { past: [...h.past, h.present], present: next, future: rest, group: null, at: 0 };
    });
  }, []);

  // Replaces the value without a step, as a save does with what the server returned.
  const settle = useCallback((value: T) => setHistory((h) => ({ ...h, present: value, group: null })), []);

  return { value: history.present, change, undo, redo, settle, canUndo: history.past.length > 0, canRedo: history.future.length > 0 };
}
