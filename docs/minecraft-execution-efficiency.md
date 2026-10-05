# Minecraft execution efficiency and live supervision

Owner: Minecraft Shannon / Minebot. Implemented in Shannon-dev only. The full
Shannon service and production have not been deployed or restarted. Evaluation
uses a disposable loopback Fabric 1.21.11 server and an offline test identity.

## What changed

The strategic controller still chooses goals and skills. The execution layer
now owns physical resources, immutable cancellation and observable progress.
The fast critic can evaluate a skill while it is running, rather than only after
the entire tool call returns. This is not a restoration of three always-running
LLM agents or a process-global shared blackboard.

1. `executeAction` provides a per-bot resource lease and per-invocation abort
   signal. Nested skills share ownership but retain linked child deadlines.
  Cancellation stops movement/digging/item use promptly; ownership remains
  held until the underlying operation actually settles. A query cannot clear
  another action's cancellation. Two bots do not share a global executor.
   Pathfinding failure first requests `stop()` then clears the goal: native
   `stop()` alone is deferred to a later node, and calling it after clearing
   the goal leaves a stale stop that can interfere with the next action.
2. Progress carries an execution-session ID, action ID, generation, sequence,
   phase, status, last real progress and bounded evidence. `TaskWorkspace`
   retains a copied projection and rejects older events. Receipts contain queue
   and phase timing; events are bounded, not an unbounded raw trace prompt.
3. `ExecutionSupervisor` samples live progress and fresh world facts. There is
   at most one model request in flight, normally at least four seconds between
   requests. Blockage, lack of progress, external waits or changed critical
   facts can cause evaluation. This sampling budget is separate from model
   response latency; it is not a promised 0.1-second reaction to every event.
4. In `shadow`, the critic records only. In explicit `feedback`, fresh confident
   remote-model `REPLAN`, `SWITCH_SUBTASK` or `ABORT_UNSAFE` can cancel the exact
   running action; `OBSERVE` refreshes world facts. Late, fallback, low-confidence,
   replaced-action, changed-health/threat or resumed-progress results do not
   control the bot. System 2 chooses the replacement; the critic does not invent
   commands or replay irreversible operations. The remainder of an obsolete
   tool batch, including an old completion declaration, is invalidated while
   preserving the Anthropic tool-result protocol order.

Code still checks protocol facts, ownership, exact inventory/block effects and
physical preconditions. Those checks are not a hand-coded strategic decision
tree. Model judgment cannot turn a disappeared item or elapsed timer into proof
of success.

## Collection and search

`mine-block` validates the requested count, inventory and suitable tools before
radius-dependent scans. Targets are cached for the batch and revalidated at
execution; scans occur again only when the queue is exhausted. Existing bounded
recovery, durability checks, lava avoidance and partial-work reporting remain.

`dig-block-at` and `mine-block` use event-driven collection: item/inventory
updates are observed immediately, with a bounded fallback poll and deadline.
The previous implementation polled every 160 ms, required 550 ms of inventory
stability after pickup, and could wait up to 4.5 seconds before walking toward an
uncollected drop. That was an upper bound, not 4.5 seconds spent on every dig.
The new implementation can navigate toward visible loot immediately and return
on confirmed receipt. Default `target` policy uses versioned block-drop names
and does not chase unrelated seeds. Explicit
`all` retains general nearby collection. Actual requested loot is distinguished
from incidental inventory increases. Upper-log drops still receive per-block
collection; removing that feature would lose real resources.
Pickup goals compare actual item coordinates with the walking-cell centre,
not a rounded block-radius test. They allow an adjacent cell only when it is
actually in pickup reach, avoiding both an impossible route under an upper log
and a false arrival one cell too far from edge loot. A falling drop with an
unreachable old position is retried only after observed evidence changes.

## External work is not a stalled motor

`start-smelting` returns once the furnace is started. `get-background-jobs` is
an additional query skill; the previous 93-skill catalog is preserved (94 now).
Its ready time is an estimate and `completionVerified` is always false until
the actual result is separately checked. Jobs include their dimension.

`withdraw-from-furnace(..., 'output', false)` can return typed
`waiting_external` without withdrawing fuel or forgetting the job. The default
blocking behavior remains. A partial output does not end an unfinished job;
an expired wait with remaining input and no output is not an empty success.
While the furnace window is open, receipt checks read that window's player
inventory and its slot events. The closed-window `bot.inventory` projection
can be stale until closing; using it produced false missing-loot advice and an
unnecessary 800 ms confirmation timeout. Container/furnace reads also acquire
window ownership because they open a real game window, unlike passive queries.
Native furnace update listeners explicitly bind the registering action's async
context. TCP-originated callbacks otherwise lose `AsyncLocalStorage`, silently
dropping live progress even though physical smelting completes. Bound callbacks
ignore cancelled or settled actions and are removed in the existing `finally`.
System 2 sees pending work in its prompt and can choose independent preparation.
The game still needs roughly 30 seconds to smelt three iron items; overlapping
work reduces idle critical-path time, not Minecraft's physical smelting time.

## Rollout and reproducible checks

`MINECRAFT_EXECUTION_SUPERVISION_MODE=off|shadow|feedback` is an independent
opt-in, default `off`. Setting legacy cognition feedback does not silently
activate physical cancellation. Start with shadow and review mistakes/stale
responses before enabling feedback in an ordinary world. Direct Jev selection
and execution of arbitrary emergency skills remains a separate unimplemented
gate. Provider credentials stay in protected runtime storage, never reports.

Run offline unit checks with dummy required configuration, then the strict core
type project `backend/tsconfig.minecraft-execution.json`. This narrow semantic
check is not a claim that the entire legacy backend has passed strict checking.

The focused real-game runner is `npm run minebot:execution-probe`, with
`MINECRAFT_EXECUTION_REPEATS=2` by default. Its four scenarios are:

- Harvest three logs while leaving a tagged unrelated six-seed drop untouched.
- Repeat with explicit `all`, requiring both the logs and all six seeds.
- Interrupt an eight-stone job after two completed digs, verify quiescence and
  no late digs, then resume and require eight cobblestone and eight air blocks.
- Start three-iron smelting; verify nonblocking pending state; harvest logs,
  craft and place a chest while it runs; collect all iron and craft a pickaxe.

`MINECRAFT_EXECUTION_PROBE_JEV=true` uses only the dedicated protected Minebot
credential in memory and records actual in-action shadow classifications. It
does not start the full Shannon service. Success uses Minecraft command oracle
checks and death-event gates, not the skill's own success message alone.

The existing progressive runner retains its production/agriculture/combat
three-level fixtures and assertions. Run it sequentially on one server for
latency comparisons; concurrent correctness runs are not latency benchmarks.
Keep discovery failures and final fixed-source cohorts separate. Fingerprint
the selected source and preserve per-trial JSON, raw bot logs and server logs.
`node scripts/summarize-minecraft-execution.mjs <before-summary> <after-summary>`
reads the saved trials and reports root-call phase/queue means without counting
nested execution twice. These are diagnostic categories, not automatic labels
for mistakes or avoidable idle time.

## Evaluation boundary

Scripted skill scenarios establish actual skill effects and execution behavior.
They do not establish open-ended autonomous planning quality or critic accuracy
under every emergency. The native executor wiring test checks stale-batch
invalidation with a controlled critic; real Jev evaluation first runs in shadow.
No production configuration is changed by these tests.
Resource leases currently cover `InstantSkill` and its nested/composite calls.
Critical `ConstantSkill` survival behavior retains its existing priority/
interrupt path; this change is not a claim that every legacy motor writer has
already migrated to one lease protocol. Removing that survival path would be a
feature regression, not an efficiency fix. Full unification needs separate
mixed-emergency tests and an explicit handoff/preemption contract.

## Initial focused evaluation (2026-09-29)

The initial focused cohort `2026-09-28T19-26-30-868Z` (UTC identifier) passed all
8 trials, two per scenario, with zero deaths. Its runner/source fingerprint is
`d62cf0789b85e96b390252b20af1bead77eaa744efc2b9f0861fe7088de4041b`.
The earlier discovery cohort `2026-09-28T19-21-21-543Z` is preserved separately.

- Cancellation-to-quiescent terminal progress was 1 ms in both focused trials;
  that measures cooperative source unwinding, not a remote model's response or
  the server's entire physical/network delay. Both trials preserved two completed
  digs, checked no late digging for 600 ms, resumed the remaining six and verified
  exactly eight cobblestone and all eight excavated target blocks.
- Independent chest preparation occupied 13.451 / 10.299 seconds while the
  furnace ran. Remaining measured furnace wait was 15.699 / 18.849 seconds.
  Nonblocking output checks returned `waiting_external` in 40 ms in the second
  trial (the raw steps retain both observations). Actual iron output and the
  resulting pickaxe were independently verified. The script selected this
  overlap; autonomous System 2 scheduling is not established by this test.
- Seven actual in-action Jev responses: 183, 194, 194, 196, 207, 218, 273 ms;
  p50 196 ms / nearest-rank p95 273 ms. All stayed in shadow and none changed
  control. These seven observations are not a general performance guarantee.
- Critic quality did **not** pass a control-rollout gate: normal smelting was
  labeled `ON_TRACK`, but all seven responses also suggested `WRONG_ASSUMPTION`
  without supporting failure evidence; one suggested `SWITCH_SUBTASK` at high
  categorical confidence after independent preparation was already done.
  Therefore do not enable ordinary-world feedback on the strength of these
  tests. More labeled replay/negative cases and calibration are required. This
  is retained evidence, not hidden by changing the success oracle or threshold.

13 focused offline test files initially passed all 144 tests, including actual native
executor wiring, original progressive regressions, command oracle, world/memory
isolation, stale-response fences, cancellation and background-job contracts.
The strict core type project passed, as did whole-backend no-check syntax
compilation. A whole-backend semantic check was bounded at 90 seconds / 4 GB
and timed out without diagnostics; full semantic success is **not** claimed.

### Discovery retained rather than counted as a pass

The next progressive cohort `2026-09-28T19-33-03-305Z` was stopped after its
level-3 resource-production failure. Its first four level-1/2 production trials
passed; level 3 then collected only two of four logs after an unreachable pickup
path and repeated interrupted digs. The unchanged death/inventory/block oracle
correctly failed the trial. The raw log is preserved as
`execution-progressive-discovery-v2.log`, with per-trial JSON and the selected
source archive. It is not included in the post-fix pass count.
Its recovered version-2 selected-source fingerprint is
`7f68a4f7667ce786f2bbcfede2379fa9e5003d20a11a9c19e865abb1207bfea0`;
the recovery hashes the preserved archive, not the modified working tree.

The follow-up fix consumes deferred pathfinder stops synchronously, respects
pickup reach/head clearance and adds changed-evidence-only retries for falling
drops. Additional regressions cover that stale-stop handoff, unrelated loot
not satisfying a parent mining result, and open-window furnace inventory.
All 147 tests across the same 13 files then passed. The failed full-source
semantic attempt above is still not described as successful.

The following cohort `2026-09-28T19-50-45-178Z`, fingerprint
`4de8286576e80f63a96ca367882a29ed9c6f506e2e72e8c2f8ac2fa71da7076b`,
exposed a second level-3 resource failure: 11 stones were excavated, but only
four cobblestone were received. Its stone call spent 74.703 seconds, including
53.759 seconds in confirmation, repeatedly approaching the same edge drop
without entering pickup reach. The inventory oracle correctly rejected the
skill's excavation success. Raw evidence is retained as
`execution-progressive-discovery-v3.log` and per-trial JSON.

Native `GoalNear` rounds item coordinates to blocks. Widening its radius to one
node prevented a canopy route failure but could end outside actual pickup
reach, a regression rather than an acceptable feature tradeoff. The replacement
uses actual item-to-walking-centre geometry and a snapshot of the goal position.
An adversarial edge/canopy unit regression was added (148 tests now). A changed
goal or timer alone still cannot establish receipt; inventory and server checks
remain the success evidence.

## Fixed-source sequential measurement

The baseline `2026-09-28T18-31-41-384Z` passed 9/9 trials, one per job/level.
The execution-motor source
`63e9ba12754cce2d7a330d23dee3d261c6283888f2da494204dd4fe863f639fc`
was frozen across three non-overlapping sequential campaigns on port 25577:
`2026-09-28T20-03-58-884Z` (production level 3),
`2026-09-28T20-10-52-442Z` (production levels 1/2), and
`2026-09-28T20-18-00-512Z` (all farming/combat levels).
All used seed 9272026 and explicit flat settings, with a reset/read-back arena
and a new bot per trial. The cohort passed **17/18**, with zero deaths, not 18/18.

| Job / level | Baseline seconds (n=1) | Motor-source mean seconds (n=2) | Range seconds | Observed passes | Change |
|---|---:|---:|---:|---:|---:|
| Production 1 | 107.682 | 83.978 | 81.595–86.361 | 2/2 | 22.0% shorter |
| Production 2 | 162.587 | 120.372 | 118.448–122.296 | 2/2 | 26.0% shorter |
| Production 3 | 205.645 | 155.707 | 150.493–160.920 | 2/2 | 24.3% shorter |
| Farming 1 | 34.041 | 35.766 | 33.298–38.233 | 2/2 | 5.1% longer |
| Farming 2 | 64.897 | 68.624 | 67.101–70.147 | 2/2 | 5.7% longer |
| Farming 3 | 134.911 | 120.799 | 118.690–122.907 | 2/2 | 10.5% shorter |
| Combat 1 | 25.203 | 24.899 | 24.587–25.211 | 2/2 | 1.2% shorter |
| Combat 2 | 31.481 | 30.407 | 30.211–30.603 | 2/2 | 3.4% shorter |
| Combat 3 | 41.041 | 43.368 | 39.020–47.715 | 1/2 | No improvement claim |

Whole trials include connection/import, fixtures and oracle work. The samples
are descriptive, not statistical guarantees; farming 1/2 did not get faster.
Generated `execution-final-comparison.json` retains every cell and root-call
phase means without adding child time twice.

In production level 3, stone-11 excavation/receipt fell from 57.561 to mean
25.722 seconds; wood-4 from 29.801 to 22.175; iron-3 from 26.105 to 21.627;
coal-1 from 8.339 to 3.624. The missing-tool negative case fell from 1.632
seconds to 0.002 mean, and the unit test verifies no radius scan was made.
The two stone calls spent 3.862/2.803 seconds in confirmation, 18.024/18.266
in actual digging and 4.100/3.763 in navigation. The old baseline lacks these
new trace categories, so a precise old-versus-new idle-time subtraction is
not claimed. Normal digging, navigation and smelting are not all wasted time.

### Remaining combat discovery and observation refinement

The failed Hard combat trial killed one of three enemies, reached minimum HP
3.783 and safely escaped. A successful escape is not the requested defended
arena; the unchanged kill/remaining-enemy oracle rejected it. The second trial
killed all three. Both observations and raw `execution-farming-combat-final.log`
are retained, not renamed into a clean all-pass cohort.

Code inspection found that a held shield retained its initial bearing while
enemies moved across ticks. `faceThreat` now rotates toward the current nearest
threat without reactivating the shield, resetting its warm-up, changing scorer
thresholds or disabling safe escape. This fixes a physical execution defect;
one discovery does not establish that it was the only cause of combat variance.

The same follow-up source binds native furnace callbacks to action context.
Initial focused smelting reports recorded only the initial external-wait event,
despite receiving all three iron ingots. New regressions emit from outside ALS
and reject callbacks after root completion/cancellation or child completion.
The focused live runner now independently requires changing output counts and
an observed three-item furnace output in the owning action's progress.

All **152 tests in 13 files** passed after these refinements. Strict core type
checking and whole-backend no-check syntax compilation passed again. The earlier
bounded whole-backend semantic timeout remains an unresolved validation limit.
Combat and focused live follow-up results are recorded separately below; the
17/18 motor-source cohort is not relabelled as a cohort of the follow-up source.

### Combat after shield-facing / observation refinement

Campaign `2026-09-28T20-31-13-587Z`, selected-source fingerprint
`882750933f1700240b31b58976e42d5aac40b01ab1db35e9e70ce5aa348295e7`,
passed **6/6** (all three levels twice), zero deaths, and all 76 server assertions.
The unchanged Hard fixture still has real-AI zombie/husk/skeleton, night/rain,
natural spawning and the obstacle; no extra armour, buffs or kill-count relaxation.

| Combat level | Whole-trial seconds 1 / 2 | Minimum HP 1 / 2 |
|---|---:|---:|
| 1 | 28.728 / 25.382 | 18.140 / 18.140 |
| 2 | 30.851 / 30.106 | 17.280 / 16.420 |
| 3 | 42.890 / 43.335 | 9.467 / 10.205 |

Both Hard trials recorded exactly skeleton, husk and zombie death events and
zero remaining tagged targets. This is observed correctness, not evidence of
a combat speedup or immunity to future difficult situations. Resource/farming
timing above belongs to the earlier motor source; those physical algorithms
were unchanged by shield bearing and native progress-context refinement. No
single complete 18-trial campaign of this follow-up fingerprint is claimed.

### Focused live follow-up

Campaign `2026-09-28T20-35-04-360Z` passed **8/8**, zero deaths, all 90 server
assertions and the additional native-progress/partial-cancellation gates.
Its focused-runner fingerprint is
`c82dd53cf22a13409678c91e3a17bf6db29d6c0d7931526d4daa00e7598f8029`.
It ran after the combat cohort without changing runtime sources. The hashes
differ because the progressive runner additionally fingerprints graph/config
and its own script; focused fingerprints its own script instead. The preserved
`execution-observer-combat-source.tar.gz` contains both runners; the read-only
`verify-minecraft-execution-source-archives.mjs` verifies both schemes from
archived bytes, not the current checkout. No new model thresholds were tuned
between trials.

- Target-only and explicit-all policies each passed twice: exactly three logs,
  and respectively zero/six seeds, with the tagged distractor retained/removed
  as intended. Unrelated items did not substitute for requested loot.
- Both interruptions settled in 1 ms between cancelling and cancelled progress;
  this is cooperative local unwinding, not end-to-end model/network latency.
  Two completed digs were preserved, no further digging occurred over 600 ms,
  and the remaining six digs produced exactly eight cobblestone/eight air blocks.
- Smelting progress in both trials showed output counts **1 → 2 → 3**, with
  remaining inputs **2 → 1 → 0**, under the correct action ID. All three iron
  ingots reached player inventory and an actual iron pickaxe was crafted.
- Nonblocking pending checks took 43/46 ms. Independent logging, crafting and
  chest placement took 13.150/11.949 seconds while the furnace worked; remaining
  furnace wait was 15.999/17.199 seconds. This overlap was selected by the probe,
  not autonomously discovered by the planner.
- Six real Jev responses took 183, 196, 201, 231, 241 and 395 ms: median 216 ms,
  nearest-rank p95 395 ms. Every response stayed in shadow with no applied control.
  All reported `ON_TRACK` but also `WRONG_ASSUMPTION`; one suggested
  `SWITCH_SUBTASK`, the others `OBSERVE`. Even with live furnace evidence, the
  current question/provider configuration is **not qualified for ordinary-world
  control**. More labeled evals and calibration remain required.

Latest applicable functional evidence is resource/farming **12/12** on the motor
source, combat **6/6** and focused **8/8** on the follow-up source: 564 independent
server assertions, zero deaths. These are separate source-scoped cohorts, not a
fictional single all-pass campaign. Earlier discovery failures remain retained.

### Evidence preservation and shutdown

All four version-2 source archives matched their recorded hashes when recomputed
from archive bytes, including both final runner fingerprint schemes. Fourteen
execution/graph/probe files were byte-identical between the local integration
mirror and the VM. JSON, raw bot logs and source archives are accompanied by
`execution-evidence-sha256.txt` in the ignored reports directory.

The owned `codex-progressive-lab` server received graceful `stop`; its log confirms
all overworld/Nether/End chunks saved and port 25577 closed. The unrelated Terraria
session was left running. `execution-lab-6npG9W-world.tar.gz` preserves the exact
test world, logs and configuration; archive comparison against the stopped lab
returned no differences. The original disposable lab remains recoverable at
`/home/azureuser/minecraft/progressive-lab-6npG9W`; no world was deleted.
Shannon-prod remained clean at `5412c1f1c0ae6b121cba65898cd8c702c3d3e2a9`.
No normal service, production configuration, release or shared database was changed.

## Shared knowledge return: TI-KNOWLEDGE-MINEBOT-EXECUTION

Destination: Syzygy knowledge hub / execution and evaluation owners. Status:
reusable candidate, not an adopted suite-wide policy. Shared-hub and Apple-app
implementation files were not changed here.

- An action owns immutable cancellation and resources until its real body
  settles, not merely until its caller wins a timeout race.
- Native event callbacks must explicitly retain their owning action context;
  registering inside ALS does not bind an external emitter. Ignore late events
  after cancellation/completion and remove listeners on every exit.
- A route's rounded-grid arrival, incidental loot or predicted job-ready time
  is not proof of the intended effect. Verify exact receipt/world state.
- Fast classification latency and correct control judgment are separate gates.
  Preserve shadow mistakes and failed physical trials before enabling control.

Evidence is the implementation, regressions and separately identified cohorts
in this document. Notion mirroring could not be verified: the required linked
hub returned 404 in this investigation. Repository documentation is updated;
no inaccessible page or successful Notion write is claimed.
