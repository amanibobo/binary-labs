import Link from "next/link";
import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";
import { dataSurface } from "@/components/ui/data-table";
import { cn } from "@/lib/cn";
import { UPLOADER_EXE, type UploaderDownload } from "@/lib/uploader-download";
import { Command } from "./instruments-section";
import { settingsHref } from "./sections";

const FOLDER = "C:\\Program Files\\Binary";
const EXE = `"${FOLDER}\\${UPLOADER_EXE}"`;

function Step({ children }: { children: ReactNode }) {
  return <li className="pl-1">{children}</li>;
}

// The Windows uploader: what it is, who sets it up, and the steps, in the order they're done.
export function UploaderDownloadSection({ download, server, isAdmin }: { download: UploaderDownload; server: string; isAdmin: boolean }) {
  return (
    <>
      <Link href={settingsHref("instruments")} className="-mt-4 text-label-medium text-content-tertiary transition-colors duration-150 ease-out hover:text-content-primary">
        Back to instruments
      </Link>
      <section aria-labelledby="uploader-title" className={cn(dataSurface, "p-5 sm:p-6")}>
        <h2 id="uploader-title" className="text-heading-xsmall text-content-primary">
          Instrument uploader for Windows
        </h2>
        <p className="mt-2 max-w-prose text-paragraph-medium text-content-secondary">
          A small program for the PC beside an instrument. It watches the folder the instrument saves to and sends each new file here, where it
          shows up under Browse in Instruments. It only reads those files; it never moves, changes or deletes them.
        </p>
        <p className="mt-3 max-w-prose text-paragraph-medium text-content-secondary">
          An admin of the lab sets it up, at the instrument PC, signed in to the Windows account that stays logged in while the instrument is used.
          It needs Windows 10 or later, and it&apos;s one file to copy, with nothing to install.
        </p>
        <div className="mt-5">
          {download.kind === "available" ? (
            <a href={download.url} className={buttonVariants({ variant: "primary" })}>
              Download {UPLOADER_EXE}
            </a>
          ) : (
            <p role="status" className="rounded-control border border-border-opaque bg-background-secondary px-4 py-3 text-paragraph-small text-content-secondary">
              The download isn&apos;t available here yet. Ask the person who set up Binary for your lab for {UPLOADER_EXE}; the steps below are the same.
            </p>
          )}
        </div>
      </section>

      <section aria-labelledby="uploader-steps">
        <h2 id="uploader-steps" className="text-label-large text-content-primary">
          Set it up
        </h2>
        <p className="mt-0.5 text-paragraph-small text-content-tertiary">About ten minutes. Do every step at the instrument PC, as the same Windows user.</p>
        <ol className="mt-4 grid list-decimal gap-5 pl-5 text-paragraph-medium text-content-secondary marker:text-content-tertiary">
          <Step>
            Make a folder <span className="font-mono text-paragraph-small text-content-primary">{FOLDER}</span> and put {UPLOADER_EXE} in it.
          </Step>
          <Step>
            {isAdmin ? (
              <>
                In <Link href={settingsHref("instruments")} className="text-content-accent underline underline-offset-2">Settings, Instruments</Link>, add the instrument with a name people will know, like
                &ldquo;Plate reader, room 214&rdquo;. You get a pairing code that works once, for 15 minutes.
              </>
            ) : (
              <>Ask an admin to add the instrument in Settings, Instruments. They get a pairing code that works once, for 15 minutes.</>
            )}
          </Step>
          <Step>
            Open Command Prompt and pair the PC, with the code in place of the example:
            <Command text={`${EXE} pair ${server} K7QM-4XPA`} />
          </Step>
          <Step>
            Tell it the folder the instrument saves files to. Folders inside it are sent too.
            <Command text={`${EXE} add-folder "D:\\Instrument data"`} />
          </Step>
          <Step>
            Check that it&apos;s paired and watching the folder:
            <Command text={`${EXE} status`} />
          </Step>
          <Step>
            Have it start each time you log on to Windows:
            <Command text={`schtasks /Create /TN "Binary uploader" /TR "\\"${FOLDER}\\${UPLOADER_EXE}\\" run" /SC ONLOGON /RL LIMITED /F`} />
            <span className="mt-2 block">
              Then open Task Scheduler, open Binary uploader, and on the Settings tab clear &ldquo;Stop the task if it runs longer than&rdquo;. Windows
              otherwise stops it after 3 days.
            </span>
          </Step>
          <Step>
            Start it now:
            <Command text={`schtasks /Run /TN "Binary uploader"`} />
            <span className="mt-2 block">A window opens with the uploader in it. Minimize it; closing it stops the uploads until you log on again.</span>
          </Step>
        </ol>
        <p className="mt-6 max-w-prose text-paragraph-small text-content-tertiary">
          Once it&apos;s running, Settings, Instruments shows when it last checked in and how many files it sent. A file is sent once it has been
          still for 10 seconds; temporary and hidden files, and files over 500 MB, are skipped.
        </p>
      </section>
    </>
  );
}
