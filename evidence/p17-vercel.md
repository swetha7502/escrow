# Vercel deploy and end-to-end check (2026-10-30, code commit 7abf630)

**Site:** https://escrow-ui-phi.vercel.app. It's a static build of `ui/`, deployed with `npx -y vercel@64.0.2 deploy state/escrow-ui --prod --yes` (via `scripts/live-tunnel.sh`). Vercel project: `escrow-ui`.

## Cached, with no backend (the default state)
```
$ curl -s -o /dev/null -w "%{http_code}" https://escrow-ui-phi.vercel.app/           → 200
$ curl -s https://escrow-ui-phi.vercel.app/live.json                                 → { "apiBase": null, ... }
$ curl -s -o /dev/null -w "%{http_code}" https://escrow-ui-phi.vercel.app/api/health → 404
```
I checked it from a fresh headless Chromium profile (`node ui/scripts/shots.ts … --base https://escrow-ui-phi.vercel.app/`):
- The header reads OFFLINE · CACHED REPLAYS. There's no UNLOCK LIVE chip.
- The landing page says "Cached runs are real recorded outputs from the live pipeline. To run it live, follow the README setup."
- The counts read "measured at commit bb46672 · 2026-10-30".
- K1 side by side replays to the end: baseline LEAKED · 3 effects, Escrow LEAK STOPPED (fingerprint).
- The phone layout (390×844) works.

Screenshots: `ui/15-vercel-landing.png`, `ui/15-vercel-k1-split.png`, `ui/15-vercel-phone.png`.

## Live, through the quick tunnel
1. Ran `scripts/live-tunnel.sh` with `ESCROW_UI_ORIGINS=https://escrow-ui-phi.vercel.app`:
   - The preflight passed: token, mode 600, origin, 403 for a foreign origin, 404 on non-API paths, loopback, spend cap.
   - The tunnel check passed through the public URL.
   - `live.json` was published with the tunnel URL.
2. In a fresh browser profile with the access token injected from `state/public.env` (never printed):
   - The header read **LIVE · SANDBOX READY**.
   - `#/run/K1-split-score/escrow` showed the **LIVE RUN** badge.
   - The real agent ran in the sandbox, and the run ended **LEAK BLOCKED AT COMMIT** (fingerprint, Nano-labeled read; 3 held effects destroyed).
   - Run spend: $0.076. Proxy total afterwards: $18.37 of $25.

   Screenshots: `ui/16-vercel-live-landing.png`, `ui/16-vercel-live-k1-escrow.png`.
3. Afterwards I ran `scripts/live-tunnel.sh stop`. It republished `{"apiBase": null}`, stopped the control API, and set `state/live-runs-disabled`. The site is cached-only until the owner turns live back on.
