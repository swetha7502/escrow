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
