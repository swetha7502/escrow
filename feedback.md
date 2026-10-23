# Friction log (Nebius / NVIDIA / NemoClaw / OpenShell)

## 2026-10-20 — Token Factory API key pending approval
- **What happened:** Couldn't get a Nebius Token Factory API key yet; the request is waiting on approval.
- **Workaround:** Temporarily using NVIDIA's hosted API (build.nvidia.com, `NVIDIA_API_KEY`) as the inference provider. The sandbox egress policy is written so moving the allowlisted host to `api.tokenfactory.nebius.com` takes a one-line change. The M3 egress proof will be re-run against Token Factory once `TF_API_KEY` arrives. The final evidence will show Token Factory.

## 2026-10-23 — Token Factory key arrived; NVIDIA-hosted fallback dropped
- **What happened:** Got `TF_API_KEY`. The project moved to Nebius Token Factory directly. The NVIDIA build.nvidia.com workaround above is retired.
- **Friction:** The `.env` I'd pasted from the console had CRLF line endings and leading spaces on each line, and naive `source .env` / `cut` broke on the `\r`.
- **Workaround:** `lib/env.ts` trims whitespace and `\r`. Shell snippets use `tr -d '\r '`.

## 2026-10-23 — Token Factory /v1/models pricing is per-token strings
- **What happened:** `GET /v1/models?verbose=true` returns `pricing.prompt`/`pricing.completion` as decimal strings in USD per token, e.g. `"0.0000003"`. This is handy, but undocumented in the OpenAI-compat shape. Nemotron IDs are inconsistent in casing (`nvidia/nemotron-3-super-120b-a12b` vs `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` vs `nvidia/Nemotron-3-Ultra-550b-a55b`).
- **Workaround:** Copied exact IDs and prices into `docs/models.md`. The proxy refuses any model not in that table.
