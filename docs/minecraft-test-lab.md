# Minecraft Shannon test lab

> Status: command-oracle foundation, destructive work trial, and practical coverage for all 93 currently loaded Minebot skills implemented and exercised on Shannon-dev. Progressive multi-step evaluation is documented in [minecraft-progressive-evaluation.md](minecraft-progressive-evaluation.md). Shannon-prod is not part of this test path.

## Purpose

Minebot must not pass a test merely because a skill returned `success: true` or because an LLM said the task looked complete. The test lab separates three kinds of evidence:

1. **Server-authoritative command assertions** decide automated pass/fail.
2. **Mineflayer observations and cognition telemetry** explain how Shannon reached the result.
3. **Minecraft client screenshots/video** are supplemental evidence for animation, orientation, timing, and other qualities that commands cannot express well.

The first layer is the gate. Visual inspection can find additional defects, but it cannot turn a failed command assertion into a pass.

## Implemented architecture

```text
isolated Minecraft server (fresh world, non-production port)
       │
       ├─ setup commands: /fill, /tp, /clear, /give, ...
       │       └─ private tellraw barrier proves command ordering
       │
       ├─ Minebot skill or cognition action
       │
       └─ server assertions
               ├─ /execute if|unless block ...
               ├─ /execute if|unless entity ...
               ├─ /execute store result score ... data get|clear 0
               └─ PASS/FAIL tellraw marker → JSON report
```

`MinecraftCommandOracle` converts a small typed assertion language into Minecraft commands. It sends both the positive and inverse predicate with unique private `tellraw @s` markers. A missing marker is a test infrastructure error, not an assertion failure. Scoreboard-backed queries use the private objective `sh_test`.

The oracle is integrated with `SelfTestRunner`. A JSON suite opts in using `"commandOracle": true` and adds `assertions` to each case. Existing suites keep their previous behavior.

## Supported assertions

| Type | Server evidence | Typical use |
|---|---|---|
| `inventory_count` | `clear @s <item> 0` stored in scoreboard | exact/minimum collected or crafted items |
| `health_between` | entity `Health` NBT stored at ×100 | damage, healing, survival |
| `food_between` | entity `foodLevel` stored in scoreboard | eating and starvation behavior |
| `position_within` | selector distance from an exact coordinate | navigation and retreat arrival |
| `block_at` | `execute if block` | mining, placement, construction |
| `equipped_item` | `execute if items entity` | main/off-hand, armor, and reflex equipment |
| `entity_nearby` | entity selector around the bot | combat clear, avoidance, target presence |
| `dimension` | `execute if dimension` | portal and recovery flows |
| `gamemode` | entity selector gamemode predicate | deterministic setup validation |
| `entity_count` | fixed-centre tagged entity selector, scoreboard result | distinguish escape from defeating enemies |
| `gamerule` | query stored in scoreboard | verify actual environment settings |
| `difficulty` | difficulty query stored in scoreboard | verify Peaceful/Normal/Hard rather than assuming setup succeeded |

Resource locations are validated before interpolation. Test setup also remains restricted to an explicit allowlist (`tp`, `give`, `clear`, `time`, `weather`, `difficulty`, `gamemode`, `effect`, `summon`, `kill`, `fill`, `setblock`, `item`, `gamerule`, `experience`, and `damage`).

## First executable suite

`backend/saves/minecraft/self_test_cases/command-oracle-smoke.json` creates an 11×11 stone pad, teleports the test bot to it, resets the bot, and grants exactly three iron ingots. It then executes the real `get-position` and `check-inventory-item` skills while the server independently checks:

- position near `(0, 100, 0)`;
- stone at `(0, 99, 0)`;
- overworld and survival mode;
- health 20 and food 20;
- exactly three iron ingots;
- no zombie within eight blocks.

From an already-running Shannon dev bot, run it in Minecraft chat:

```text
..test command-oracle-smoke
```

Do not add `--fix` during evaluation. Automatic code repair is a separate, explicitly reviewed activity.

## Standalone probes

All three probes require an **isolated loopback server**, a non-production port, offline test identity `ShannonProbe`, and operator permission for that identity. They refuse known shared ports unless an explicit override is provided.

Cheap server/command gate, with no LLM credential or call:

```bash
cd backend
MINECRAFT_PROBE_PORT=25577 npm run minebot:command-probe
```

Actual `SelfTestRunner` + real read-only skills + command assertions:

```bash
cd backend
MINECRAFT_PROBE_PORT=25577 npm run minebot:self-test-probe
```

This entrypoint deliberately registers only `get-position` and `check-inventory-item`, permits only `command-oracle-smoke`, disables auto-fix, and does not start the full Shannon runtime. It is the preferred first E2E gate after unit tests.

Destructive work trial using the production movement, placement, mining,
crafting, and furnace skills:

```bash
cd backend
MINECRAFT_PROBE_PORT=25577 \
MINECRAFT_PROBE_TIMEOUT_MS=180000 \
npm run minebot:work-task-probe
```

`minecraft-work-task-live-probe.ts` builds a flat arena, supplies only an iron
axe, stone pickaxe, one coal, two cobblestone, and a furnace, then runs four
progressive levels:

1. place one cobblestone at an exact supported coordinate;
2. walk to and chop a three-block oak trunk;
3. cross the arena, select the correct tool, and mine three iron ore;
4. turn the harvested resources into planks, sticks, and a crafting table,
   place the table, smelt the iron, and craft an iron pickaxe.

Every material and block outcome is checked independently through the command
oracle. The report uses the `MINECRAFT_WORK_TASK_REPORT` prefix so it can be
extracted from normal skill logs.

### First destructive trial result (2026-09-28)

The corrected second trial completed in 63.386 seconds. Levels 2–4 passed all
server assertions: three logs were harvested in 4.196 seconds, three iron ore
were harvested in 17.983 seconds, and the harvested-resource-to-iron-pickaxe
chain completed in 34.930 seconds. The furnace output wait accounted for
30.852 seconds of the advanced level. Health remained exactly 20, the crafting
table and furnace were present, raw iron was exhausted, and an iron pickaxe was
in inventory.

Level 1 failed reproducibly in two trials. `place-block-at` timed out after
about five seconds waiting for `blockUpdate:(2, 100, 0)`; the server confirmed
the target was still air and both cobblestone remained in inventory. This is a
real failing case, not converted to a pass. In the same run, placing the
crafting table at `(0, 100, 2)` succeeded in 64 ms and was confirmed by the
server, which narrows the defect to the initial placement context or coordinate
handling rather than all block placement.

This paragraph records the first trial only. The later complete campaign passed
`place-block-at` after the shared modern item-use/rotation fixes; it supersedes
the first-trial defect status.

The first advanced attempt used the default `withdraw-from-furnace` slot
(`all`) and therefore correctly took the unsmelted input and fuel back out. The
trial was corrected to request `slot="output"`, matching the skill contract;
the corrected run waited for completion and passed. This was a harness error,
not recorded as a product defect.

## Complete practical skill campaign

`minecraft-practical-skills-live-probe.ts` loads the same Mineflayer plugins
and the complete skill catalogue directly from source: 74 `InstantSkill`
implementations and 19 `ConstantSkill` implementations. It does not start the
LLM graph, MongoDB, Discord, or the Shannon service. It also connects a second
non-operator test player, `ProbeActor`, for speaker- and player-facing reflexes.

Run one or more scenarios with comma-separated suite names:

```bash
cd backend
MINECRAFT_PROBE_PORT=25577 \
MINECRAFT_PRACTICAL_SUITES=practical-resource-production,practical-combat-survival \
npm run minebot:practical-skills-probe
```

The runner rejects an empty suite list, non-`practical-*` names, known shared
ports, and non-loopback servers unless the caller explicitly opts into a shared
server. An empty or missing suite cannot produce `ok: true`. Automatic repair is
always off. Constant-skill fixture tokens resolve a nearby entity or a real
Mineflayer `Vec3` block lookup rather than passing JSON-shaped stand-ins.

### World used for the campaign

The 2026-09-28–29 campaign used a dedicated Fabric 1.21.11 server bound only to
`127.0.0.1:25577`, a fresh `practical_fix_world`, and a temporary directory
under `/home/azureuser/minecraft/`. `ShannonProbe` was the only operator;
`ProbeActor` was an ordinary player. Each case cleared inventory, effects,
non-player entities, and item drops, rebuilt a bounded stone arena, and
teleported the bot to a known coordinate. Resource, agriculture, construction,
storage, workstation, and survey cases used peaceful difficulty and daytime.
Combat cases requested normal difficulty and midnight; natural mob spawning was
intended to be disabled. A later progressive investigation found that the old
`doMobSpawning` command is invalid on 1.21.11, so the historical claim that
spawning was disabled is **withdrawn**. Those old reports still record observed
skill outcomes, but do not establish that environmental control. The command
oracle now translates the three legacy spawning/time/weather rule names for
1.21.11+, and the progressive runner reads all settings back before work.
Constant
reflex cases changed time, water, health, items, and controlled entities per
trigger.

The server command barrier proves command processing order, **not command
success**. Query assertions reset their scoreboard to an impossible sentinel,
so an invalid query cannot reuse a prior zero and falsely pass. Setup commands are
paced by 250 ms and state-changing setup may declare `setupSettleMs`. Assertions
normally wait 350 ms after the skill returns; a case may declare
`postActionSettleMs` when the server has a known lifecycle delay, such as a mob's
death animation. These waits are part of the oracle, not changes to production
skill timing.

### Scenario inventory and latest results

| Suite | Practical job | Unique skills | Final result | Duration | Evidence note |
|---|---|---:|---:|---:|---|
| `practical-worksite-survey` | inspect a worksite, inventory, routes, blocks, structures, entities, and basic movement | 29 | 29 / 29 | 39.583 s | command assertions plus skill results |
| `practical-resource-production` | chop logs, mine iron, craft, smelt, and produce/use an iron pickaxe | 10 | 10 / 10 | 95.471 s | exact materials, blocks, and furnace output |
| `practical-storage-logistics` | chest deposit/withdraw, drop/pickup, equipment, food, and bucket interaction | 10 | 10 / 10 | 111.578 s | inventory, equipment, water-source, and movement checks |
| `practical-agriculture` | till, plant, fertilize, harvest, and breed livestock | 5 | 5 / 5 | 15.914 s | block growth/harvest and entity checks |
| `practical-combat-survival` | melee, continuous combat, combat controller, bow, fleeing, and escort following | 7 | 7 / 7 | 105.436 s | controlled enemies, inventory, and server entity checks |
| `practical-construction-travel` | wall, tower, stair mine, portal build, sleep, and dimension travel | 6 | 6 / 6 | 82.620 s | block layout and dimension transition checks |
| `practical-workstations` | enchant, brew, anvil repair, stonecut, and villager trade | 5 | 5 / 5 | 61.979 s | real 1.21.11 containers and protocol actions |
| `practical-constant-reflexes` | all 18 event/reflex skills, including a second player | 18 | 18 / 18 | 175.346 s | controlled trigger fixtures and state assertions |
| `practical-exploration-control` | fishing, external lookups, and constant-skill switches | 7 | 7 / 7 runner outcomes | 69.079 s | fishing/projectile behavior plus dependency-path observations |

The suite definitions cover all 93 loaded skill names: 74 instant skills and 19
constant skills. There are 97 per-suite skill outcomes because four skills are
intentionally exercised in more than one scenario; the union is 93, with zero
catalogue omissions. The two external dependency observations described below
are runner passes under `expectedOutcome: either`, not claims that the absent
services themselves worked.

The passing integrated reports on Shannon-dev are, respectively:
`dfdbbbee`, `3aa62de7`, `a269d15a`, `8d49928c`, `ee88d5e3`,
`daf7b53c`, `191977a0`, `8626aa39`, and `fe8932cb` (the suffix of each
JSON report filename under `backend/saves/minecraft/self_test_reports/`).

### Findings that passed with strong practical evidence

- The complete log-to-iron-pickaxe production chain passed. `mine-block` now
  collects each batch's drops before moving to the next target, so later ore
  batches do not abandon earlier drops.
- Crop interaction, food consumption, bucket pickup, chest logistics, wall and
  portal construction, stair mining, sleeping, fishing, bow fire, melee, fleeing,
  following, breeding, item pickup, and all five workstation jobs produced
  observable Minecraft outcomes.
- The worksite survey passed all 29 query and bounded-control groups. The
  resource, agriculture, storage, construction, workstation, combat, and reflex
  suites all passed their final clean reruns.
- Constant automatic shooting is now a registered skill and its switch plus an
  actual arrow-consumption/shot case pass.

### Defects corrected by the campaign

- Modern 1.21.11 item-use rotation was centralized in `activateItemFacing`,
  fixing crop interaction, food, bucket, bow, and related right-click behavior.
- Portal construction now uses the intended origin/orientation, and portal entry
  no longer calls CommonJS `require` from ESM.
- Fishing uses a contained source-water pond and aims without the excessive
  downward compensation that made the float miss valid water.
- Bow shooting and combat use the modern rotation path. The independent test
  actor is kept outside the firing lane so it cannot absorb the arrow.
- Enchanting, brewing, anvil repair, and stonecutting now use Mineflayer's real
  container model and the required 1.21.11 protocol operations. Villager lookup
  handles an omitted ID and current profession metadata.
- Constant shield, hostile escape, food, and target shooting behavior were
  corrected and verified. The test runner also supports deterministic setup and
  per-case post-action settling.

The final full-rerun fixture fixes matter too: dropped dirt is summoned far
enough away that the bot cannot auto-collect it before `pickup-nearest-item` is
called; the hunger fixture drains a possible maximum persisted saturation level;
and `combat-engage` waits 1.2 seconds before checking that the server removed the
dead zombie. These prevent false negatives without weakening the assertions.

`get-advancements` correctly exposed that the isolated server had no Shannon UI
Mod HTTP endpoint at `localhost:8081`. `investigate-terrain` reached its model
call and received the expected 401 from the deliberately fake offline key.
Neither is a functional pass; they are confirmed external-dependency paths and
must be rerun with the real UI Mod and approved model credentials respectively.

Command gate plus the GPT-5.6 Luna/Jev reflex and critic path:

```bash
cd backend
MINECRAFT_PROBE_PORT=25577 \
MINECRAFT_COGNITION_PROVIDER=openai \
npm run minebot:cognition-probe
```

The cognition probe is successful only when all command assertions pass and both classifiers return a fresh remote result. A local fallback is useful operationally but does not count as a successful live provider test. Set `MINECRAFT_PROBE_TIMEOUT_MS` higher on a slow network; the default is 45 seconds.

The JSON output includes the full expected assertion, pass/fail, duration, observed world frames, action receipt count, and classifier source/latency. Preserve this output with the test run record rather than inferring success from terminal text.

## Isolated server contract

Use a newly generated world for every destructive or long-running scenario. The server must satisfy all of the following:

- loopback-only or otherwise network-isolated;
- a dedicated non-production port (25577 in the current dev recipe);
- `online-mode=false` only inside that isolated environment;
- `enforce-secure-profile=false` for the offline probe identity;
- `spawn-protection=0`, `allow-flight=true`, short view/simulation distance;
- `ShannonProbe` is level-4 operator; no human or production bot identity is reused;
- no production world, player data, mods directory, or save directory is writable through symlinks;
- the process, generated world, and temporary directory are stopped and removed after the run.

It is acceptable to symlink immutable Fabric runtime libraries and the launcher JAR from the dev server template. Do not symlink `world*`, `server.properties`, `ops.json`, `mods`, logs, or player data.

## Scenario design

Each scenario should have four explicit parts:

| Part | Meaning |
|---|---|
| Arrange | commands construct the smallest deterministic world state |
| Act | one skill, one reflex event, or one bounded goal is executed |
| Assert | server commands verify state changes and safety invariants |
| Explain | receipts, world frames, decisions, and optional client video diagnose the outcome |

Recommended next suites, in order:

1. **Placement regression:** preserve the failing `(2, 100, 0)` fixture and vary only staging position, view direction, and settling delay to localize the defect.
2. **Movement and obstacle:** build a wall/corridor, run navigation, assert arrival, health, and unchanged protected blocks.
3. **Emergency reflex:** summon one controlled hostile, reduce health, inject the event, assert separation/health and record reflex latency; always retain deterministic containment.
4. **Blocked-plan recovery:** make the direct route impossible, require an alternate subtask, and assert the final world state plus bounded retries.
5. **Long-horizon goal:** use checkpoints for every material/subtask so failure localizes to the first broken invariant instead of only the final goal.

For stochastic behavior, define a trial count and threshold before running the test. Never repeat until a pass appears.

## Visual validation

Open the Minecraft client only after the command gate is green. Use screenshots or short recordings for questions such as:

- Did movement look stuck, jittery, or indecisive despite eventually arriving?
- Did Shannon face the relevant player/block/entity?
- Was emergency behavior prompt enough to feel reactive?
- Did replanning cause visible thrashing or repeated destructive actions?

Record the server assertion report and visual finding together. A visual defect becomes a reproducible scenario by adding the closest measurable invariant or telemetry event; it should not remain screenshot-only if commands can express it.

## Safety and cleanup checklist

Before a run:

- confirm the target host and port;
- confirm the world path is temporary and not a symlink to a save;
- confirm the test username and operator UUID;
- keep `autoFix` off;
- capture the Shannon-dev Git status.

After a run:

- stop the server gracefully with `stop`;
- confirm the port is closed and no probe process remains;
- remove only the exact temporary directory created for the run;
- retain JSON reports, failing seeds/setup, and relevant screenshots;
- confirm Shannon-prod and its world files are unchanged.

## Current limits

- The server command channel uses the bot's operator chat path. A later RCON/control-process adapter could remove chat-rate coupling, but is not required for the current isolated test server.
- The practical campaign invokes every current skill, but several constant-skill assertions still measure only a safe postcondition rather than the intended reaction. Catalogue coverage and behavioral evidence must remain separate metrics.
- Combat, agriculture, workstation, fishing, and portal defects are now reproducible. Blocked-plan recovery, multi-route replanning, and a genuinely long-horizon autonomous goal remain open.
- Advancement and LLM terrain-analysis capability cannot be certified by the offline isolated probe because their UI Mod and model-provider dependencies are deliberately absent.
- Client visuals are still a human/Codex inspection step; they are not automatically scored.
- Passing an isolated test is necessary but not sufficient for a production release.
