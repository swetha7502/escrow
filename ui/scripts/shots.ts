// Screenshot UI views into evidence/ui/ with headless Chromium (Playwright).
//   node ui/scripts/shots.ts <name> <hash-path> [--w 1920] [--h 1080] [--wait 2000] [--until "<text>"] [--click "<selector>"]...
//      [--base http://127.0.0.1:4173/] [--full]
// Chromium's NSS/ALSA libraries are taken from ~/.cache/escrow-chromium-libs when the host lacks them (no sudo).
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const [name, path] = args;
if (!name || path === undefined) { console.error("usage: shots.ts <name> <hash-path> [opts]"); process.exit(2); }
const opt = (k: string, d: string) => { const i = args.indexOf(k); return i > 0 ? args[i + 1] : d; };
const all = (k: string) => args.flatMap((a, i) => (a === k ? [args[i + 1]] : []));

const libs = resolve(homedir(), ".cache/escrow-chromium-libs/root/usr/lib/x86_64-linux-gnu");
if (existsSync(libs)) process.env.LD_LIBRARY_PATH = `${libs}:${process.env.LD_LIBRARY_PATH ?? ""}`;
const out = resolve(import.meta.dirname, "../../evidence/ui");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(opt("--w", "1920")), height: Number(opt("--h", "1080")) }, deviceScaleFactor: Number(opt("--dpr", "1")) });
page.on("console", (m) => { if (m.type() === "error") console.error("[console]", m.text()); });
page.on("pageerror", (e) => console.error("[pageerror]", e.message));
await page.goto(`${opt("--base", "http://127.0.0.1:4173/")}#${path}`, { waitUntil: "networkidle" });
for (const step of all("--step")) {
  // step = "click:<selector>" | "wait:<ms>" | "until:<text>"
  const [kind, ...rest] = step.split(":"); const arg = rest.join(":");
  if (kind === "click") await page.click(arg);
  if (kind === "wait") await page.waitForTimeout(Number(arg));
  if (kind === "until") await page.getByText(arg, { exact: false }).first().waitFor({ timeout: 180000 });
}
const until = opt("--until", "");
if (until) await page.getByText(until, { exact: false }).first().waitFor({ timeout: 180000 });
await page.waitForTimeout(Number(opt("--wait", "1500")));
const file = resolve(out, `${name}.png`);
await page.screenshot({ path: file, fullPage: args.includes("--full") });
console.log(file);
await browser.close();
