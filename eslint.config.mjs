import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  globalIgnores([
    ".next/**",
    ".open-next/**",
    ".wrangler/**",
    "cloudflare/**/.wrangler/**",
    "coverage/**",
    "output/**",
    "next-env.d.ts",
    "cloudflare-env.d.ts",
    "cloudflare/**/worker-configuration.d.ts",
  ]),
]);
