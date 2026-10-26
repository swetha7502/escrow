// Outbox transport that pulls from inside the sandbox over the OpenShell exec channel.
// The sender opens no port, and the sandbox gets no network route to the host.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OutboxTransport } from "./sender.ts";

const run = promisify(execFile);
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export const SANDBOX_OUTBOX = "/sandbox/.escrow/outbox";

export class SandboxTransport implements OutboxTransport {
  private sandbox: string;
  private dir: string;

  constructor(sandbox = "escrow", dir = SANDBOX_OUTBOX) {
    this.sandbox = sandbox;
    this.dir = dir;
  }

  private async exec(args: string[]): Promise<string> {
    // execFile with an argv array, so nothing passes through a host shell. OpenShell's exec directly:
    // `nemoclaw exec` takes a global host lock and would wait out any running agent turn.
    const p = run("openshell", ["sandbox", "exec", "-n", this.sandbox, "--no-tty", "--timeout", "60", "--", ...args], { maxBuffer: 16 * 1024 * 1024, timeout: 90_000 });
    p.child.stdin?.end(); // openshell forwards stdin; an open pipe hangs the command
    const { stdout } = await p;
    return stdout;
  }

  async list(): Promise<string[]> {
    // No outbox dir yet just means nothing was ever committed
    const out = await this.exec(["sh", "-c", '[ ! -d "$1" ] || find "$1" -maxdepth 1 -name "*.json" -type f', "list", this.dir]);
    return out.split("\n").map((l) => l.trim()).filter((l) => l.startsWith(this.dir + "/") && l.endsWith(".json"))
      .map((l) => l.slice(this.dir.length + 1, -".json".length)).filter((id) => ID_RE.test(id)).sort();
  }

  async read(id: string): Promise<string> {
    if (!ID_RE.test(id)) throw new Error(`bad id ${id}`);
    return this.exec(["cat", `${this.dir}/${id}.json`]);
  }

  async ack(id: string): Promise<void> {
    if (!ID_RE.test(id)) throw new Error(`bad id ${id}`);
    await this.exec(["sh", "-c", 'mkdir -p "$1/drained" && mv "$1/$2.json" "$1/drained/$2.json"', "ack", this.dir, id]);
  }
}
