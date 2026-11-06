"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/cn";
import { formatDay } from "@/lib/format";
import type { Sha256, UserId } from "@/lib/ids";
import { authorName, NOTE_MAX, protocolHref, TITLE_MAX, type AuthorNames } from "@/lib/protocols";
import {
  foldDiff,
  suggestionHref,
  lineDiff,
  type ApproveRequest,
  type LabelChange,
  type LabelFacts,
  type LabelSuggestion,
  type ProtocolEditSuggestion,
  type Suggestion,
} from "@/lib/suggestions";
import { Breadcrumbs } from "../ui/breadcrumbs";
import { Button } from "../ui/button";
import { Input, Label, Textarea } from "../ui/field";
import { When } from "../ui/when";
import { useAskApi } from "./ask-api";
import { SourceList } from "./answer-panel";

// One suggestion: what the AI proposes, the files that led to it, and the only three things
// that can happen to it. Nothing here changes the lab until Approve is pressed.

export function SuggestionView({ suggestion, authors, viewerId }: { suggestion: Suggestion; authors: AuthorNames; viewerId: UserId }) {
  const title = suggestion.kind === "protocol_edit" ? `Suggested edit to ${suggestion.before.title}` : "Suggested label fixes";
  return (
    <>
      <div className="border-b border-border-opaque">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center px-4 sm:px-8">
          <Breadcrumbs items={[{ label: "Suggestions", href: "/suggestions" }, { label: title, href: suggestionHref(suggestion.id) }]} />
        </div>
      </div>
      <div className="mx-auto w-full max-w-3xl px-4 pt-8 pb-24 sm:px-8 sm:pt-12">
        <h1 className="text-heading-medium sm:text-heading-large">{title}</h1>
        <p className="mt-2 text-paragraph-small text-content-tertiary">
          {suggestion.kind === "protocol_edit" ? `Drafted from version ${suggestion.baseVersion} · ` : null}
          Asked for by {authorName(authors, suggestion.requestedBy)} · <When iso={suggestion.createdAt} />
        </p>
        <p className="mt-5 max-w-prose text-paragraph-large text-content-primary">{suggestion.summary}</p>
        <Decided suggestion={suggestion} authors={authors} viewerId={viewerId} />
        {suggestion.kind === "protocol_edit" ? <ProtocolEdit suggestion={suggestion} /> : <LabelChanges suggestion={suggestion} />}
        {suggestion.sources.length > 0 ? (
          <section className="mt-10">
            <h2 className="text-label-small text-content-tertiary">{suggestion.kind === "protocol_edit" ? "From these files" : "Files"}</h2>
            <SourceList sources={suggestion.sources} sentences={[]} numbered={null} />
          </section>
        ) : null}
      </div>
    </>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return <p className="mt-6 rounded-control border border-border-opaque bg-background-secondary px-4 py-3 text-paragraph-small text-content-secondary">{children}</p>;
}

function Decided({ suggestion, authors, viewerId }: { suggestion: Suggestion; authors: AuthorNames; viewerId: UserId }) {
  const { state, decidedBy, decidedAt } = suggestion.decision;
  if (state === "open" || decidedAt === null) return null;
  const who = decidedBy === viewerId ? "you" : authorName(authors, decidedBy);
  const when = <When iso={decidedAt} />;
  if (state === "dismissed") {
    return (
      <Notice>
        Dismissed by {who} on {when}. Nothing was changed.
      </Notice>
    );
  }
  if (suggestion.kind === "protocol_edit") {
    return (
      <Notice>
        Approved by {who} on {when}
        {suggestion.appliedVersion === null ? "." : (
          <>
            {" "}as{" "}
            <Link href={protocolHref(suggestion.protocolId, suggestion.appliedVersion)} className="text-content-accent underline underline-offset-2">
              version {suggestion.appliedVersion}
            </Link>
            .
          </>
        )}
      </Notice>
    );
  }
  const applied = suggestion.changes.filter((c) => c.applied).length;
  return (
    <Notice>
      Approved by {who} on {when}. {applied} of {suggestion.changes.length} files changed, each as a correction by {who}.
    </Notice>
  );
}

function useDecide() {
  const api = useAskApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function approve(suggestion: Suggestion, req: ApproveRequest, done: string) {
    setBusy(true);
    try {
      const outcome = await api.approve(suggestion.id, req);
      if (outcome.kind === "stale") toast.error("Someone saved this protocol since the draft. Dismiss it and ask again.");
      else toast(done);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't approve that.");
    }
    setBusy(false);
  }
  async function dismiss(suggestion: Suggestion) {
    setBusy(true);
    try {
      await api.dismiss(suggestion.id);
      toast("Dismissed. Nothing was changed.");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't dismiss that.");
    }
    setBusy(false);
  }
  return { busy, approve, dismiss };
}

function Diff({ before, after }: { before: string; after: string }) {
  const blocks = foldDiff(lineDiff(before, after));
  return (
    <div className="mt-3 overflow-x-auto rounded-xl border border-border-opaque font-mono text-paragraph-small" role="figure" aria-label="Changes to the protocol's text">
      {blocks.map((block, i) =>
        block.kind === "folded" ? (
          <p key={i} className="bg-background-secondary px-4 py-1.5 font-sans text-paragraph-xsmall text-content-tertiary">
            {block.count === 1 ? "1 unchanged line" : `${block.count} unchanged lines`}
          </p>
        ) : (
          <div key={i}>
            {block.lines.map((line, j) => (
              <div
                key={j}
                className={cn(
                  "flex gap-3 px-4 py-0.5 whitespace-pre-wrap",
                  line.kind === "added" && "bg-tint-green-wash text-content-primary",
                  line.kind === "removed" && "text-content-tertiary line-through decoration-content-tertiary/60",
                  line.kind === "same" && "text-content-secondary",
                )}
              >
                <span aria-hidden className="w-3 shrink-0 select-none text-content-tertiary no-underline">
                  {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : ""}
                </span>
                <span className="sr-only">{line.kind === "added" ? "Added: " : line.kind === "removed" ? "Removed: " : ""}</span>
                <span className="min-w-0 flex-1">{line.text === "" ? " " : line.text}</span>
              </div>
            ))}
          </div>
        ),
      )}
    </div>
  );
}

function ProtocolEdit({ suggestion }: { suggestion: ProtocolEditSuggestion }) {
  const { busy, approve, dismiss } = useDecide();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(suggestion.draft.title);
  const [body, setBody] = useState(suggestion.draft.body);
  const [note, setNote] = useState(suggestion.draft.note ?? "");
  const ids = { title: useId(), body: useId(), note: useId() };
  const open = suggestion.decision.state === "open";
  const titleChanged = suggestion.draft.title.trim() !== suggestion.before.title.trim();

  if (editing && open) {
    return (
      <form
        className="mt-8 space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          void approve(suggestion, { kind: "protocol_edit", edit: { title, body, note: note.trim() === "" ? null : note } }, "Approved with your edits.");
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor={ids.title}>Title</Label>
          <Input id={ids.title} value={title} maxLength={TITLE_MAX} required onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={ids.body}>Text</Label>
          <Textarea id={ids.body} value={body} rows={16} onChange={(e) => setBody(e.target.value)} className="font-mono text-paragraph-small" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={ids.note}>Version note</Label>
          <Input id={ids.note} value={note} maxLength={NOTE_MAX} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || title.trim() === ""}>
            Approve with my edits
          </Button>
          <Button type="button" variant="tertiary" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      </form>
    );
  }

  return (
    <section className="mt-8">
      <h2 className="text-label-small text-content-tertiary">Changes</h2>
      {titleChanged ? (
        <p className="mt-2 text-paragraph-small text-content-secondary">
          Title: <span className="line-through">{suggestion.before.title}</span> → {suggestion.draft.title}
        </p>
      ) : null}
      <Diff before={suggestion.before.body} after={suggestion.draft.body} />
      {suggestion.draft.note === null ? null : <p className="mt-2 text-paragraph-small text-content-tertiary">Version note: {suggestion.draft.note}</p>}
      {open && suggestion.stale ? (
        <Notice>Someone saved this protocol since the draft, so approving it would overwrite their version. Dismiss it and ask for a new one.</Notice>
      ) : null}
      {open ? (
        <div className="mt-6 flex flex-wrap gap-2">
          {suggestion.stale ? null : (
            <>
              <Button disabled={busy} onClick={() => void approve(suggestion, { kind: "protocol_edit", edit: null }, `Approved. Saved as version ${suggestion.baseVersion + 1}.`)}>
                Approve
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => setEditing(true)}>
                Edit first
              </Button>
            </>
          )}
          <Button variant="tertiary" disabled={busy} onClick={() => void dismiss(suggestion)}>
            Dismiss
          </Button>
        </div>
      ) : null}
    </section>
  );
}

const FIELDS: { key: keyof LabelFacts; label: string }[] = [
  { key: "cleanName", label: "Name" },
  { key: "experiment", label: "Experiment" },
  { key: "person", label: "Person" },
  { key: "date", label: "Date" },
];

function factText(key: keyof LabelFacts, value: string | null): string {
  if (value === null) return "none";
  return key === "date" ? formatDay(value) : value;
}

function ChangeRow({ change, checked, onToggle, open }: { change: LabelChange; checked: boolean; onToggle: () => void; open: boolean }) {
  const id = useId();
  const name = change.current.cleanName ?? change.path.split("/").at(-1) ?? change.path;
  return (
    <li className="flex items-start gap-3 py-3">
      {open ? <input id={id} type="checkbox" checked={checked} onChange={onToggle} className="mt-1 size-4 shrink-0 accent-[var(--content-primary)]" /> : null}
      <label htmlFor={open ? id : undefined} className="min-w-0 flex-1">
        <span className="block truncate text-label-medium text-content-primary">{name}</span>
        <span className="mt-0.5 block truncate font-mono text-paragraph-xsmall text-content-tertiary">{change.path}</span>
        {FIELDS.filter((f) => change.proposed[f.key] !== null).map((f) => (
          <span key={f.key} className="mt-1 block text-paragraph-small text-content-secondary">
            {/* Once decided, the label shown now may already be the change, so only the change is said. */}
            {f.label}: {open ? <>{factText(f.key, change.current[f.key])} → </> : null}
            <span className="text-content-primary">{factText(f.key, change.proposed[f.key])}</span>
          </span>
        ))}
        <span className="mt-1 block text-paragraph-small text-content-tertiary">{change.reason}</span>
        {!open && !change.applied ? <span className="mt-1 block text-paragraph-small text-content-secondary">Left out, so this label wasn&apos;t changed.</span> : null}
      </label>
    </li>
  );
}

function LabelChanges({ suggestion }: { suggestion: LabelSuggestion }) {
  const { busy, approve, dismiss } = useDecide();
  const [chosen, setChosen] = useState<ReadonlySet<Sha256>>(() => new Set(suggestion.changes.map((c) => c.sha256)));
  const open = suggestion.decision.state === "open";
  const toggle = (sha: Sha256) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(sha)) next.delete(sha);
      else next.add(sha);
      return next;
    });
  const count = chosen.size;
  return (
    <section className="mt-8">
      <h2 className="text-label-small text-content-tertiary">
        {open ? "Uncheck any file to leave its label as it is" : "Changes"}
      </h2>
      <ul className="mt-1 divide-y divide-border-opaque">
        {suggestion.changes.map((change) => (
          <ChangeRow key={change.sha256} change={change} checked={chosen.has(change.sha256)} onToggle={() => toggle(change.sha256)} open={open} />
        ))}
      </ul>
      {open ? (
        <div className="mt-6 flex flex-wrap gap-2">
          <Button
            disabled={busy || count === 0}
            onClick={() => void approve(suggestion, { kind: "labels", shas: [...chosen] }, count === 1 ? "Changed 1 label." : `Changed ${count} labels.`)}
          >
            {count === suggestion.changes.length ? "Approve all" : count === 1 ? "Approve 1 file" : `Approve ${count} files`}
          </Button>
          <Button variant="tertiary" disabled={busy} onClick={() => void dismiss(suggestion)}>
            Dismiss
          </Button>
        </div>
      ) : null}
    </section>
  );
}
