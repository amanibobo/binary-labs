import { Dish } from "./dish";

const PILOT_MAILTO = "mailto:hello@binarylabs.example?subject=Pilot%20request";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

export default function Home() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between px-4 pt-5 text-[15px] sm:px-8 sm:pt-7">
        <p className="font-medium">Binary Labs</p>
        <a href={APP_URL} className="underline-offset-4 hover:underline focus-visible:underline">
          Sign in
        </a>
      </header>

      <main className="mx-auto w-full max-w-[640px] px-4 pt-[12vh] text-[20px] leading-[1.3] tracking-[-0.012em] sm:text-[22px]">
        <p>
          Every lab has run the experiment before. The data is somewhere in a Dropbox folder, named{" "}
          <span className="font-mono text-[0.86em] tracking-normal">IMG_4821.jpg</span>, saved by
          someone who graduated two years ago.
        </p>
        <p className="mt-[1.3em]">
          Binary Labs remembers everything your lab has done. It reads the files you already have,
          finds any of them by what is in them, and never moves a thing.
        </p>
        <p className="mt-[1.3em]">
          <a
            href={PILOT_MAILTO}
            className="underline decoration-1 underline-offset-[0.2em] hover:decoration-2 focus-visible:decoration-2"
          >
            Request a pilot
          </a>
        </p>
      </main>

      <figure className="float mx-auto mt-[14vh] w-[min(380px,82vw)] pb-20">
        <Dish />
      </figure>
    </div>
  );
}
