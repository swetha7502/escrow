// One Escrow model call through the spend proxy (lib/tf-client). Prints the outcome as JSON.
import { chat, CachedModeError } from "../lib/tf-client.ts";

const model = process.argv[2] ?? "nano";
try {
  const r = await chat({ model, runId: "spend-cap-proof", maxTokens: 200, messages: [{ role: "user", content: "Reply with exactly: escrow-call-ok" }] });
  console.log(JSON.stringify({ outcome: "live", content: r.content.trim(), usage: r.usage }));
} catch (e) {
  if (e instanceof CachedModeError) {
    console.log(JSON.stringify({ outcome: "cached_mode", http: e.status, reasonCode: e.reasonCode, message: e.message }));
    process.exit(3);
  }
  throw e;
}
