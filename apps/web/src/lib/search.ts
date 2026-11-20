import { z } from "zod";
import {
  EmbedResponse,
  SearchFilesRows,
  type FileHit,
  type KeywordReason,
  type FileSearchResponse,
  type LabelOutcome,
  type SearchParams,
} from "./domain";
import type { EmbedConfig } from "@/env";
import type { LabId } from "./ids";

// Hosted, a warm query spends about 270 ms inside Modal before Vercel's own hop (decisions.md, 2026-11-20).
export const EMBED_TIMEOUT_MS = 1000;

export type EmbedOutcome = { kind: "ok"; embedding: number[] } | { kind: "failed"; reason: KeywordReason };

export async function embedQuery({
  config,
  text,
  timeoutMs = EMBED_TIMEOUT_MS,
}: {
  config: EmbedConfig;
  text: string;
  timeoutMs?: number;
}): Promise<EmbedOutcome> {
  switch (config.kind) {
    case "unconfigured":
      return { kind: "failed", reason: "embed_unconfigured" };
    case "configured":
      break;
    default: {
      const _exhaustive: never = config;
      return _exhaustive;
    }
  }
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(config.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ text }),
      signal,
    });
    if (!res.ok) return { kind: "failed", reason: "embed_error" };
    const parsed = EmbedResponse.safeParse(await res.json());
    return parsed.success ? { kind: "ok", embedding: parsed.data.embedding } : { kind: "failed", reason: "embed_error" };
  } catch {
    // The timeout can fire during the body read as well as the request, so ask the signal.
    return { kind: "failed", reason: signal.aborted ? "embed_timeout" : "embed_error" };
  }
}

export type SearchFilesArgs = {
  p_lab_id: LabId;
  p_query: string;
  p_query_embedding: string | null;
  p_file_kinds: string[] | null;
  p_path_prefix: string | null;
  p_modified_from: string | null;
  p_modified_to: string | null;
  p_limit: number;
  p_outcomes: LabelOutcome[] | null;
  p_check_only: boolean;
};

export type SearchFilesRpc = (args: SearchFilesArgs) => Promise<unknown>;

export function toVectorLiteral(embedding: readonly number[]): string {
  return `[${embedding.join(",")}]`;
}

function dayAfter(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

export function searchFilesArgs({
  labId,
  params,
  embedding,
}: {
  labId: LabId;
  params: SearchParams;
  embedding: number[] | null;
}): SearchFilesArgs {
  return {
    p_lab_id: labId,
    p_query: params.q,
    p_query_embedding: embedding === null ? null : toVectorLiteral(embedding),
    p_file_kinds: params.kind === undefined ? null : [params.kind],
    p_path_prefix: params.prefix ?? null,
    p_modified_from: params.from === undefined ? null : `${params.from}T00:00:00Z`,
    // The "to" date is inclusive in the UI; search_files treats it as exclusive.
    p_modified_to: params.to === undefined ? null : dayAfter(params.to),
    p_limit: 20,
    p_outcomes: params.outcome === undefined ? null : [params.outcome],
    p_check_only: params.check === true,
  };
}

function parseRows(raw: unknown): FileHit[] {
  const parsed = SearchFilesRows.safeParse(raw);
  if (!parsed.success) throw new Error(`search_files returned an unexpected shape: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export async function searchWithFallback({
  labId,
  params,
  embed,
  searchFiles,
}: {
  labId: LabId;
  params: SearchParams;
  embed: (text: string) => Promise<EmbedOutcome>;
  searchFiles: SearchFilesRpc;
}): Promise<FileSearchResponse> {
  const outcome = await embed(params.q);
  switch (outcome.kind) {
    case "ok": {
      const results = parseRows(await searchFiles(searchFilesArgs({ labId, params, embedding: outcome.embedding })));
      return { kind: "hybrid", results };
    }
    case "failed": {
      const results = parseRows(await searchFiles(searchFilesArgs({ labId, params, embedding: null })));
      return { kind: "keyword", reason: outcome.reason, results };
    }
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}
