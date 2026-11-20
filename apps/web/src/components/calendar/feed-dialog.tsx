"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDock, DialogTrigger } from "../ui/dialog";
import { inputVariants } from "../ui/field";
import { When } from "../ui/when";
import { useCalendarApi } from "./calendar-api";

const STEPS = [
  ["Google Calendar", "beside Other calendars, choose +, then From URL, and paste it."],
  ["Apple Calendar", "choose File, then New Calendar Subscription, and paste it."],
  ["Outlook", "choose Add calendar, then Subscribe from web, and paste it."],
] as const;

// "Add to my calendar": a private address for Google Calendar, Apple Calendar or Outlook, so
// the lab's plans show there. Binary keeps only a fingerprint of it, so it's shown once, when
// it's made; making a new one stops the old one.
export function FeedButton() {
  const api = useCalendarApi();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const status = useQuery({ queryKey: ["calendar", "feed"], queryFn: ({ signal }) => api.feedStatus(signal), enabled: open });
  const reset = useMutation({
    mutationFn: () => api.resetFeed(),
    onSuccess: (made) => {
      setUrl(made.url);
      queryClient.setQueryData(["calendar", "feed"], { madeAt: made.madeAt });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "We couldn't make an address. Try again."),
  });
  const madeAt = status.data?.madeAt ?? null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setUrl(null);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="tertiary" size="compact" className="text-content-secondary hover:text-content-primary">
          Add to my calendar
        </Button>
      </DialogTrigger>
      <DialogContent title="See the lab's plans in your own calendar" className="sm:w-[min(520px,calc(100vw-80px))]">
        <div className="flex flex-col gap-4 px-4 pt-2 text-paragraph-medium text-content-secondary sm:px-6">
          <p>
            Binary makes you a private address. Add it to Google Calendar, Apple Calendar or Outlook and the lab&apos;s plans show there, with your
            reminders. Changes reach them within a few hours (Google can take a day). You still make and change plans here.
          </p>
          {url !== null ? (
            <>
              <div className="flex gap-2">
                <input
                  readOnly
                  aria-label="Your calendar address"
                  value={url}
                  onFocus={(e) => e.currentTarget.select()}
                  className={inputVariants({ size: "compact" })}
                />
                <Button
                  size="compact"
                  onClick={() =>
                    void navigator.clipboard.writeText(url).then(
                      () => toast("Copied the address"),
                      () => toast.error("Select the address and copy it yourself."),
                    )
                  }
                >
                  Copy
                </Button>
              </div>
              <ul className="flex flex-col gap-1.5 text-paragraph-small">
                {STEPS.map(([app, how]) => (
                  <li key={app}>
                    <span className="text-content-primary">{app}:</span> {how}
                  </li>
                ))}
                <li>
                  On a Mac or iPhone you can also{" "}
                  <a className="text-content-primary underline underline-offset-2" href={url.replace(/^https?:/, "webcal:")}>
                    open it in Apple Calendar
                  </a>
                  .
                </li>
              </ul>
              <p className="text-paragraph-small">Keep it to yourself: anyone with it can see the lab&apos;s plans. Binary shows it only now.</p>
            </>
          ) : madeAt !== null ? (
            <p>
              You made your address <When iso={madeAt} />. Binary doesn&apos;t keep a copy to show again. If you lost it, or someone else has it,
              make a new one; the old one stops working.
            </p>
          ) : null}
        </div>
        <DialogDock className="pt-5">
          {url !== null ? (
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Done
            </Button>
          ) : (
            <Button disabled={status.isPending || reset.isPending} onClick={() => reset.mutate()}>
              {madeAt === null ? "Make my address" : "Make a new address"}
            </Button>
          )}
        </DialogDock>
      </DialogContent>
    </Dialog>
  );
}
