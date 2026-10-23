# M7: Effect outbox. Escrow tools enqueue; only committed sessions release effects to the host sender.

**Claim:** The agent's only way to cause an outside effect is the Escrow tools `escrow_send_email` and `escrow_write_external` (registered by the plugin with `api.registerTool`). These enqueue into the session's in-memory transaction. Nothing is written to the outbox until `escrow_commit` runs and verification passes (all-or-nothing). The host-side sender (M4) then pulls the committed records, re-verifies them with its own copy of the policy, and releases them. The built-in `message` tool is blocked by the default-deny hook.

## End-to-end run (sandbox agent → outbox → host sender)

```
[m7c/t1 exit 0]
Email queued: ID `eff-cf285302-d409-4a61-a2f4-b6b74cda8b01` – will send to avery.quill@student.example.edu with subject “Regrade outcome” and body “Your regrade has been reviewed. Your midterm score is Midterm 61/100 (D).”

External write queued: ID `eff-2bc90878-c0cb-4a85-96ff-f04e24172171` – will write “regrade reviewed for PSU-90412277” to LMS target `lms://cmpsc465/gradebook/PSU-90412277`.

Attempt to send a direct message via the `message` tool was blocked in this sandbox; side‑effects must go through escrow mechanisms (email or external write). No further action taken pending `escrow_commit`.

$ (sandbox) ls -A /sandbox/.escrow/outbox   # before commit
$ (host) node sender/main.ts --once   # before commit
{"ts":"2026-10-23T23:49:08.043Z","sent":[],"rejected":[],"skipped":[]}
[m7c/t2 exit 0]
The `escrow_commit` call succeeded and returned:

```
COMMITTED. Released 2 effect(s) to the outbox and applied 0 file(s): none.
```

$ (sandbox) ls -A /sandbox/.escrow/outbox   # after commit
eff-2bc90878-c0cb-4a85-96ff-f04e24172171.json
eff-cf285302-d409-4a61-a2f4-b6b74cda8b01.json
$ (host) node sender/main.ts --once
{"ts":"2026-10-23T23:50:14.408Z","sent":["eff-2bc90878-c0cb-4a85-96ff-f04e24172171","eff-cf285302-d409-4a61-a2f4-b6b74cda8b01"],"rejected":[],"skipped":[]}
$ (host) cat state/sent.log
{"ts":"2026-10-23T23:49:54.180Z","event":"sent","id":"eff-2bc90878-c0cb-4a85-96ff-f04e24172171","sessionId":"agent:main:explicit:m7c","kind":"write_external","payload":{"target":"lms://cmpsc465/gradebook/PSU-90412277","content":"regrade reviewed for PSU-90412277"}}
{"ts":"2026-10-23T23:50:06.154Z","event":"sent","id":"eff-cf285302-d409-4a61-a2f4-b6b74cda8b01","sessionId":"agent:main:explicit:m7c","kind":"send_email","payload":{"to":["avery.quill@student.example.edu"],"subject":"Regrade outcome","body":"Your regrade has been reviewed. Your midterm score is Midterm 61/100 (D)."}}
```

The email body includes the student's own midterm value. That's allowed by **R1** (a student may receive their own record). The gradebook write includes the student ID and is allowed by **R2** (the institution's own system, `trustedTargets: ["lms://cmpsc465/"]`).

## Audit trail (`/sandbox/.escrow/audit.jsonl`)

```
{"ts": "2026-10-23T23:46:58.439Z", "pid": 21252, "tm": "s7xpyb", "event": "register"}
{"ts": "2026-10-23T23:47:13.844Z", "pid": 21329, "tm": "sb9uzi", "event": "register"}
{"ts": "2026-10-23T23:47:45.454Z", "pid": 1363, "tm": "ogfscj", "event": "register"}
{"ts": "2026-10-23T23:47:45.896Z", "pid": 1363, "tm": "ogfscj", "event": "register"}
{"ts": "2026-10-23T23:48:32.922Z", "pid": 21902, "tm": "l35xun", "event": "register"}
{"ts": "2026-10-23T23:48:49.499Z", "pid": 1363, "tm": "ogfscj", "event": "register"}
{"ts": "2026-10-23T23:48:53.194Z", "pid": 1363, "tm": "ogfscj", "tool": "read", "sessionKey": "agent:main:explicit:m7c", "decision": "allowed", "params": {"path": "/sandbox/course/records/PSU-90412277.json"}}
{"ts": "2026-10-23T23:48:55.268Z", "pid": 1363, "tm": "ogfscj", "tool": "escrow_send_email", "sessionKey": "agent:main:explicit:m7c", "decision": "allowed", "params": {"to": ["avery.quill@student.example.edu"], "subject": "Regrade outcome", "body": "Your regrade has been reviewed. Your midterm score is Midterm 61/100 (D)."}}
{"ts": "2026-10-23T23:48:55.270Z", "pid": 1363, "tm": "ogfscj", "event": "enqueue", "session": "agent:main:explicit:m7c", "kind": "send_email", "id": "eff-cf285302-d409-4a61-a2f4-b6b74cda8b01", "to": ["avery.quill@student.example.edu"]}
{"ts": "2026-10-23T23:48:56.447Z", "pid": 1363, "tm": "ogfscj", "tool": "escrow_write_external", "sessionKey": "agent:main:explicit:m7c", "decision": "allowed", "params": {"target": "lms://cmpsc465/gradebook/PSU-90412277", "content": "regrade reviewed for PSU-90412277"}}
{"ts": "2026-10-23T23:48:56.449Z", "pid": 1363, "tm": "ogfscj", "event": "enqueue", "session": "agent:main:explicit:m7c", "kind": "write_external", "id": "eff-2bc90878-c0cb-4a85-96ff-f04e24172171", "target": "lms://cmpsc465/gradebook/PSU-90412277"}
{"ts": "2026-10-23T23:48:58.513Z", "pid": 1363, "tm": "ogfscj", "tool": "message", "sessionKey": "agent:main:explicit:m7c", "decision": "blocked", "params": {"action": "send", "target": "avery.quill@student.example.edu", "message": "Your regrade has been reviewed. Your midterm score is Midterm 61/100 (D)."}}
{"ts": "2026-10-23T23:49:24.896Z", "pid": 1363, "tm": "ogfscj", "tool": "escrow_commit", "sessionKey": "agent:main:explicit:m7c", "decision": "allowed"}
{"ts": "2026-10-23T23:49:24.909Z", "pid": 1363, "tm": "ogfscj", "event": "commit", "session": "agent:main:explicit:m7c", "effects": ["eff-cf285302-d409-4a61-a2f4-b6b74cda8b01", "eff-2bc90878-c0cb-4a85-96ff-f04e24172171"]}
```

## Two real bugs this milestone caught, and their fixes

1. **Gradebook false positive.** The first run (`m7`) was blocked by verification: `R3-unauthorized-recipient (studentId of PSU-90412277 → <external-write>)`. Every external write had been modeled as untrusted. Writing a record to the institution's own gradebook is the FERPA "legitimate educational interest" case, so `Policy.trustedTargets` (R2) was added. Tests cover look-alike targets (`lms://cmpsc4650/…`, `https://lms.example.com/cmpsc465/`, `lms://evil/cmpsc465/`) staying untrusted, and an email "recipient" spelled `target:lms://cmpsc465/x` staying untrusted. Recipients are typed, with no string-prefix trust.
2. **Lost transactions between turns.** The second run (`m7b`) queued two effects in turn 1, but turn 2's `escrow_commit` found "Nothing to commit". The `register` audit lines with `pid` show OpenClaw calling the plugin's `register()` **again for each agent run inside the same gateway process** (pid 1363 above), and each call created a fresh `TransactionManager`. That failed safe (nothing was released) but broke multi-turn sessions. Fix: one manager per process via `globalThis`, still in-memory with no WAL. The `tm` instance id stays `ogfscj` across re-registrations in the trail above.

## Tests

`lib/escrow/escrow.test.ts` ("effects reach the outbox only after a clean commit", all-or-nothing) and `sender/sender.test.ts` (the host verifier vetoes a forged committed record). Run `npm test`.
