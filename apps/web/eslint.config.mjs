import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "no-console": ["error", { allow: ["error"] }],
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "screenshots/**"]),
]);

export default eslintConfig;
