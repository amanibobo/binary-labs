"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { useState, type ReactNode } from "react";
import { Toaster } from "sonner";

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
        toastOptions={{
          className: "!rounded-[10px] !border !border-hairline !bg-surface !text-ink !shadow-none !font-sans",
        }}
      />
    </QueryClientProvider>
  );
}
