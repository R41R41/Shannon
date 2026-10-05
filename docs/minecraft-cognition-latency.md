# Minecraft cognition latency benchmark

> Measured on Shannon-dev, 2026-09-28. This is an initial latency baseline, not a production SLO or a model-quality acceptance decision.

## Result

From the Shannon VM, `jev-latest` produced a typed decision in roughly **0.17 seconds** in the provider-only benchmark and **0.24 seconds** through the live Mineflayer reflex path. It was substantially faster than GPT-5.6 Luna, but it did not reach 0.10 seconds in this environment.

The local Shannon work is not the bottleneck. World observation, JSON preparation, schema mapping, capability validation, and TaskWorkspace freshness recording each take well below one millisecond. Almost all Jev time is spent waiting for the remote request.

## Method

`npm run minebot:cognition-benchmark` runs the same production policy classes over eight bounded patterns:

- reflex: routine observation, hostile combat, drowning, and low health/hunger;
- execution critic: on track, repeated failure, regressing/unsafe, and completed but unverified.

The run used:

- `jev-latest`, 900 ms timeout, 8 repetitions per pattern (64 remote calls);
- `gpt-5.6-luna`, reasoning effort `none`, 2,500 ms timeout, 3 repetitions per pattern (24 remote calls);
- local fail-closed policy, 100 repetitions per pattern (800 local decisions);
- 10,000 iterations of local observation, serialization, fresh assessment recording, and stale assessment recording.

The instrumented fetch wrapper separates time-to-response-headers, response body/JSON decoding, and local parsing/validation. It records byte counts and never records an API key.

The live check used five fresh probe connections to a temporary Fabric 1.21.11 server bound to loopback port 25577. Each probe arranged deterministic state, captured real Mineflayer observations, ran Jev reflex and critic routes, performed a harmless jump, and evaluated eight server-authoritative assertions. The temporary world and server were removed after the run. Shannon production was not restarted or modified.

## Provider-only latency

| Provider and route | Samples | Remote success | p50 | p95 | Maximum |
|---|---:|---:|---:|---:|---:|
| Jev reflex | 32 | 100% | 171 ms | 211 ms | 249 ms |
| Jev critic | 32 | 100% | 171 ms | 226 ms | 232 ms |
| GPT-5.6 Luna reflex | 12 | 91.7% | 1,392 ms | 2,340 ms | 2,501 ms |
| GPT-5.6 Luna critic | 12 | 100% | 1,369 ms | 1,662 ms | 1,761 ms |
| Local fail-closed reflex | 400 | not remote | <0.01 ms | 0.01 ms | 0.86 ms |
| Local fail-closed critic | 400 | not remote | <0.01 ms | 0.01 ms | 0.49 ms |

Jev was about 8.2× faster at reflex p50 and 8.0× faster at critic p50. The one Luna failure was a reflex request that reached its 2,500 ms deadline and correctly returned the non-controlling fallback.

The Luna sample is deliberately small because it is a paid comparison baseline. Its p95 should be treated as directional rather than a stable tail estimate.

## Jev by pattern

| Route | Pattern | Samples | p50 | p95 | Observed result |
|---|---|---:|---:|---:|---|
| Reflex | routine observation | 8 | 171 ms | 236 ms | `LOW / OBSERVE` 8/8 |
| Reflex | hostile combat | 8 | 164 ms | 195 ms | `CRITICAL / FLEE` 8/8 |
| Reflex | drowning | 8 | 170 ms | 207 ms | `CRITICAL / SURFACE` 8/8 |
| Reflex | low health/hunger | 8 | 178 ms | 204 ms | `LOW / EAT` 8/8 |
| Critic | on track | 8 | 174 ms | 214 ms | `ON_TRACK / CONTINUE` 8/8 |
| Critic | repeated failure | 8 | 179 ms | 229 ms | `STALLED / OBSERVE` 8/8 |
| Critic | regressing/unsafe | 8 | 169 ms | 197 ms | `REGRESSING / REPLAN` 6/8; `OBSERVE` 2/8 |
| Critic | completed unverified | 8 | 176 ms | 192 ms | `COMPLETED_UNVERIFIED / OBSERVE` 8/8 |

Input size did not materially alter latency in this range. Reflex requests were about 2.0–2.1 KB and critic requests were 4.1–5.2 KB.

Two quality findings must remain separate from the good latency result:

- The low-health/hunger pattern selected `EAT` consistently but labeled urgency `LOW`. This should be outcome-scored before direct control.
- Repeated pathfinding failure selected `OBSERVE`, not `REPLAN`, in all eight samples. That may be appropriately conservative, but it does not yet prove that Jev will break retry loops.

## Where the time goes

For Jev reflex at p50:

- request to response headers: 169.92 ms;
- response body plus JSON decoding: 0.49 ms;
- local schema mapping, capability validation, and object construction: 0.12 ms;
- total: 170.73 ms.

For Jev critic at p50:

- request to response headers: 170.08 ms;
- response body plus JSON decoding: 0.48 ms;
- local schema mapping and object construction: 0.15 ms;
- total: 171.07 ms.

Local plumbing over 10,000 iterations:

| Stage | p50 | p95 |
|---|---:|---:|
| World observation capture with 64 entities and 36 inventory slots | 0.02 ms | 0.03 ms |
| Record fresh critic assessment | 0.01 ms | 0.02 ms |
| Detect and record stale critic assessment | 0.01 ms | 0.02 ms |
| Serialize representative critic input | 0.01 ms | 0.01 ms |

The practical optimization target is therefore connection/provider latency, not a rewrite of TaskWorkspace or the observation structure.

## Live Minecraft route

All five live probes passed both remote-model requirements and all eight command assertions.

| Stage | p50 | p95 | Meaning |
|---|---:|---:|---|
| Connect to spawn | 884 ms | 3,195 ms | First run included fresh-world/chunk cold start (3,760 ms) |
| Command channel ready | 41 ms | 50 ms | Private tellraw barrier |
| Seven setup commands | 34 ms | 207 ms | First run was cold |
| Observation + Workspace | 0.67 ms | 0.71 ms | Real Mineflayer state |
| Jev reflex + Workspace record | 239 ms | 257 ms | Decision-ready reaction path |
| Jev critic + Workspace record | 177 ms | 203 ms | Post-action self-evaluation |
| Eight command assertions | 50 ms | 145 ms | Individual assertion p50 5 ms, p95 18 ms |
| Full probe report | 3,432 ms | 6,049 ms | Includes 2,000 ms of deliberate settle/jump waits and connection |

The full-probe duration is not the emergency reaction latency. Once the bot is connected, the current shadow path has a decision available in about **240 ms median**. It does not directly execute that model choice; deterministic containment still runs independently, and direct Jev control remains gated.

## Architectural consequences

1. Keep deterministic emergency containment concurrent with the classifier. A 170–240 ms remote decision is fast enough to refine a response, but it is still several Minecraft ticks and cannot replace immediate safeguards.
2. Keep the 900 ms Jev deadline. All 64 provider calls and all 10 live calls completed inside it in this sample, leaving substantial headroom while retaining fail-closed behavior.
3. Do not optimize Blackboard/TaskWorkspace away for speed. Its measured cost is negligible and it supplies the freshness boundary needed to reject obsolete feedback.
4. Separate reaction classes:
   - zero-delay containment: stop unsafe movement, retain oxygen/health guardrails;
   - approximately 0.2-second Jev classification: choose bounded skill/control;
   - skill execution: world-dependent and measured by action receipts;
   - post-action critic: approximately 0.18 seconds, asynchronous unless a safety gate requires it.
5. Before enabling `feedback`, collect a larger shadow sample and score correctness, not only latency. Before any direct-control mode, add live hostile, drowning, and hunger outcome fixtures with server-authoritative success thresholds.

## Reproduction

The benchmark reads credentials only from the runtime environment and writes secret-free JSON to stdout:

```bash
cd backend
npm run minebot:cognition-benchmark > /tmp/minecraft-cognition-benchmark.json
```

Optional repetition controls are `JEV_BENCH_REPETITIONS`, `OPENAI_BENCH_REPETITIONS`, and `LOCAL_BENCH_REPETITIONS`. The live stage timings are emitted by `npm run minebot:cognition-probe` under the `timings` field.

