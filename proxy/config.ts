import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv } from "../lib/env.ts";
import { loadPricesFromMarkdown } from "../lib/spend-guard/index.ts";

export const ROOT = resolve(import.meta.dirname, "..");

export function proxySettings() {
  const env = loadEnv({ allowSecrets: true });
  return {
    env,
    statePath: resolve(ROOT, env.SPEND_STATE ?? "state/spend.json"),
    logPath: resolve(ROOT, env.PROXY_LOG ?? "state/proxy.log"),
    prices: loadPricesFromMarkdown(readFileSync(resolve(ROOT, "docs/models.md"), "utf8")),
  };
}
