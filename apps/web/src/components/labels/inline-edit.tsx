"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { DeleteIcon } from "../icons/base-web";
import type { EditOutcome } from "./labels-context";

// Click, type, Enter. Escape or leaving the field cancels. The trigger gets focus back
// either way, so keyboard users stay where they were.
export function InlineEdit({
  initial,
  inputLabel,
  placeholder,
  onSubmit,
  onRemove,
  removeLabel,
  trigger,
  triggerClassName,
  inputClassName,
  className,
}: {
  initial: string;
  inputLabel: string;
  placeholder?: string;
  onSubmit: (text: string) => EditOutcome;
  onRemove?: () => void;
  removeLabel?: string;
  trigger: ReactNode;
  triggerClassName?: string;
  inputClassName?: string;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const errorId = useId();

  const open = () => {
    setText(initial);
    setError(null);
    setEditing(true);
  };
  const close = () => {
    setEditing(false);
    setError(null);
    // The trigger mounts again on the next render.
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  if (!editing) {
    return (
      <button ref={triggerRef} type="button" onClick={open} className={triggerClassName}>
        {trigger}
      </button>
    );
  }

  return (
    <span
      className={cn("pointer-events-auto relative inline-flex max-w-full flex-col", className)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) close();
      }}
    >
      <span className="flex max-w-full items-center gap-1">
        <input
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              const outcome = onSubmit(text);
              if (outcome.kind === "saved") close();
              else setError(outcome.message);
            }
          }}
          aria-label={inputLabel}
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : errorId}
          placeholder={placeholder}
          enterKeyHint="done"
          autoComplete="off"
          spellCheck={false}
          className={cn(
            "min-w-0 rounded-[4px] border-2 border-border-selected bg-background-primary text-content-primary placeholder:text-content-tertiary focus-visible:outline-none",
            inputClassName,
          )}
        />
        {onRemove === undefined ? null : (
          <button
            type="button"
            onClick={() => {
              onRemove();
              close();
            }}
            className="relative flex size-6 shrink-0 items-center justify-center rounded-[4px] text-content-secondary hover:bg-button-tertiary-hover max-sm:size-8 after:absolute after:-inset-2.5 sm:after:-inset-1"
          >
            <DeleteIcon className="size-4" />
            <span className="sr-only">{removeLabel ?? "Remove"}</span>
          </button>
        )}
      </span>
      {error === null ? null : (
        <span id={errorId} role="alert" className="mt-1 text-paragraph-xsmall text-content-primary">
          {error}
        </span>
      )}
    </span>
  );
}
