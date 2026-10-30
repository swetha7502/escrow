import { motion } from "framer-motion";
import { useState } from "react";
import { PIPELINE, SCENARIO_SPECS, cachedRun, liveCounts, scenarioMeta, upper95, type Category, type ScenarioMeta } from "../lib/data";
import { ruleLabel } from "../lib/runState";
import { COURSE, POLICY_MEMORY, SKILLS } from "../lib/assistant";
import { useBackend, go } from "../lib/hooks";
import type { Arm } from "../lib/types";

const SECTIONS: { cat: Category; title: string; sub: string }[] = [
  { cat: "skill", title: "Student requests", sub: "Handled by the regrade and extension skills." },
  { cat: "contract", title: "Requests with an extra errand", sub: "Stopped by the task contract you approved." },
  { cat: "clean", title: "Routine requests", sub: "Released." },
  { cat: "deterministic", title: "Requests that tried to send records", sub: "Blocked by exact match and fingerprints." },
  { cat: "paraphrase", title: "Requests that leaked in other words", sub: "Blocked by the judge." },
  { cat: "generated", title: "More requests that turned out to be attacks", sub: "Written by Ultra." },
  { cat: "generated-clean", title: "More routine requests", sub: "Must be released." },
];

/** How the request turned out with Escrow, from the recorded run */
function status(id: string): { text: string; tone: "safe" | "leak" | "" } {
  const o = cachedRun(id, "escrow")?.outcome;
  if (!o) return { text: "", tone: "" };
  if (o.result.startsWith("BLOCKED")) return o.result.includes("then SENT") ? { text: "Blocked, safe reply released", tone: "leak" } : { text: "Blocked", tone: "leak" };
  return { text: "Released", tone: "safe" };
}
const ATTACK: Category[] = ["killer", "deterministic", "paraphrase", "generated"];
const kindOf = (m: ScenarioMeta) => (m.category === "contract" ? "Request + extra errand" : ATTACK.includes(m.category) ? "Turned out to be an attack" : "Request");

/** One short line per card: the first sentence of the blurb */
const oneLine = (t: string) => t.split(/(?<=[.:;—])\s/)[0].replace(/\s*[:;—]$/, ".");

const TIER_SHORT: Record<string, string> = { "R5-super-judge": "Super judge", "R4-fingerprint": "fingerprint", "R0-canary": "canary", "R3-unauthorized-recipient": "exact match", "C1-contract": "contract" };

/** The recorded verdict for one arm, from the bundled live run */
function recorded(id: string, arm: Arm, meta: ScenarioMeta): { text: string; tone: "leak" | "safe" | "" } {
  const r = cachedRun(id, arm);
  if (!r) return { text: "—", tone: "" };
  const o = r.outcome;
  if (arm === "baseline") {
    if (o.leaked) return { text: `LEAKED · ${o.delivered} sent`, tone: "leak" };
    if (o.result.startsWith("blocked all")) return { text: `BLOCKED · ${TIER_SHORT[o.tier] ?? o.tier}`, tone: "safe" };
    if (o.tier === "C1-contract") return { text: `PARTIAL · contract`, tone: "safe" };
    return { text: `SENT · ${o.delivered}`, tone: "" };
  }
  if (o.result.startsWith("BLOCKED")) return { text: o.result.includes("then SENT") ? `BLOCKED → ${meta.retryLabel ?? "safe reply"}` : `BLOCKED · ${TIER_SHORT[o.tier] ?? ruleLabel(o.tier)}`, tone: "safe" };
  return { text: `RELEASED · ${o.delivered} sent`, tone: "safe" };
}

function Results({ id, meta }: { id: string; meta: ScenarioMeta }) {
  return (
    <div className="results">
      {(["baseline", "escrow"] as Arm[]).map((arm) => {
        const r = recorded(id, arm, meta);
        return <div className="result" key={arm}><div className="arm">{arm === "escrow" ? "with Escrow" : "without Escrow"}</div><div className={`v ${r.tone}`}>{r.text}</div></div>;
      })}
    </div>
  );
}

function RunButtons({ id, big }: { id: string; big?: boolean }) {
  return (
    <div className="actions">
      <button className={`btn baseline ${big ? "big" : ""}`} onClick={() => go(`/run/${id}/baseline`)}>Baseline</button>
      <button className={`btn escrow ${big ? "big" : ""}`} onClick={() => go(`/run/${id}/escrow`)}>Escrow</button>
      <button className={`btn ghost ${big ? "big" : ""}`} onClick={() => go(`/split/${id}`)}>Side by side ⇆</button>
    </div>
  );
}

/** Small animated motif for the featured cards: packets meet the wall; red ones shatter, teal ones pass. */
function WallArt() {
  return (
    <svg className="feature-art" viewBox="0 0 220 120" aria-hidden>
      <defs>
        <filter id="glow"><feGaussianBlur stdDeviation="2.4" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
      </defs>
      {[30, 60, 90].map((y) => <line key={y} x1="0" x2="220" y1={y} y2={y} stroke="rgba(150,175,210,0.12)" strokeDasharray="2 6" />)}
      <rect x="128" y="8" width="7" height="104" rx="3" fill="var(--safe)" opacity="0.85" filter="url(#glow)" />
      {[0, 1, 2].map((i) => (
        <circle key={`r${i}`} r="4" fill="var(--blocked)" filter="url(#glow)">
          <animate attributeName="cx" values="-10;122;122" keyTimes="0;0.8;1" dur="2.6s" begin={`${i * 0.85}s`} repeatCount="indefinite" />
          <animate attributeName="cy" values={`${30 + i * 30};${30 + i * 30};${30 + i * 30}`} dur="2.6s" repeatCount="indefinite" />
          <animate attributeName="r" values="4;4;11" keyTimes="0;0.8;1" dur="2.6s" begin={`${i * 0.85}s`} repeatCount="indefinite" />
          <animate attributeName="opacity" values="1;1;0" keyTimes="0;0.8;1" dur="2.6s" begin={`${i * 0.85}s`} repeatCount="indefinite" />
        </circle>
      ))}
      <circle r="3.5" fill="var(--safe)" filter="url(#glow)" cy="60">
        <animate attributeName="cx" values="-10;230" dur="3.4s" begin="0.4s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}

/** The headline numbers, as counts (the live ones computed from the bundled transcripts) */
function Stats() {
  const l = liveCounts();
  const tiles = [
    { big: `${l.escrowLeaked}/${l.leakN}`, label: "leaks with Escrow", sub: `baseline leaked ${l.baselineLeaked}/${l.leakN}`, tone: "safe" },
    { big: `${PIPELINE.falseBlocks}/${PIPELINE.cleanN}`, label: "false blocks", sub: "clean tasks still delivered", tone: "safe" },
    l.escrowLeaked === 0
      ? { big: `≤${Math.round(upper95(l.leakN) * 100)}%`, label: "95% upper bound", sub: `true leak rate, from 0/${l.leakN}`, tone: "" }
      : { big: `${l.escrowLeaked}`, label: "live leaks got through", sub: "see FAILURE_MODES.md", tone: "" },
  ];
  return (
    <div className="stats three">
      {tiles.map((t, i) => (
        <motion.div key={t.label} className={`stat ${t.tone}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 + 0.07 * i, duration: 0.45 }}>
          <b>{t.big}</b><span className="l">{t.label}</span><span className="s">{t.sub}</span>
        </motion.div>
      ))}
    </div>
  );
}

function StatusPill({ id }: { id: string }) {
  const st = status(id);
  return st.text ? <span className={`status-pill ${st.tone}`}>{st.text}</span> : null;
}

export function ScenarioPage() {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const b = useBackend();
  const all = SCENARIO_SPECS.map((s) => scenarioMeta(s.id));
  const featured = all.filter((m) => m.featured);
  return (
    <div className="landing">
      <section className="hero">
        <div>
          <div className="kicker">Personal AI</div>
          <h1>Your private <em>TA assistant</em>.</h1>
          <p>It remembers course policy, handles regrade and extension requests, and nothing leaves until the whole session is verified.</p>
        </div>
      </section>

      <div className="part-h"><h2>Today's requests</h2><span>Recorded runs of the assistant. Open one to watch it work.</span></div>
      <div className="featured">
        {featured.map((m, i) => (
          <motion.div key={m.id} className="card feature" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 * i, duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }}>
            <WallArt />
            <div className="req-top"><span className="tag killer">{kindOf(m)}</span><StatusPill id={m.id} /></div>
            <h3>{m.title}</h3>
            <p className="one-line">{oneLine(m.blurb)}</p>
            <Results id={m.id} meta={m} />
            <RunButtons id={m.id} big />
          </motion.div>
        ))}
      </div>

      {SECTIONS.map((sec) => {
        const items = all.filter((m) => m.category === sec.cat);
        if (!items.length) return null;
        return (
          <section key={sec.cat}>
            <div className="section-h"><h2>{sec.title}</h2><span>{sec.sub}</span></div>
            <div className={`grid ${open[sec.cat] ? "" : "collapsed"}`}>
              {items.map((m, i) => (
                <motion.div key={m.id} className="card small" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.03 * i, duration: 0.4 }}>
                  <div className="req-top"><span className="tag">{kindOf(m)}{m.tag ? ` · ${m.tag}` : ""}</span><StatusPill id={m.id} /></div>
                  <h3>{m.title}</h3>
                  <p className="one-line">{oneLine(m.blurb)}</p>
                  <Results id={m.id} meta={m} />
                  <RunButtons id={m.id} />
                </motion.div>
              ))}
            </div>
            {items.length > 3 && !open[sec.cat] && <button className="btn more-sm" onClick={() => setOpen((o) => ({ ...o, [sec.cat]: true }))}>Show all {items.length}</button>}
          </section>
        );
      })}

      <div className="part-h"><h2>What it knows, what it can do</h2><span>{COURSE}</span></div>
      <div className="knows">
        <div className="card panel">
          <div className="kicker">Course policy memory</div>
          {POLICY_MEMORY.map((p) => (
            <div key={p.topic} className="mem"><h4>{p.topic}</h4><ul>{p.lines.map((l) => <li key={l}>{l}</li>)}</ul></div>
          ))}
        </div>
        <div className="card panel">
          <div className="kicker">Skills</div>
          {SKILLS.map((k) => <div key={k.name} className="skill"><b className="mono">{k.name}</b><span>{k.description}</span></div>)}
          <div className="kicker" style={{ marginTop: 18 }}>Every request</div>
          <ol className="flow-steps">
            <li>The assistant proposes a task contract; you approve it.</li>
            <li>It works in a locked sandbox. Emails and writes are held.</li>
            <li>The whole session is verified, then released or blocked.</li>
          </ol>
        </div>
      </div>

      <div className="part-h"><h2>How it stays private</h2><span>Counts from recorded runs.</span></div>
      <Stats />
      <div className="foot-note mono">
        {b.checked && b.online && b.liveReady ? "Runs go live against the sandbox." : "Cached runs are real recorded outputs from the live pipeline."}
      </div>
    </div>
  );
}
