# Escrow UI

Control-room UI for the Escrow demo: React + Vite, React Flow, a canvas particle layer, and Framer Motion. It reads the pipeline's WebSocket event stream and calls the runner API (`harness/server.ts`).

```bash
cd ui && npm install
npm run build              # bundles evidence/runs/*.json as the offline fallback, typechecks, builds dist/
npx vite preview           # http://127.0.0.1:4173 — /api and /events are proxied to 127.0.0.1:8790
```

Routes (hash-based, so any static host works): `#/` scenarios · `#/run/<scenario>/<baseline|escrow>` Flow Map · `#/split/<scenario>` side by side (`?layout=cols`) · `#/approve[/<contractId>]` approvals (phone-friendly). Add `?mode=cached` to force a recorded run.

## Configuration (build time, see `.env.example`)

| var | meaning |
|---|---|
| `VITE_API_BASE` | Control API base URL. Empty = same origin (the dev/preview proxy). |
| `VITE_WS_URL` | Event stream URL. Empty = `VITE_API_BASE` (or the page origin) + `/events`. |
| `ESCROW_BACKEND` | Dev/preview proxy target only; not shipped. |

The API only answers browser origins listed in `ESCROW_UI_ORIGINS` on the server (default: the Vite dev and preview origins).

## Never a broken state

* Backend unreachable, busy (409), or unable to run live (503) → the run replays the bundled recording, badged **CACHED RUN** with the reason.
* Event stream lost mid-run (8 s) or silent for 5 min → the view switches to the recorded run.
* Render errors are caught per view; the Model HUD has its own boundary.

## Deploy to Vercel (static; cached replays with no backend)

The build is plain static files (`dist/`, hash routing, relative asset paths), so Vercel only hosts them and needs no build step or rewrites. With `VITE_API_BASE` empty and no backend, the health check fails, the header shows **OFFLINE · CACHED REPLAYS**, and every scenario replays its bundled live transcript (85 runs, 42 scenarios), flagged CACHED RUN. Checked on 2026-10-28 by serving `dist/` as plain static files with nothing behind `/api` (`evidence/ui/11-static-*.png`).

```bash
npx vercel@64.0.2 login                     # interactive: email or GitHub
cd ui && npm run build                      # cached-only build (no VITE_API_BASE)
npx vercel@64.0.2 deploy dist --prod        # first time it asks: set up and deploy? → yes; scope; link to existing? → no; project name (e.g. escrow-ui)
```
The URL it prints (for example `https://escrow-ui.vercel.app`) is the demo link.

**Live runs later** (after the tunnel, `infra/cloudflared/README.md`):
1. Put the Vercel origin in `state/public.env`: `ESCROW_UI_ORIGINS=https://escrow-ui.vercel.app`.
2. Rebuild against the tunnel and redeploy: `VITE_API_BASE=https://escrow-api.<your-domain> npm run build && npx vercel@64.0.2 deploy dist --prod`.
3. Start the backend with `infra/cloudflared/serve-public.sh`.

Visitors without the token still get cached replays (**LIVE LOCKED**). The presenter unlocks live runs once with the token.

The bundle contains no token and no key; check with `grep -c "$(grep -o 'TOKEN=.*' ../state/public.env | cut -d= -f2)" dist/assets/*.js` → 0. The only 64-hex string in it is the hex-encoding attack scenario's payload (synthetic record data).
