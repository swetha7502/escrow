# Runs INSIDE the sandbox (python3 -). Shows or clears OpenClaw's provider failure/backoff state.
# Location: /sandbox/.openclaw/agents/*/agent/openclaw-agent.sqlite → auth_profile_state.state_json.usageStats.
# The running gateway caches this in memory: after a reset that cleared something, restart the gateway.
# "reset" clears the fields openclaw's resetAuthProfileFailureState() clears, for inline-api-key:* entries only.
import glob, json, sqlite3, sys, time
mode = sys.argv[1] if len(sys.argv) > 1 else "show"
FAIL = ["errorCount", "blockedUntil", "blockedReason", "blockedSource", "blockedModel", "blockedScope", "cooldownUntil",
        "cooldownReason", "cooldownClassification", "cooldownModel", "disabledUntil", "disabledReason", "failureCounts"]
now = int(time.time() * 1000)
had = False
for db in sorted(glob.glob("/sandbox/.openclaw/agents/*/agent/openclaw-agent.sqlite")):
    c = sqlite3.connect(db, timeout=10)
    with c:
        for key, sj in c.execute("select state_key, state_json from auth_profile_state").fetchall():
            st = json.loads(sj); us = st.get("usageStats", {})
            for k, v in us.items():
                if not k.startswith("inline-api-key:"): continue
                until = max([v.get(f) or 0 for f in ("disabledUntil", "cooldownUntil", "blockedUntil")])
                print(json.dumps({"db": db.split("/sandbox/.openclaw/")[1], "entry": k, "reason": v.get("disabledReason") or v.get("cooldownReason"),
                                  "errorCount": v.get("errorCount"), "unusableForSec": max(0, round((until - now) / 1000))}))
                if mode == "reset":
                    had = had or any(v.get(f) for f in FAIL)
                    for f in FAIL: v.pop(f, None)
            if mode == "reset":
                c.execute("update auth_profile_state set state_json=? where state_key=?", (json.dumps(st), key))
    if mode == "reset": print(json.dumps({"db": db.split("/sandbox/.openclaw/")[1], "reset": True, "hadFailure": had}))
