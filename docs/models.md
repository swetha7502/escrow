# Token Factory models used by Escrow

Source: `GET https://api.tokenfactory.nebius.com/v1/models?verbose=true`, fetched 2026-10-23 (HTTP 200, 30 models listed).
Prices are USD per token, exactly as returned in each model's `pricing` field.

| Role | Model ID | Prompt $/token | Completion $/token | Cached input $/token | Context | Rate limits |
|---|---|---|---|---|---|---|
| Super (agent default, paraphrase adjudication) | `nvidia/nemotron-3-super-120b-a12b` | 0.0000003 ($0.30/M) | 0.0000009 ($0.90/M) | 0.00000006 | 262,144 | 200k TPM, 300 RPM |
| Nano (read labeling) | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | 0.00000006 ($0.06/M) | 0.00000024 ($0.24/M) | n/a | 262,144 | 800k TPM, 100 RPM |
| Ultra (task contract, attack scenarios) | `nvidia/Nemotron-3-Ultra-550b-a55b` | 0.000001 ($1.00/M) | 0.000003 ($3.00/M) | 0.00000012 | 1,048,576 | 200k TPM, 300 RPM |

Other Nemotron models listed but not used: `nvidia/Nemotron-3_5-Lightning`, `nvidia/Nemotron-3.5-Super-VL`.

## Machine-readable price table

The spend proxy (`proxy/`) reads this block. A model that isn't listed here is **refused** (fail closed).
The proxy bills cached input at the full prompt price, which is conservative.

```json prices
{
  "nvidia/nemotron-3-super-120b-a12b": { "prompt": 0.0000003, "completion": 0.0000009 },
  "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B": { "prompt": 0.00000006, "completion": 0.00000024 },
  "nvidia/Nemotron-3-Ultra-550b-a55b": { "prompt": 0.000001, "completion": 0.000003 }
}
```
