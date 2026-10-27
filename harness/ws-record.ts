// Record the event stream to a file (one JSON event per line): node harness/ws-record.ts <out.jsonl>
import { appendFileSync } from "node:fs";
const out = process.argv[2] ?? "state/events.jsonl";
const token = process.env.ESCROW_ACCESS_TOKEN;
const ws = new WebSocket(`ws://127.0.0.1:${process.env.ESCROW_API_PORT ?? 8790}/events`, token ? ["escrow", `escrow-token.${token}`] : ["escrow"]);
ws.onmessage = (m) => {
  const ev = JSON.parse(String(m.data)) as { type: string; backlog?: unknown[] };
  if (ev.type === "hello") { console.log(`connected; backlog ${ev.backlog?.length ?? 0}`); return; }
  appendFileSync(out, JSON.stringify(ev) + "\n");
};
ws.onclose = () => { console.log("closed"); process.exit(0); };
