import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Variable that only the host-side proxy may read. Every other caller gets it stripped.
const SECRET_KEYS = new Set(["TF_API_KEY"]);

/** Parse a .env file. Tolerates leading whitespace, CRLF, `export`, and quotes. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\r/g, "").trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/**
 * Load .env merged under process.env (process.env wins).
 * `allowSecrets` is set only by proxy/. Everything else must call the proxy instead.
 */
export function loadEnv(opts: { path?: string; allowSecrets?: boolean } = {}): Record<string, string> {
  const path = opts.path ?? resolve(import.meta.dirname, "..", ".env");
  let file: Record<string, string> = {};
  try {
    file = parseDotenv(readFileSync(path, "utf8"));
  } catch {
    // missing .env is fine; callers validate what they need
  }
  const env: Record<string, string> = { ...file };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  if (!opts.allowSecrets) for (const k of SECRET_KEYS) delete env[k];
  return env;
}
