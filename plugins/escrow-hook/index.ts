import { appendFileSync } from "node:fs";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { decide, logLine, type ToolCallEvent, type ToolCallCtx } from "./decide.ts";

const DEFAULT_LOG = "/tmp/escrow-hook.jsonl";

export default definePluginEntry({
  id: "escrow-hook",
  name: "Escrow Hook",
  description: "Escrow safety layer: logs every tool call and blocks direct side effects.",
  register(api) {
    const cfg = (api.pluginConfig ?? {}) as { logPath?: string };
    const logPath = cfg.logPath ?? DEFAULT_LOG;
    api.logger.info(`escrow-hook: loaded, logging tool calls to ${logPath}`);
    api.on("before_tool_call", (event, ctx) => {
      const ev = event as unknown as ToolCallEvent;
      const d = decide(ev);
      try {
        appendFileSync(logPath, logLine(ev, (ctx ?? {}) as ToolCallCtx, d) + "\n");
      } catch (e) {
        // If we can't log, fail closed
        api.logger.error(`escrow-hook: log write failed (${(e as Error).message}); blocking ${ev.toolName}`);
        return { block: true, blockReason: "Escrow: audit log unavailable" };
      }
      if (d.block) api.logger.warn(`escrow-hook: blocked ${ev.toolName}`);
      return d.block ? { block: true, blockReason: d.blockReason } : undefined;
    }, { priority: 1000 });
  },
});
