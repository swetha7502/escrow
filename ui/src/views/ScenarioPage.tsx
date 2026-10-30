import { motion } from "framer-motion";
import { useState } from "react";
import { MEASURED, PIPELINE, SCENARIO_SPECS, cachedRun, liveCounts, scenarioMeta, upper95, type Category, type ScenarioMeta } from "../lib/data";
import { ruleLabel } from "../lib/runState";
import { useBackend, go } from "../lib/hooks";
import type { Arm } from "../lib/types";

const SECTIONS: { cat: Category; title: string; sub: string }[] = [
  { cat: "contract", title: "Task contract", sub: "Nemotron Ultra scopes the run before it starts; you approve it." },
  { cat: "skill", title: "TA skills", sub: "Real work that must still get through." },
  { cat: "paraphrase", title: "Paraphrase leaks", sub: "No exact tokens — only the Super judge can see them." },
  { cat: "deterministic", title: "Deterministic catches", sub: "Exact match, canaries, fingerprints." },
  { cat: "clean", title: "Clean controls", sub: "Legitimate effects pass." },
  { cat: "generated", title: "Ultra-generated attacks", sub: "Nemotron Ultra wrote the wording; the labels are by construction." },
  { cat: "generated-clean", title: "Ultra-generated clean tasks", sub: "Must get through: this is the false-block rate." },
];

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
    return { text: `DELIVERED · ${o.delivered}`, tone: "" };
  }
  if (o.result.startsWith("BLOCKED")) return { text: o.result.includes("then SENT") ? `BLOCKED → ${meta.retryLabel ?? "safe reply"}` : `BLOCKED · ${TIER_SHORT[o.tier] ?? ruleLabel(o.tier)}`, tone: "safe" };
  return { text: `VERIFIED · ${o.delivered} sent`, tone: "safe" };
}

function Results({ id, meta }: { id: string; meta: ScenarioMeta }) {
  return (
    <div className="results">
      {(["baseline", "escrow"] as Arm[]).map((arm) => {
        const r = recorded(id, arm, meta);
        return <div className="result" key={arm}><div className="arm">{arm}</div><div className={`v ${r.tone}`}>{r.text}</div></div>;
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
    { big: `${l.escrowLeaked}/${l.leakN}`, label: "leaks with Escrow", sub: `live OpenClaw agent · baseline leaked ${l.baselineLeaked}/${l.leakN}`, tone: "safe" },
    { big: `${l.falseBlocks}/${l.cleanN}`, label: "false blocks", sub: "clean live tasks still delivered", tone: "safe" },
    { big: `${PIPELINE.escrowLeaked}/${PIPELINE.leakN}`, label: "leaks · 200-task pipeline", sub: `baseline ${PIPELINE.baselineLeaked}/${PIPELINE.leakN} · false blocks ${PIPELINE.falseBlocks}/${PIPELINE.cleanN}`, tone: "safe" },
    l.escrowLeaked === 0
      ? { big: `≤${Math.round(upper95(l.leakN) * 100)}%`, label: "95% upper bound", sub: `on Escrow's live leak rate from 0/${l.leakN} (small n, said plainly)`, tone: "" }
      : { big: `${l.escrowLeaked}`, label: "live leaks got through", sub: "see FAILURE_MODES.md", tone: "" },
  ];
  return (
    <div className="stats">
      <div className="stats-cap mono">Measured at commit {MEASURED.commit} · {MEASURED.date} · live OpenClaw agent and 200-task pipeline · counts, not percentages</div>
      {tiles.map((t, i) => (
        <motion.div key={t.label} className={`stat ${t.tone}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 + 0.07 * i, duration: 0.45 }}>
          <b>{t.big}</b><span className="l">{t.label}</span><span className="s">{t.sub}</span>
        </motion.div>
      ))}
    </div>
  );
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
          <div className="kicker">Nebius × NVIDIA · Personal AI · NemoClaw TA assistant</div>
          <h1>Every side effect waits <em>behind the wall</em>.</h1>
          <p>
            A real OpenClaw agent runs in a locked-down NemoClaw sandbox whose only network exit is Nemotron inference on Nebius Token Factory.
            Its emails and writes are held in escrow, verified as a whole session at commit — exact match, fingerprints, then a Nemotron Super judge —
            and only verified effects leave, through a host-side sender.
          </p>
        </div>
        <div className="legend">
          <div><span className="swatch" style={{ background: "var(--safe)", boxShadow: "0 0 10px var(--safe)" }} />verified · allowed</div>
          <div><span className="swatch" style={{ background: "var(--blocked)", boxShadow: "0 0 10px var(--blocked)" }} />blocked · leaked record data</div>
          <div><span className="swatch" style={{ background: "rgba(232,238,247,0.7)" }} />unverified · held</div>
          <div className="mono" style={{ fontSize: 11, marginTop: 4 }}>
            {!b.checked ? "Checking backend…"
              : b.online && b.liveReady ? "Runs go LIVE against the sandbox."
              : b.online || b.locked ? "Runs replay recorded live runs (CACHED)."
              : "Cached runs are real recorded outputs from the live pipeline. To run it live, follow the README setup."}
          </div>
        </div>
      </section>

      <Stats />

      <div className="featured">
        {featured.map((m, i) => (
          <motion.div key={m.id} className="card feature" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 * i, duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }}>
            <WallArt />
            <span className="tag killer">Killer scenario {m.id.slice(0, 2)}</span>
            <h3>{m.title}</h3>
            <p>{m.blurb}</p>
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
                  <span className="tag">{m.id.split("-")[0]}{m.tag ? ` · ${m.tag}` : ""}</span>
                  <h3>{m.title}</h3>
                  <p>{m.blurb}</p>
                  <Results id={m.id} meta={m} />
                  <RunButtons id={m.id} />
                </motion.div>
              ))}
            </div>
            {items.length > 3 && !open[sec.cat] && <button className="btn more-sm" onClick={() => setOpen((o) => ({ ...o, [sec.cat]: true }))}>Show all {items.length}</button>}
          </section>
        );
      })}
    </div>
  );
}
