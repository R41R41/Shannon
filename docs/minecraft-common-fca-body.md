# Common FCA Minecraft body adapter

Stage 4 is implemented behind `MINEBOT_COMMON_FCA=on`, together with the existing dedicated-world companion URL, device-token file, server ID and server-name settings. Default OFF retains the existing planner and companion request loop. Enabling this mode requires the Shannon companion API's `SHANNON_FCA_MINECRAFT=on` and common task runtime; no live connection or deployment was performed for this change.

## Execution and ownership

SkillAgent loads the actual InstantSkill instances into `bot.instantSkills`. Common mode exposes their validated parameter schemas to `/v1/body/minecraft/control`, and dispatches registered instances through `InstantSkill.run` inside the existing `ActionExecution` arbiter. It skips the old tool gateway, ShannonExecutor registration, legacy request claims, self-improvement daemon, event planner and chat-command fallback. Game chat continues through the companion, including authenticated player UUIDs; unavailability never starts a second planner.

The body samples a current WorldObservation independently every 100ms and polls control about every 200ms. Polls carry the latest frame, resolved candidate metadata, active command IDs and receipts. A command runs once per connection; lost receipt ACKs retry delivery, not effects. Disconnect aborts active commands. Unknown results stay held until a real cleanup. Historical cleanup acknowledgements cannot clear another session's unknown fence. A late ordinary receipt, including a read-only query or capture, cannot clear an unknown hold established by concurrent cleanup; only a current cleanup that confirms physical release can do so.

The API's ActionLease identity/generation and task/session context accompany each command. Reflex release closes its session while the enclosing FCA lease remains usable by the normal step. Stop/release accepts expired deadlines only for safe cleanup, and reports stopped only after physical quiescence and released controls. The `waitForQuiescence` execution path disables the legacy 15-second forced reclamation; OFF callers keep that recovery behavior. An unresolved native callback cannot become an affirmative stop ACK merely because time passed.

Only native observation constants plus the existing local `auto-swim` air-survival reflex remain scheduled in common mode. Auto-swim uses the same ActionExecution resource arbiter, emits progress into body state, and prevents a stop ACK while it owns the body. There is no second background planner. Read-only queries and image capture acquire no motor inputs; their own receipt reports released inputs without claiming that other native owners are quiescent.

## Skills, observations and candidates

The catalog includes actual finite InstantSkills, with `readOnly` derived from the existing skill category (unknown categories are physical). Names involving planners, agents, campaigns, commands, chat, code, routines, background scheduling and constant toggles are excluded. The API imposes a 120-second command deadline, while each skill keeps its own native timeout and receives the enclosing abort signal. Schemas preserve nullable/default/Vec3 arguments, forbid extra object fields, and remove only Zod's impossible JSON branch `{not:{}}` when it appears inside an optional union. Every eligible real skill is constructed and validated against the API's actual catalog validator by an offline test.

Reflex candidates contain resolved control holds, forward+jump, sneak, pitch/yaw, observed inventory slots, nearby entity targets, current raycast block clicks/digging, and valid adjacent placement faces. They carry target/equipment/slot/block preconditions, expire after 5 seconds, and have a 1500ms action-and-ACK deadline for 150–250ms holds. Both the API and actuator revalidate the relevant facts. Unrelated world sequence changes do not reject an otherwise valid candidate. A short dig records completion of the hold, not proof that the block was removed. Inventory is an observation; right-clicking a container makes its window contents observable, without pretending Mineflayer has a player inventory GUI.

## Same-bot capture

`imageCapture.ts` creates a lazy, private headless Prismarine renderer of the already connected bot's world. It creates no second Minecraft connection or HTTP viewer. Geometry must settle; render and JPEG encoding occur in the same turn, following the shared vision benchmark capture method. Images are 512×288, bounded to 512KiB, transient and never journalled by the body. Cancellation discards late pixels.

Stock Prismarine Viewer 1.33.0 aliases 1.21.11 to 1.21.4, which is unsafe for block state IDs. The adapter rejects that mismatch. For 1.21.11, prepare a separate exact-version renderer artifact with matching `minecraft-assets` already available on disk:

```sh
node scripts/prepare-common-fca-renderer.cjs 1.21.11 /absolute/new/renderer-directory /absolute/path/to/minecraft-assets
```

Set `MINEBOT_COMMON_FCA_RENDERER_DIR` to that output directory. The script never modifies installed dependencies; it generates matching textures/block states and corrects the vertical range and section indices for negative Y. Rendering additionally requires the existing headless GL/canvas runtime to be available. No actual frame, game-world run, renderer preparation or latency measurement was performed here; image-source and cancellation behavior were verified with fake renderer sessions. Do not claim a measured reflex latency from these offline tests.

## Offline verification

Use Node 22.21.1 and an isolated checkout. Existing dependency directories can be linked read-only, with Vitest caching disabled. Supply synthetic credentials solely to satisfy legacy module configuration; tests do not call a model or connect a world.

```sh
cd backend
OPENAI_API_KEY=offline-not-used MONGODB_URI=mongodb://127.0.0.1:27017/offline-not-used NODE_OPTIONS=--max-old-space-size=2048 node ../node_modules/vitest/vitest.mjs run tests/unit/commonFcaControl.test.ts tests/unit/commonFcaNative.test.ts tests/unit/commonFcaPrimitives.test.ts tests/unit/commonFcaCatalog.test.ts tests/unit/minebotSkillAgentCompanionChat.test.ts tests/unit/minebotCompanionBody.test.ts tests/unit/minecraftCompanionBody.test.ts tests/unit/minecraftActionExecution.test.ts --maxWorkers=1 --minWorkers=1 --cache=false
```

For the real cross-repository JSON protocol test, create a fresh `/tmp/shannon-fca-api-wire/src` directory and copy these unmodified files from the matching Shannon API `services/api/src`, preserving paths:

- `contracts/bodyControlContract.ts`
- `contracts/minecraftControlContract.ts`
- `surfaces/minecraft/minecraftControl.ts`
- `surfaces/minecraft/minecraftControlValidation.ts`
- `surfaces/minecraft/store/minecraftControlStore.ts`

Then add `FCA_API_WIRE_ROOT=/tmp/shannon-fca-api-wire` to the environment and include `tests/unit/commonFcaApiWire.test.ts` in the command. This test runs the actual body poller through the actual API poll/store/validation code: skill → stop → capture → reflex → release, exact receipts, no effect replay, and no persisted pixels. The actual catalog test also validates all offered schemas with the API validator when this environment variable is present. Without that optional fixture directory, the wire test is skipped.

### Recorded validation

The isolated body branch was verified on 2026-10-09 with Node 22.21.1: **9 files / 93 tests passed**, including the real API wire fixture, exact release-session/task-state propagation, shared body presence, read-only capture during a safety action, cancellation held beyond 15 seconds, and cleanup racing a new safety owner. Three additional regressions first reproduced a late capture/query/physical receipt clearing a failed-cleanup hold, then passed with the hold preserved until confirmed cleanup. All **83** real native InstantSkill constructors loaded; **77** eligible schemas passed the API's actual catalog validator. `git diff --check` and the renderer preparation script's syntax check also passed.

Targeted `tsc --noEmit` did not pass globally. It reported only two unchanged errors: `InstantSkillTool.ts:13` (`TS2589`, deep LangChain/Zod type instantiation) and `CustomBot.ts:2` (`TS2305`, the installed `mineflayer-cmd` declaration has no `CommandManager` export). A separate check rooted only at those existing files reproduced the same two diagnostics. No new body-adapter diagnostic remained. This is an explicit typecheck limitation, not a claim of a clean full-backend build.

Separately, the full backend conversion completed with exit 0 using `tsc -p tsconfig.json --noCheck --outDir /tmp/shannon-fca-body-transpile.Dwvdxg --incremental false --sourceMap false` from the isolated checkout's `backend/` directory, with Node 22.21.1 and a 4096MiB heap. Generated output stayed in that dedicated temporary directory; shared dependencies and production files were not changed. This verifies transpilation only and does not resolve or bypass the recorded normal typecheck diagnostics.
