"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Tabs, ToggleGroup } from "radix-ui";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import type { FileHit } from "@/lib/domain";
import { cn } from "@/lib/cn";
import type { TalkThroughId } from "@/lib/ids";
import { folderOf } from "@/lib/format";
import {
  authorName,
  CreateProtocolRequest,
  KIND_NAMES,
  PROTOCOL_KINDS,
  protocolHref,
  ProtocolKind,
  SaveProtocolRequest,
  type AuthorNames,
  type ProtocolVersion,
} from "@/lib/protocols";
import { recordHref, talkThroughHref, ApplyTalkThroughRequest } from "@/lib/talk-throughs";
import { KindIcon } from "../files/kind-icon";
import { useLabApi } from "../lab-api";
import { Button, buttonVariants } from "../ui/button";
import { Caption, Input, Label, Textarea } from "../ui/field";
import { CrumbBar } from "./crumb-bar";
import { Markdown } from "./markdown";
import { When } from "@/components/ui/when";

export type StartFile = { hit: FileHit; text: string | null };

// A new page, possibly started from a file, or the next version of an existing one, or
// either of those from a talk-through's steps (or its transcript, when no steps came).
export type EditorMode =
  | { kind: "create"; from: StartFile | null; title: string }
  | { kind: "edit"; page: ProtocolVersion }
  | {
      kind: "talk_through";
      talkThroughId: TalkThroughId;
      // The version the recording was made against; null for a new page.
      base: ProtocolVersion | null;
      pageKind: ProtocolKind;
      title: string;
      body: string;
      from: "steps" | "transcript";
    };

type Draft = { kind: ProtocolKind; title: string; body: string; note: string };

// "stale": someone saved since this edit began. "behind": their version is loaded as the
// new base, and the person's own text is still in the editor.
type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "invalid"; message: string }
  | { kind: "failed"; message: string }
  | { kind: "stale" }
  | { kind: "loading_theirs" }
  | { kind: "behind"; theirs: ProtocolVersion };

function initialDraft(mode: EditorMode): Draft {
  switch (mode.kind) {
    case "create":
      return { kind: "protocol", title: mode.title, body: mode.from?.text ?? "", note: "" };
    case "edit":
      return { kind: mode.page.kind, title: mode.page.title, body: mode.page.body, note: "" };
    case "talk_through":
      return { kind: mode.pageKind, title: mode.title, body: mode.body, note: mode.base === null ? "" : "From a talk-through" };
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

export function ProtocolEditor({ mode, authors }: { mode: EditorMode; authors: AuthorNames }) {
  const api = useLabApi();
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => initialDraft(mode));
  // The version this edit builds on; it moves when the person loads someone else's save.
  const [base, setBase] = useState<ProtocolVersion | null>(mode.kind === "edit" ? mode.page : mode.kind === "talk_through" ? mode.base : null);
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const [done, setDone] = useState(false);
  const ids = useId();

  const changed =
    base === null
      ? draft.title.trim() !== "" || draft.body.trim() !== ""
      : draft.title.trim() !== base.title || draft.body !== base.body;
  const busy = state.kind === "saving" || state.kind === "loading_theirs";

  useEffect(() => {
    if (!changed || done) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [changed, done]);

  const update = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    if (state.kind === "invalid" || state.kind === "failed") setState({ kind: "idle" });
  };

  async function save() {
    if (mode.kind === "talk_through") {
      const req = ApplyTalkThroughRequest.safeParse({ kind: draft.kind, baseVersionId: base?.id ?? null, title: draft.title, body: draft.body, note: draft.note });
      if (!req.success) return setState({ kind: "invalid", message: req.error.issues[0]?.message ?? "Check the page." });
      setState({ kind: "saving" });
      try {
        const outcome = await api.applyTalkThrough(mode.talkThroughId, req.data);
        switch (outcome.kind) {
          case "saved":
            setDone(true);
            toast(outcome.version === 1 ? `Saved ${draft.title.trim()}` : `Saved version ${outcome.version}`);
            router.push(protocolHref(outcome.protocolId));
            return;
          case "stale":
            setState({ kind: "stale" });
            return;
          default: {
            const _exhaustive: never = outcome;
            return _exhaustive;
          }
        }
      } catch (error) {
        setState({ kind: "failed", message: error instanceof Error ? error.message : "We couldn't save that. Try again." });
      }
      return;
    }
    if (mode.kind === "create") {
      const req = CreateProtocolRequest.safeParse({ ...draft, fromSha256: mode.from?.hit.sha256 ?? null });
      if (!req.success) return setState({ kind: "invalid", message: req.error.issues[0]?.message ?? "Check the page." });
      setState({ kind: "saving" });
      try {
        const saved = await api.createProtocol(req.data);
        setDone(true);
        toast(`Saved ${draft.title.trim()}`);
        router.push(protocolHref(saved.protocolId));
      } catch (error) {
        setState({ kind: "failed", message: error instanceof Error ? error.message : "We couldn't save that. Try again." });
      }
      return;
    }
    if (base === null) return;
    const req = SaveProtocolRequest.safeParse({ baseVersionId: base.id, title: draft.title, body: draft.body, note: draft.note });
    if (!req.success) return setState({ kind: "invalid", message: req.error.issues[0]?.message ?? "Check the page." });
    setState({ kind: "saving" });
    try {
      const outcome = await api.saveProtocol(base.protocolId, req.data);
      switch (outcome.kind) {
        case "saved":
          setDone(true);
          toast(`Saved version ${outcome.version}`);
          router.push(protocolHref(outcome.protocolId));
          return;
        case "stale":
          setState({ kind: "stale" });
          return;
        default: {
          const _exhaustive: never = outcome;
          return _exhaustive;
        }
      }
    } catch (error) {
      setState({ kind: "failed", message: error instanceof Error ? error.message : "We couldn't save that. Try again." });
    }
  }

  async function loadTheirs() {
    if (base === null) return;
    setState({ kind: "loading_theirs" });
    try {
      const theirs = await api.protocol(base.protocolId, AbortSignal.timeout(10_000));
      setBase(theirs);
      setState({ kind: "behind", theirs });
    } catch {
      setState({ kind: "stale" });
      toast.error("We couldn't load their version. Try again.");
    }
  }

  const crumbs = crumbsFor(mode);
  const cancelHref =
    mode.kind === "create" ? "/protocols" : mode.kind === "edit" ? protocolHref(mode.page.protocolId) : talkThroughHref(mode.talkThroughId);
  const creating = mode.kind === "create" || (mode.kind === "talk_through" && mode.base === null);

  return (
    <>
      <CrumbBar items={crumbs} />
      <div className="mx-auto w-full max-w-3xl px-4 pt-8 pb-24 sm:px-8 sm:pt-12">
        <h1 className="text-heading-medium">{creating ? "New protocol" : "Edit"}</h1>
        {!creating && base !== null ? (
          <p className="mt-1 text-paragraph-small text-content-tertiary">
            Saving makes version {base.version + 1}. Earlier versions stay in the history.
          </p>
        ) : null}
        {mode.kind === "create" && mode.from === null ? (
          <p className="mt-1 text-paragraph-small text-content-tertiary">
            Rather say it out loud?{" "}
            <Link href={recordHref({ pageKind: draft.kind })} className="text-content-accent underline underline-offset-2">
              Record a talk-through
            </Link>
          </p>
        ) : null}

        <form
          className="mt-8 grid gap-7"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {mode.kind === "create" && mode.from !== null ? <StartFileCard from={mode.from} /> : null}
          {mode.kind === "talk_through" ? (
            <TalkThroughCard from={mode.from} replacesVersion={base?.version ?? null} href={talkThroughHref(mode.talkThroughId)} />
          ) : null}

          {creating ? (
            <div>
              <p id={`${ids}-kind`} className="text-label-medium text-content-primary">
                Kind
              </p>
              <ToggleGroup.Root
                type="single"
                value={draft.kind}
                onValueChange={(value) => {
                  const kind = ProtocolKind.safeParse(value);
                  if (kind.success) update({ kind: kind.data });
                }}
                aria-labelledby={`${ids}-kind`}
                className="mt-2 flex gap-1"
              >
                {PROTOCOL_KINDS.map((kind) => (
                  <ToggleGroup.Item
                    key={kind}
                    value={kind}
                    className={cn(
                      buttonVariants({ variant: draft.kind === kind ? "secondary" : "tertiary", size: "compact" }),
                      draft.kind !== kind && "text-content-secondary",
                    )}
                  >
                    {KIND_NAMES[kind]}
                  </ToggleGroup.Item>
                ))}
              </ToggleGroup.Root>
              <Caption className="mt-2">
                {draft.kind === "protocol"
                  ? "The steps for an experiment, with what a good run looks like."
                  : "How to use a tool or do a technique, for someone new to it."}
              </Caption>
            </div>
          ) : null}

          <div className="grid gap-2">
            <Label htmlFor={`${ids}-title`}>Title</Label>
            <Input
              id={`${ids}-title`}
              value={draft.title}
              onChange={(e) => update({ title: e.target.value })}
              placeholder="P450 BM3 purification"
              autoComplete="off"
              autoFocus={mode.kind === "create" && mode.from === null}
            />
          </div>

          <Tabs.Root defaultValue="write" className="grid gap-2">
            <div className="flex items-end justify-between gap-4">
              <Label htmlFor={`${ids}-body`}>Text</Label>
              <Tabs.List aria-label="Show" className="flex gap-1">
                {(["write", "preview"] as const).map((tab) => (
                  <Tabs.Trigger
                    key={tab}
                    value={tab}
                    className={cn(
                      buttonVariants({ variant: "tertiary", size: "compact" }),
                      "text-content-secondary data-[state=active]:bg-background-secondary data-[state=active]:text-content-primary data-[state=active]:ring-1 data-[state=active]:ring-border-opaque data-[state=active]:ring-inset",
                    )}
                  >
                    {tab === "write" ? "Write" : "Preview"}
                  </Tabs.Trigger>
                ))}
              </Tabs.List>
            </div>
            <Tabs.Content value="write" className="grid gap-2 focus-visible:outline-none">
              <Textarea
                id={`${ids}-body`}
                value={draft.body}
                onChange={(e) => update({ body: e.target.value })}
                aria-describedby={`${ids}-body-hint`}
                placeholder={"1. Thaw the pellet on ice.\n2. Resuspend in 40 mL lysis buffer."}
                spellCheck
                className="min-h-[50dvh] font-mono text-paragraph-small leading-6 sm:min-h-[50dvh]"
              />
              <Caption id={`${ids}-body-hint`}>
                Markdown: # for a heading, 1. for numbered steps, - for a list, | for a table.
              </Caption>
            </Tabs.Content>
            <Tabs.Content
              value="preview"
              className="min-h-[50dvh] rounded-control border border-border-opaque bg-background-raised p-4 sm:p-6"
            >
              {draft.body.trim() === "" ? (
                <p className="text-paragraph-medium text-content-tertiary">Nothing to preview yet.</p>
              ) : (
                <Markdown body={draft.body} />
              )}
            </Tabs.Content>
          </Tabs.Root>

          {!creating ? (
            <div className="grid gap-2">
              <Label htmlFor={`${ids}-note`}>What changed</Label>
              <Input
                id={`${ids}-note`}
                value={draft.note}
                onChange={(e) => update({ note: e.target.value })}
                aria-describedby={`${ids}-note-hint`}
                placeholder="Longer spin after lysis"
                autoComplete="off"
              />
              <Caption id={`${ids}-note-hint`}>Optional. It shows in the history next to this version.</Caption>
            </div>
          ) : null}

          <Conflict
            state={state}
            authors={authors}
            onLoad={() => void loadTheirs()}
            onUseTheirs={(theirs) => {
              setDraft((d) => ({ ...d, title: theirs.title, body: theirs.body }));
              setState({ kind: "idle" });
            }}
          />

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={busy || !changed}>
              {state.kind === "saving" ? "Saving" : creating ? "Create page" : "Save version"}
            </Button>
            <Link href={cancelHref} className={buttonVariants({ variant: "tertiary" })}>
              Cancel
            </Link>
            {state.kind === "invalid" || state.kind === "failed" ? (
              <p role="alert" className="text-paragraph-small text-content-primary">
                {state.message}
              </p>
            ) : null}
          </div>
        </form>
      </div>
    </>
  );
}

function crumbsFor(mode: EditorMode): { label: string; href: string }[] {
  switch (mode.kind) {
    case "create":
      return [{ label: "New protocol", href: "/protocols/new" }];
    case "edit":
      return [
        { label: mode.page.title, href: protocolHref(mode.page.protocolId) },
        { label: "Edit", href: `${protocolHref(mode.page.protocolId)}/edit` },
      ];
    case "talk_through":
      return [
        mode.base === null ? { label: "New protocol", href: "/protocols/new" } : { label: mode.base.title, href: protocolHref(mode.base.protocolId) },
        { label: "Talk-through", href: talkThroughHref(mode.talkThroughId) },
        { label: mode.base === null ? "New protocol" : "Edit", href: `${talkThroughHref(mode.talkThroughId)}/edit` },
      ];
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

function TalkThroughCard({ from, replacesVersion, href }: { from: "steps" | "transcript"; replacesVersion: number | null; href: string }) {
  return (
    <div className="rounded-control border border-border-opaque bg-background-raised p-4">
      <p className="text-label-medium text-content-primary">{from === "steps" ? "Steps drafted from your talk-through" : "The transcript of your talk-through"}</p>
      <p className="mt-1 text-paragraph-small text-content-secondary">
        {from === "steps"
          ? "Check every amount, time and temperature against what you meant before you save. "
          : "Turn it into steps here before you save. "}
        {replacesVersion === null ? "" : `This replaces the page's text; version ${replacesVersion} keeps the old text. `}
        The recording will be linked to the page.{" "}
        <Link href={href} className="text-content-accent underline underline-offset-2">
          Back to the talk-through
        </Link>
      </p>
    </div>
  );
}

function StartFileCard({ from }: { from: StartFile }) {
  const [primary] = from.hit.locations;
  return (
    <div className="flex items-start gap-4 rounded-control border border-border-opaque bg-background-raised p-4">
      <KindIcon kind={from.hit.fileKind} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-label-small text-content-primary">{primary.originalName}</p>
        <p className="mt-1 truncate font-mono text-paragraph-xsmall text-content-tertiary">{folderOf(primary)}</p>
        <p className="mt-2 text-paragraph-small text-content-secondary">
          {from.text === null
            ? "This file has no text we can copy, so the page starts empty. The file will be linked to it."
            : "The text below is copied from this file, as is. Tidy it up, and the file will be linked to the page."}
        </p>
      </div>
    </div>
  );
}

function Conflict({
  state,
  authors,
  onLoad,
  onUseTheirs,
}: {
  state: SaveState;
  authors: AuthorNames;
  onLoad: () => void;
  onUseTheirs: (theirs: ProtocolVersion) => void;
}) {
  const panel = "rounded-control border border-border-raised bg-background-secondary p-4";
  switch (state.kind) {
    case "stale":
    case "loading_theirs":
      return (
        <div role="alert" className={panel}>
          <p className="text-label-medium text-content-primary">Someone else saved a new version while you were editing.</p>
          <p className="mt-1 text-paragraph-small text-content-secondary">
            Your text is still here. Load their version to compare, then save yours on top of it.
          </p>
          <Button type="button" variant="secondary" size="compact" className="mt-3" disabled={state.kind === "loading_theirs"} onClick={onLoad}>
            {state.kind === "loading_theirs" ? "Loading their version" : "Load their version"}
          </Button>
        </div>
      );
    case "behind":
      return (
        <div role="status" className={panel}>
          <p className="text-label-medium text-content-primary">
            Version {state.theirs.version} by {authorName(authors, state.theirs.author)}, saved <When iso={state.theirs.createdAt} />
          </p>
          <p className="mt-1 text-paragraph-small text-content-secondary">
            Your text is unchanged. Saving now makes version {state.theirs.version + 1} from your text, so bring over anything of
            theirs you want to keep.
          </p>
          <details className="mt-3">
            <summary className="flex min-h-11 cursor-pointer items-center text-label-small text-content-primary sm:min-h-8">
              Show their text
            </summary>
            <div className="mt-2 max-h-96 overflow-auto rounded-control border border-border-opaque bg-background-raised p-4">
              <Markdown body={state.theirs.body} className="text-paragraph-medium" />
            </div>
          </details>
          <Button type="button" variant="secondary" size="compact" className="mt-3" onClick={() => onUseTheirs(state.theirs)}>
            Use their text instead
          </Button>
        </div>
      );
    case "idle":
    case "saving":
    case "invalid":
    case "failed":
      return null;
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}
