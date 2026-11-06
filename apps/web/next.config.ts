import type { NextConfig } from "next";
import { assertProductionEnv } from "./src/env";

// A production deploy with a missing or malformed variable fails at build, every problem
// listed at once, before anything goes live. src/instrumentation.ts checks again at startup.
assertProductionEnv();

// `*.dev.tsx` pages (fixtures for screenshots) only exist under `next dev`,
// so production builds never route to or bundle them.
const isDev = process.env.NODE_ENV === "development";

const nextConfig: NextConfig = {
  devIndicators: false,
  pageExtensions: isDev ? ["dev.tsx", "tsx", "ts"] : ["tsx", "ts"],
  // Browsers still ask for /favicon.ico before reading the page's icon link.
  redirects: async () => [{ source: "/favicon.ico", destination: "/icon.svg", permanent: true }],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
