// Host-side sender. `node sender/main.ts --once` drains once. Without --once it polls every POLL_MS.
import { resolve } from "node:path";
import { Sender } from "./sender.ts";
import { SandboxTransport } from "./sandbox-transport.ts";
import { hostVerifier } from "./verify.ts";
import { POLICY } from "../lib/escrow/fixtures/records.ts";

const ROOT = resolve(import.meta.dirname, "..");
const once = process.argv.includes("--once");
const pollMs = Number(process.env.POLL_MS ?? 5000);

// Host-side verification gate: the deterministic canary/exact-match tier, with the host's copy of the policy
const verify = hostVerifier(POLICY);

const sender = new Sender({
  transport: new SandboxTransport(process.env.SANDBOX ?? "escrow"),
  verify,
  sentLog: resolve(ROOT, "state/sent.log"),
  seenPath: resolve(ROOT, "state/sender-seen.json"),
});

do {
  const r = await sender.drainOnce();
  if (r.sent.length || r.rejected.length || once) console.log(JSON.stringify({ ts: new Date().toISOString(), ...r }));
  if (!once) await new Promise((res) => setTimeout(res, pollMs));
} while (!once);
