"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { useState, type ReactNode } from "react";
import { Toaster } from "sonner";
import { AlertIcon, CheckIcon } from "./icons/base-web";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 } } }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <MotionConfig reducedMotion="user" transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}>
        {children}
      </MotionConfig>
      <Toaster
        position="bottom-center"
        icons={{ success: <CheckIcon />, error: <AlertIcon /> }}
        toastOptions={{
          unstyled: true,
          classNames: {
            toast:
              "flex w-full min-w-[min(320px,calc(100vw-32px))] max-w-[540px] items-center gap-3 rounded-xl bg-background-inverse-secondary px-4 py-3.5 font-sans text-paragraph-medium text-content-inverse-primary shadow-deep-below",
            icon: "shrink-0",
            content: "min-w-0 flex-1",
            actionButton:
              "-my-2 -mr-2 min-h-11 shrink-0 cursor-pointer rounded-lg px-3 text-label-medium text-content-inverse-primary underline underline-offset-4 hover:no-underline",
          },
        }}
      />
    </QueryClientProvider>
  );
}
