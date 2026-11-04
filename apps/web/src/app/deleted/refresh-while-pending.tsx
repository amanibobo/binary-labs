"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const POLL_MS = 3000;

// Reloads the server page until the worker stamps the deletion done.
export function RefreshWhilePending() {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [router]);
  return null;
}
