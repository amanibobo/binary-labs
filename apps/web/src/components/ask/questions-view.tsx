"use client";

import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useId, useState } from "react";
import { questionHref, type QuestionCursor } from "@/lib/answers";
import type { UserId } from "@/lib/ids";
import { useDebounced } from "@/lib/use-debounced";
import { Button } from "../ui/button";
import { Input } from "../ui/field";
import { Skeleton } from "../ui/skeleton";
import { useAskApi } from "./ask-api";
import { QuestionRowText, questionRow } from "./ask-home";

const SEARCH_DEBOUNCE_MS = 150;
const FIRST_PAGE: QuestionCursor | null = null;

// Every question the lab has asked, newest first, with a search over the questions and their
// answers. A question opens on the Search page with its saved answer, as on the Search home.
export function QuestionsView({ viewerId }: { viewerId: UserId | null }) {
  const api = useAskApi();
  const inputId = useId();
  const [text, setText] = useState("");
  const q = useDebounced(text.trim(), SEARCH_DEBOUNCE_MS);
  const pages = useInfiniteQuery({
    queryKey: ["questions", q],
    queryFn: ({ pageParam, signal }) => api.questions({ q: q === "" ? undefined : q, before: pageParam ?? undefined }, signal),
    initialPageParam: FIRST_PAGE,
    getNextPageParam: (last) => last.next,
    placeholderData: keepPreviousData,
  });
  const questions = pages.data?.pages.flatMap((page) => page.questions) ?? [];

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-8 pb-24 sm:px-8 sm:pt-12">
      <h1 className="text-heading-medium sm:text-heading-large">Questions</h1>
      <p className="mt-2 max-w-prose text-paragraph-medium text-content-secondary">
        Everything the lab has asked, newest first. Open one to read its answer again.
      </p>
      <label htmlFor={inputId} className="sr-only">
        Search questions
      </label>
      <Input
        id={inputId}
        type="search"
        autoComplete="off"
        spellCheck={false}
        className="mt-6"
        placeholder="Search questions and answers"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <p className="sr-only" aria-live="polite">
        {pages.data === undefined ? "" : questions.length === 0 ? "No questions" : `${questions.length} questions shown`}
      </p>
      {pages.data === undefined ? (
        pages.isError ? (
          <div className="mt-6">
            <p className="text-paragraph-medium text-content-primary">The questions didn&apos;t load.</p>
            <Button variant="secondary" className="mt-3" onClick={() => void pages.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <QuestionsSkeleton />
        )
      ) : questions.length === 0 ? (
        <p className="mt-6 text-paragraph-medium text-content-tertiary">
          {q === "" ? (
            <>
              No one has asked yet. Type a question on{" "}
              <Link href="/" className="text-content-accent underline-offset-2 hover:underline">
                Search
              </Link>{" "}
              and press Enter.
            </>
          ) : (
            <>No questions match &ldquo;{q}&rdquo;.</>
          )}
        </p>
      ) : (
        <div data-stale={pages.isPlaceholderData} className="transition-opacity duration-200 ease-out data-[stale=true]:opacity-60 data-[stale=true]:delay-300">
          <ul className="-mx-3 mt-4">
            {questions.map((question) => (
              <li key={question.id}>
                <Link href={questionHref(question)} className={questionRow}>
                  <QuestionRowText q={question} viewerId={viewerId} />
                </Link>
              </li>
            ))}
          </ul>
          {pages.hasNextPage ? (
            <Button variant="secondary" className="mt-4" disabled={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
              {pages.isFetchingNextPage ? "Loading older questions" : "Show older questions"}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

function QuestionsSkeleton() {
  return (
    <div className="mt-5 grid gap-3" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <Skeleton key={i} className="h-4 w-3/5" />
      ))}
    </div>
  );
}
