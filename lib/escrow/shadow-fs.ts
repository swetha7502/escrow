// App-level shadow filesystem. Writes inside the workspace land in a per-transaction
// shadow dir and reach the real path only on commit.
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync, copyFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep, isAbsolute } from "node:path";

export class PathEscapeError extends Error {}

export class ShadowFS {
  readonly root: string;
  readonly shadowDir: string;
  private pending = new Map<string, string>(); // rel path → shadow file

  constructor(root: string, shadowDir: string) {
    this.root = resolve(root);
    this.shadowDir = resolve(shadowDir);
    mkdirSync(this.shadowDir, { recursive: true });
  }

  /** Resolve to a workspace-relative path, rejecting anything that escapes the root. */
  rel(p: string): string {
    const abs = isAbsolute(p) ? resolve(p) : resolve(this.root, p);
    const r = relative(this.root, abs);
    if (r === "" || r.startsWith("..") || isAbsolute(r) || r.split(sep).includes("..")) {
      throw new PathEscapeError(`path escapes workspace: ${p}`);
    }
    return r;
  }

  write(p: string, content: string | Buffer): string {
    const r = this.rel(p);
    const s = join(this.shadowDir, r);
    mkdirSync(dirname(s), { recursive: true });
    writeFileSync(s, content);
    this.pending.set(r, s);
    return r;
  }

  /**
   * Hook mode: the tool does the write, at a path we redirect into the shadow dir.
   * Returns the shadow path for `p`. With `copyOnWrite`, the real file is copied in first
   * so edits apply to its current content.
   */
  redirect(p: string, opts: { copyOnWrite?: boolean } = {}): string {
    const r = this.rel(p);
    const s = join(this.shadowDir, r);
    if (!this.pending.has(r)) {
      mkdirSync(dirname(s), { recursive: true });
      const real = join(this.root, r);
      if (opts.copyOnWrite && existsSync(real)) copyFileSync(real, s);
      this.pending.set(r, s);
    }
    return s;
  }

  /** Shadow path if this session has written `p`, otherwise null. Used to redirect reads. */
  shadowed(p: string): string | null {
    try {
      return this.pending.get(this.rel(p)) ?? null;
    } catch {
      return null;
    }
  }

  /** Read through the shadow: the session sees its own uncommitted writes. */
  read(p: string): Buffer {
    const r = this.rel(p);
    const s = this.pending.get(r);
    return readFileSync(s ?? join(this.root, r));
  }

  exists(p: string): boolean {
    const r = this.rel(p);
    return this.pending.has(r) || existsSync(join(this.root, r));
  }

  pendingWrites(): { path: string; content: Buffer }[] {
    return [...this.pending].filter(([, s]) => existsSync(s)).map(([r, s]) => ({ path: r, content: readFileSync(s) }));
  }

  /** Copy shadow files to their real paths. Each file is staged next to its target, then renamed. */
  commit(): string[] {
    const done: string[] = [];
    for (const [r, s] of this.pending) {
      if (!existsSync(s)) continue; // redirected but the tool never wrote
      const target = join(this.root, r);
      mkdirSync(dirname(target), { recursive: true });
      const tmp = `${target}.escrow-tmp`;
      copyFileSync(s, tmp);
      renameSync(tmp, target);
      done.push(r);
    }
    this.discard();
    return done;
  }

  discard(): void {
    this.pending.clear();
    rmSync(this.shadowDir, { recursive: true, force: true });
  }
}
