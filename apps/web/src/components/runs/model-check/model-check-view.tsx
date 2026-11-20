"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useId, useState } from "react";
import { toast } from "sonner";
import { When } from "@/components/ui/when";
import { cn } from "@/lib/cn";
import {
  answerMark,
  costLine,
  headline,
  headlineNote,
  keepOffered,
  missedLine,
  modelName,
  tally,
  usd,
  type AnswerMark,
  type CheckedTask,
  type CheckSetup,
  type ModelAnswer,
  type ModelCheckRequest,
  type RunModelChecks,
} from "@/lib/model-check";
import { Breadcrumbs } from "../../ui/breadcrumbs";
import { Button } from "../../ui/button";
import { dataRow, dataSurface } from "../../ui/data-table";
import { runHref } from "../runs-api";
import { RunSection } from "../section";
import { modelCheckHref, useModelCheckApi } from "./api";

const queryKey = (runId: string) => ["model-check", runId];

// The run's model check, kept fresh while a model is still answering.
function useModelChecks(initial: RunModelChecks) {
  const api = useModelCheckApi();
  return useQuery({
    queryKey: queryKey(initial.runId),
    queryFn: ({ signal }) => api.load(initial.runId, signal),
    initialData: initial,
    refetchInterval: (q) => (q.state.data?.tasks.some((t) => t.check?.answers.some((a) => a.state === "waiting")) ? 4000 : false),
  });
}

// The page: what the check is, whether it can run, and each task folder built from the run.
export function ModelCheckView({ initial }: { initial: RunModelChecks }) {
  const api = useModelCheckApi();
  const queries = useQueryClient();
  const { data } = useModelChecks(initial);
  const [busy, setBusy] = useState(false);

  const write = async (request: ModelCheckRequest) => {
    setBusy(true);
    try {
      queries.setQueryData(queryKey(data.runId), await api.send(data.runId, request));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't save that. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-6 pb-24 sm:px-8 sm:pt-10">
      <Breadcrumbs
        items={[
          { label: "Runs", href: "/runs" },
          { label: data.title, href: runHref(data.runId) },
          { label: "Model check", href: modelCheckHref(data.runId) },
        ]}
      />
      <h1 className="mt-4 text-heading-medium">Model check</h1>
      <p className="mt-1 max-w-prose text-paragraph-small text-content-secondary">
        Binary asks a few AI models why this run went wrong, using only what is in its task folder. A model solves the task when its answer matches the confirmed cause. The tasks most models get wrong are the ones worth keeping.
      </p>

      <Setup setup={data.setup} />
      {data.tasks.length === 0 ? (
        <RunSection title="No task yet">
          <p className="max-w-prose text-paragraph-small text-content-secondary">
            Build this run&apos;s task folder first, from the{" "}
            <Link href={runHref(data.runId)} className="underline underline-offset-4">
              run&apos;s page
            </Link>
            . The models are sent only what the folder holds.
          </p>
        </RunSection>
      ) : (
        data.tasks.map((task, i) => <TaskCheck key={task.taskId} task={task} newest={i === 0} checks={data} busy={busy} write={write} />)
      )}
    </div>
  );
}

// Only when the check can't run: what to add, in the worker's words.
function Setup({ setup }: { setup: CheckSetup | null }) {
  if (setup !== null && setup.ready) {
    if (setup.unreachable.length === 0) return null;
    return (
      <p className="mt-4 max-w-prose text-paragraph-small text-content-tertiary">
        {setup.unreachable.map((u) => `${modelName(u.model)} needs ${u.needs}`).join(". ")}. The check runs without {setup.unreachable.length === 1 ? "it" : "them"}.
      </p>
    );
  }
  const keys = setup === null || setup.missing.length === 0 ? ["OPENROUTER_API_KEY"] : setup.missing;
  return (
    <RunSection title="Not set up yet">
      <p className="max-w-prose text-paragraph-small text-content-secondary">
        The model check runs on Binary&apos;s worker and needs a key to reach the models. Add <code className="text-label-small">{keys.join(", ")}</code> to the worker&apos;s settings and restart it. One OpenRouter key reaches every model; a provider&apos;s own key reaches only its models. Nothing is sent until then.
      </p>
    </RunSection>
  );
}

type Write = (request: ModelCheckRequest) => Promise<void>;

function TaskCheck({ task, newest, checks, busy, write }: { task: CheckedTask; newest: boolean; checks: RunModelChecks; busy: boolean; write: Write }) {
  const title = newest ? "This run's task" : "An earlier task";
  const built = (
    <>
      Built <When iso={task.builtAt} />.
    </>
  );
  if (task.withdrawnAt !== null) {
    return (
      <RunSection title={title} note={built}>
        <p className="max-w-prose text-paragraph-small text-content-secondary">
          Withdrawn <When iso={task.withdrawnAt} /> because sharing went off. It can&apos;t be sent to a model again.
        </p>
        {task.check === null ? null : <Answers task={task} checks={checks} busy={busy} write={write} />}
      </RunSection>
    );
  }
  return (
    <RunSection title={title} note={built}>
      {task.check === null ? <Start task={task} setup={checks.setup} busy={busy} write={write} /> : <Answers task={task} checks={checks} busy={busy} write={write} />}
    </RunSection>
  );
}

function listOf(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function Start({ task, setup, busy, write }: { task: CheckedTask; setup: CheckSetup | null; busy: boolean; write: Write }) {
  if (setup === null || !setup.ready) return <p className="text-paragraph-small text-content-tertiary">Once the key is added, this task can be checked here.</p>;
  const n = setup.models.length;
  return (
    <div className="max-w-prose">
      <p className="text-paragraph-small text-content-secondary">
        {listOf(setup.models.map((m) => modelName(m.model)))} will each be sent the question, the context, the protocol as run and the evidence. Not the answer key, the rubric or the review notes. {costLine(setup)}
      </p>
      <Button className="mt-3" disabled={busy} onClick={() => void write({ action: "start", taskId: task.taskId })}>
        Check with {n === 1 ? "1 model" : `${n} models`}
      </Button>
    </div>
  );
}

function Answers({ task, checks, busy, write }: { task: CheckedTask; checks: RunModelChecks; busy: boolean; write: Write }) {
  const check = task.check;
  if (check === null) return null;
  const t = tally(check.answers);
  const note = headlineNote(t);
  const open = task.withdrawnAt === null;
  return (
    <div>
      <p className="text-heading-small text-content-primary">{headline(t)}</p>
      {note === null ? null : <p className="mt-1 max-w-prose text-paragraph-small text-content-secondary">{note}</p>}
      {t.toJudge > 0 ? <JudgeAgainst checks={checks} /> : null}
      <ul className={cn(dataSurface, "mt-4")}>
        {check.answers.map((a) => (
          <AnswerRow key={a.id} answer={a} canJudge={checks.canJudge && open} busy={busy} write={write} />
        ))}
      </ul>
      <p className="mt-2 text-paragraph-xsmall text-content-tertiary">
        Spent {usd(check.spentUsd)} of the {usd(check.costCapUsd)} cap. Asked <When iso={check.requestedAt} />.
      </p>
      {open ? <Keep task={task} offered={keepOffered(t)} busy={busy} write={write} /> : null}
      {open && t.waiting === 0 && checks.setup?.ready ? (
        <button type="button" disabled={busy} onClick={() => void write({ action: "start", taskId: task.taskId })} className="mt-4 text-label-small text-content-secondary underline underline-offset-4 disabled:text-content-tertiary">
          Check again
        </button>
      ) : null}
    </div>
  );
}

// What the second scientist judges against: the confirmed cause and the rubric.
function JudgeAgainst({ checks }: { checks: RunModelChecks }) {
  return (
    <div className="mt-4 max-w-prose rounded-card border border-border-opaque px-4 py-3">
      <p className="text-label-small text-content-secondary">Judge against the confirmed cause</p>
      <p className="mt-1 text-paragraph-small text-content-primary">{checks.confirmedCause ?? "No confirmed cause is written down."}</p>
      {checks.rubric.length === 0 ? null : (
        <>
          <p className="mt-3 text-label-small text-content-secondary">and the rubric</p>
          <ul className="mt-1 list-disc pl-5 text-paragraph-small text-content-primary">
            {checks.rubric.map((r) => (
              <li key={r.criterion}>
                {r.criterion}
                {r.points > 0 ? <span className="text-content-tertiary"> ({r.points === 1 ? "1 point" : `${r.points} points`})</span> : null}
              </li>
            ))}
          </ul>
        </>
      )}
      {checks.canJudge ? null : <p className="mt-3 text-paragraph-small text-content-tertiary">You ran this experiment, so someone else in the lab judges these answers.</p>}
    </div>
  );
}

const MARK_TONE: Readonly<Record<AnswerMark["kind"], string>> = {
  solved: "text-content-primary",
  not_solved: "text-content-primary",
  to_judge: "text-content-warning",
  waiting: "text-content-tertiary",
  missed: "text-content-tertiary",
};

function AnswerRow({ answer, canJudge, busy, write }: { answer: ModelAnswer; canJudge: boolean; busy: boolean; write: Write }) {
  const mark = answerMark(answer);
  const missed = missedLine(answer);
  const toJudge = mark.kind === "to_judge" && canJudge;
  return (
    <li className={cn(dataRow, "px-4 py-3")}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-label-medium text-content-primary">{modelName(answer.model)}</p>
        <p className={cn("text-label-small", MARK_TONE[mark.kind])}>{mark.text}</p>
      </div>
      {answer.answer === null ? null : <p className="mt-2 max-w-prose text-paragraph-small whitespace-pre-line text-content-primary">{answer.answer}</p>}
      {answer.reason === null ? null : <p className="mt-2 max-w-prose text-paragraph-small text-content-secondary">Why: {answer.reason}</p>}
      {answer.judgedNote === null ? null : <p className="mt-1 max-w-prose text-paragraph-small text-content-secondary">{answer.judgedBy ?? "The second scientist"} noted: {answer.judgedNote}</p>}
      {missed === null ? null : <p className="mt-1 text-paragraph-small text-content-tertiary">{missed}</p>}
      {toJudge ? <Judge answer={answer} busy={busy} write={write} /> : null}
      {answer.judgedAt !== null && canJudge ? (
        <button type="button" disabled={busy} onClick={() => void write({ action: "judge", answerId: answer.id, solved: null, note: "" })} className="mt-2 text-label-small text-content-secondary underline underline-offset-4">
          Take back this judgment
        </button>
      ) : null}
    </li>
  );
}

function Judge({ answer, busy, write }: { answer: ModelAnswer; busy: boolean; write: Write }) {
  const [note, setNote] = useState("");
  const noteId = useId();
  const judge = (solved: boolean) => void write({ action: "judge", answerId: answer.id, solved, note });
  return (
    <div className="mt-3 max-w-prose">
      <label htmlFor={noteId} className="text-label-small text-content-secondary">
        Does this answer match the confirmed cause? A note is optional.
      </label>
      <input
        id={noteId}
        value={note}
        maxLength={2000}
        onChange={(e) => setNote(e.target.value)}
        placeholder="What it got right or wrong"
        className="mt-1 h-8 w-full rounded-md border border-border-opaque bg-background-primary px-2 text-paragraph-small text-content-primary max-sm:h-11 max-sm:text-paragraph-medium"
      />
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="compact" variant="secondary" disabled={busy} onClick={() => judge(true)}>
          It solved it
        </Button>
        <Button size="compact" variant="secondary" disabled={busy} onClick={() => judge(false)}>
          It didn&apos;t
        </Button>
      </div>
    </div>
  );
}

function Keep({ task, offered, busy, write }: { task: CheckedTask; offered: boolean; busy: boolean; write: Write }) {
  if (task.keptAt !== null) {
    return (
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="text-paragraph-small text-content-primary">
          Kept{task.keptBy === null ? "" : ` by ${task.keptBy}`} <When iso={task.keptAt} />.
        </p>
        <button type="button" disabled={busy} onClick={() => void write({ action: "keep", taskId: task.taskId, keep: false })} className="text-label-small text-content-secondary underline underline-offset-4">
          Stop keeping it
        </button>
      </div>
    );
  }
  if (!offered) return null;
  return (
    <div className="mt-4 max-w-prose">
      <p className="text-paragraph-small text-content-secondary">Most models got this wrong, so it&apos;s a task worth keeping.</p>
      <Button className="mt-2" disabled={busy} onClick={() => void write({ action: "keep", taskId: task.taskId, keep: true })}>
        Keep this task
      </Button>
    </div>
  );
}
