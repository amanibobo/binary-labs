"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { headline, tally } from "@/lib/model-check";
import { RunSection, type RunSectionSlot } from "../section";
import { modelCheckHref, useModelCheckApi } from "./api";

// The model check's line on the run page, once a task folder has been built: how many models
// solved the newest one, and the way to every answer. Nothing until there is a folder.
export const ModelCheckSection: RunSectionSlot = ({ run }) => {
  const api = useModelCheckApi();
  const { data } = useQuery({ queryKey: ["model-check", run.id], queryFn: ({ signal }) => api.load(run.id, signal) });
  const task = data?.tasks[0];
  if (task === undefined) return null;
  const line = task.check === null ? "No model has tried this run's task yet." : `${headline(tally(task.check.answers))}.`;
  return (
    <RunSection title="Model check">
      <p className="text-paragraph-small text-content-primary">
        {line}{" "}
        <Link href={modelCheckHref(run.id)} className="text-content-secondary underline underline-offset-4">
          {task.check === null ? "Check it with models" : "See each model's answer"}
        </Link>
      </p>
    </RunSection>
  );
};
