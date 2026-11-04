import type { NextConfig } from "next";

// `*.dev.tsx` pages (fixtures for screenshots) only exist under `next dev`,
// so production builds never route to or bundle them.
const isDev = process.env.NODE_ENV === "development";

const nextConfig: NextConfig = {
  pageExtensions: isDev ? ["dev.tsx", "tsx", "ts"] : ["tsx", "ts"],
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
