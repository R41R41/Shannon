# Minecraft Shannon: adaptive cognition runtime

> Status: first production-compatible vertical slice implemented in Shannon-dev on 2026-09-27. Runtime default is `off`; rollout starts with `shadow`.

> Execution-layer extension (2026-09-29): live action progress, per-action
> cancellation/resource ownership, in-action shadow/feedback supervision and
> background furnace queries are described in [execution efficiency](./minecraft-execution-efficiency.md).
> This adds bounded cancellation of an existing action under a separate,
> default-off flag. It does not enable arbitrary direct reflex skill execution;
> the original post-action feedback behavior below remains available.

## Why this exists

The former EmotionAgent / CentralAgent / SkillAgent / CognitiveBlackboard design had the right feedback-loop idea but put slow, general-purpose model calls on the critical path. It was removed because it made Minecraft control too slow and complex. The replacement keeps the useful property — continuously asking whether work is succeeding and whether the plan should change — without restoring a process-global blackboard or three always-running LLM agents.

The runtime separates three timescales:

1. **Safety containment (existing deterministic guard):** begins immediately and does not wait for a network model.
2. **Fast System 1:** makes a typed reflex or execution-control assessment under a short timeout. It uses Jev when available, GPT-5.6 Luna while Jev access is pending, and a non-controlling local fallback if neither API is available.
3. **System 2 (`ShannonExecutor`):** performs open-ended planning, tool selection, replanning, and user communication.

The fast model is not used to generate prose or Minecraft commands. It chooses among bounded controls. Minecraft skills remain the only action executors.

## Implemented flow

```text
Minecraft event / user goal
        │
        ├─ emergency event ──┬─ immediate safety containment (never waits for a model)
        │                    └─ ReflexPolicy (Jev/OpenAI) ── typed recommendation
        │
        └─ ShannonExecutor (System 2)
                 │
                 ├─ before skill: WorldFrame(revision N)
                 ├─ execute InstantSkill / Routine
                 ├─ after skill:  WorldFrame(revision N+1)
                 ├─ ActionReceipt + observed WorldDelta
                 └─ ExecutionCritic (Jev/OpenAI) ── typed control for next turn
                                      │
                                      ├─ shadow: record only
                                      └─ feedback: inject fresh, confident advice into System 2

All artifacts are appended to a run-scoped TaskWorkspace.
```

## TaskWorkspace

`backend/src/services/minebot/cognition/TaskWorkspace.ts` replaces the old singleton-style blackboard with a bounded per-run event log and projection.

It stores:

- monotonically increasing `WorldFrame.revision` values;
- the current and previous normalized world frames;
- the System 2 goal tree projection;
- up to 64 `ActionReceipt` records;
- up to 32 execution-critic assessments;
- up to 16 emergency-reflex decisions;
- up to 256 append-only workspace events.

The workspace is constructed for one run and is never process-global. A receipt from another run is rejected. Snapshots are cloned before returning so callers cannot mutate internal state. When `MAX_ITERATIONS` requests user confirmation, the snapshot is persisted alongside Anthropic messages and task nodes, then restored for continuation.

## WorldFrame and ActionReceipt

`WorldFrame` is the normalized evidence available to fast decision layers. It currently includes position, dimension, health, food, oxygen, water state, weather, time, biome, held item, inventory, active effects, and the nearest 16 entities. It deliberately contains observations, not conclusions such as “this route is bad.”

An `ActionReceipt` records:

- capability name and typed arguments;
- start/end time and duration;
- world revisions before and after execution;
- skill/routine success, failure type, and recoverability when known;
- a bounded result summary;
- deterministic observed deltas for position, health, food, dimension, and inventory.

This gives the fast classifier evidence about what actually changed instead of asking it to infer progress from an LLM transcript.

## Fast reflex policy

`JevReflexPolicy` and `OpenAIReflexPolicy` implement the same contract. The selected policy evaluates an emergency event concurrently with the existing immediate safety containment. Its typed output is:

- `shouldPreemptProbability`;
- `immediateAction`: `FLEE`, `EAT`, `SURFACE`, `STOP_MOVEMENT`, `SEEK_SHELTER`, `OBSERVE`, or `DELEGATE_SYSTEM2`;
- `urgency`: `LOW`, `MEDIUM`, or `CRITICAL`;
- confidence and capability availability.

The request includes the event, a fresh WorldFrame, whether another task is active, and the exact registered InstantSkill/ConstantSkill names. A verifier checks that actions with a named capability are actually available. If not, the decision is converted to `DELEGATE_SYSTEM2`.

`shadow` records the result only. `feedback` adds a confident model recommendation to the constrained emergency task sent to System 2. The policy does not directly call a skill in this slice.

## Fast execution critic

After each iteration containing a physical InstantSkill or Routine, the configured `JevExecutionCritic` or `OpenAIExecutionCritic` receives the goal, goal tree, current/previous WorldFrame, recent receipts, and previous assessment. It returns:

- progress: `ON_TRACK`, `UNCERTAIN`, `STALLED`, `REGRESSING`, `COMPLETED_UNVERIFIED`;
- probabilities for continue, observe, and replan;
- failure cause;
- next control: `CONTINUE`, `OBSERVE`, `RETRY_ONCE`, `SWITCH_SUBTASK`, `REPLAN`, `ABORT_UNSAFE`;
- confidence.

In `feedback`, only a fresh remote-model result with confidence at least 0.66 and a non-`CONTINUE` control is injected into the next System 2 turn. A response whose evaluated world revision is no longer current is marked `stale` and ignored. Local fallback output is recorded for observability but never injected as if it were a model judgment.

## Configuration and rollout

The feature is fail-closed and off by default.

| Variable | Default | Meaning |
|---|---:|---|
| `MINECRAFT_COGNITION_MODE` | `off` | `off`, `shadow`, or `feedback`; legacy `MINECRAFT_JEV_MODE` remains an alias |
| `MINECRAFT_COGNITION_PROVIDER` | `auto` | `auto`, `jev`, `openai`, or `local`; `auto` prefers Jev, then OpenAI |
| `TYPESAFE_API_KEY` | empty | TypeSafe/Jev bearer credential; keep only in protected runtime env |
| `SHANNON_JEV_MODEL` | `jev-latest` | Stable Jev alias. Use `jev-preview` only in an explicit comparison, never as the production default. |
| `SHANNON_JEV_ENDPOINT` | `https://api.typesafe.ai/v1/systemone` | System One endpoint |
| `SHANNON_JEV_TIMEOUT_MS` | `900` | bounded request timeout (50–5000 ms) |
| `OPENAI_API_KEY` | required by Shannon | OpenAI credential reused by the isolated fast classifier |
| `MINECRAFT_OPENAI_MODEL` | `gpt-5.6-luna` | temporary fast System 1 model while Jev access is pending |
| `MINECRAFT_OPENAI_REASONING_EFFORT` | `none` | `none`, `low`, or `medium`; begin at `none`, raise only from replay evidence |
| `MINECRAFT_OPENAI_ENDPOINT` | `https://api.openai.com/v1/responses` | Responses API endpoint |
| `MINECRAFT_OPENAI_TIMEOUT_MS` | `2500` | bounded request timeout (50–5000 ms); adds headroom over the initial 1.18–1.75 s live sample, not a 100 ms target |

`auto` makes the Jev transition operational rather than a code migration: once `TYPESAFE_API_KEY` is present, new critic/reflex instances prefer Jev. Set `MINECRAFT_COGNITION_PROVIDER=openai` to keep Luna during an explicit comparison, or `local` to prohibit all remote classifier calls. System 2 remains `ShannonExecutor`/Anthropic in this slice; changing the planner is a separate quality and tool-use evaluation.

### Production credential boundary

Create a Minebot-only TypeSafe key. Do not reuse a Shannon router, Aether, Voyager, or developer key. The key value must never appear in Git, chat, shell history, reports, or journal output.

The production host reads the dedicated root-owned runtime file through the Shannon systemd unit:

```text
/home/azureuser/.config/shannon/minebot-jev.env  (mode 0600, owner azureuser)
```

The non-secret policy values stored beside the key are:

```dotenv
SHANNON_JEV_MODEL=jev-latest
SHANNON_JEV_ENDPOINT=https://api.typesafe.ai/v1/systemone
MINECRAFT_COGNITION_PROVIDER=jev
MINECRAFT_COGNITION_MODE=shadow
```

Begin with `shadow`; do not jump directly to `feedback`. Each assessment emits one secret-free `MINECRAFT_COGNITION_METRIC` line. Summarize a captured journal window without sending its contents to an external service:

```bash
journalctl -u shannon.service --since '24 hours ago' --no-pager \
  | npm run minebot:cognition-summary
```

The summary reports Jev success rate, fallback rate, stale rate, and p50/p95 latency separately for reflex and critic decisions. Require a representative sample across navigation, resource shortage, crafting, combat, and recovery before considering `feedback`; record the acceptance thresholds before examining the data.

On 2026-09-28 a dedicated TypeSafe key named `Minebot Production` was created and stored only in the protected runtime file above. The file is owned by `azureuser` with mode `0600`, and `shannon.service` has a systemd drop-in that reads it. `/v1/models` and `/v1/systemone` both returned HTTP 200 with `jev-latest`; the secret itself was not printed or persisted in project files. The running production process was deliberately not restarted, so this prepares the next reviewed Shannon release but does not silently activate new production behavior.

For an isolated real-server check, start an offline-auth test server on a non-production port, export the selected provider credentials, and run `npm run minebot:cognition-probe`. The probe connects a temporary `ShannonProbe` identity, establishes deterministic state with Minecraft commands, captures two real world frames around one harmless jump, records an action receipt, and verifies eight server-side postconditions before reporting success. `npm run minebot:command-probe` runs the same command gate without an LLM credential or call. Both refuse non-loopback hosts and known shared ports by default. Never point either probe at a production world or reuse the production Microsoft bot identity. The full procedure is in [Minecraft Shannon test lab](./minecraft-test-lab.md).

Rollout order:

1. `off`: workspace and receipts exist; no fast-model requests.
2. `shadow`: compare model outputs with actual outcomes, without changing prompts or actions.
3. `feedback`: feed only fresh, confident typed advice to System 2.
4. Direct reflex control is a later gate and requires replay evidence, latency/error budgets, per-action SkillContracts, and an explicit rollback switch. It is intentionally not enabled by this implementation.

## Safety and failure behavior

- Missing credentials, timeout, non-2xx response, or invalid schema returns a non-controlling fallback decision.
- A Jev/OpenAI outage does not disable the existing emergency containment path.
- `shadow` never changes the action or System 2 prompt.
- The evaluator itself does not mutate the bot. The 2026-09-29 execution
  supervisor can apply bounded cancellation/observation only under the separate
  `MINECRAFT_EXECUTION_SUPERVISION_MODE=feedback` opt-in and freshness gates.
- Physical execution remains behind existing tool policy and skill implementations.
- No shared singleton contains task or world state.
- Shannon-prod is unchanged until a separately approved release.

## Validation

Focused tests cover workspace isolation/immutability, world revision staleness, WorldDelta, Jev and OpenAI structured request/response parsing, provider selection, fallback behavior, confidence gates, reflex capability verification, and non-controlling failure behavior.

Remaining evaluation work before `feedback` is enabled in a live environment:

- replay representative combat, drowning, navigation, crafting, and resource-shortage traces;
- measure p50/p95 latency per provider, timeout rate, stale-decision rate, and disagreement rate;
- verify that `REPLAN` reduces repeated failures without creating plan churn;
- add outcome labels for unsafe or wasteful recommendations;
- define action-specific SkillContracts before any direct-control mode exists.

### Initial live probes (2026-09-27)

The implementation was exercised on Shannon-dev against a temporary Minecraft 1.21.11 Java server on loopback port 25577, using offline-auth test identity `ShannonProbe` and a freshly generated temporary world. Four complete probes connected, spawned, captured real world frames, executed a jump control sequence, recorded one receipt, and received both GPT-5.6 Luna structured decisions with reasoning effort `none`.

- Reflex latency samples: 1496, 1750, 1390, and 1624 ms (median 1560 ms).
- Execution-critic latency samples: 1258, 1529, 1391, and 1181 ms (median 1325 ms).
- All successful model outputs passed the schema parser and capability gate. The critic consistently selected `COMPLETED_UNVERIFIED` + `OBSERVE` for a jump whose final position matched the starting position.
- The live run exposed an unbound `crypto.randomUUID` receiver under Node 22; the factory is now wrapped and covered by regression tests.
- The temporary server was stopped, its generated world was removed, port 25577 was confirmed closed, and Shannon-prod remained unchanged.

This validates the real Minecraft observation/workspace/provider slice. It does not yet validate a full emergency event or long-running goal through the deployed Shannon service; that requires a dedicated dev bot identity and dev runtime configuration rather than production credentials.

The command-oracle extension was then exercised on a fresh temporary world on the same isolated port. The server accepted the deterministic setup, GPT-5.6 Luna returned remote reflex and critic decisions, and all eight independent command assertions passed: position, floor block, dimension, gamemode, health, food, exact iron-ingot count, and absence of a nearby zombie. The emitted report includes each expected assertion and its latency; skill/model self-report is not used as the sole pass condition.

Finally, the standalone `minebot:self-test-probe` ran the real `SelfTestRunner` and the real `get-position` / `check-inventory-item` implementations against that world. Both skills passed and all eight attached command assertions passed with auto-fix disabled. The command-only probe also passed without loading an LLM credential. After validation, the server was stopped gracefully, port 25577 was confirmed closed, and the exact temporary server directory was removed.

### Jev latency baseline (2026-09-28)

The dedicated Minebot credential was used from Shannon-dev without restarting production. Across 64 bounded `jev-latest` calls, reflex latency was 171 ms p50 / 211 ms p95 and critic latency was 171 ms p50 / 226 ms p95, with no fallback under the 900 ms deadline. Five isolated real-server probes all passed; their live reflex-and-record path was 239 ms p50 and critic-and-record path was 177 ms p50. Observation and TaskWorkspace operations remained below one millisecond. The detailed method, scenario results, quality cautions, and stage breakdown are in [Minecraft cognition latency benchmark](./minecraft-cognition-latency.md).
