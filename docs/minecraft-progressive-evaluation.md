# Minecraft progressive evaluation

Owner: Minecraft Shannon / Minebot. Scope: isolated Shannon-dev source skills;
no Shannon-prod writes, full Shannon service, MongoDB or LLM calls.

## Fixed difficulty ladder

Each trial starts with a fresh offline bot connection, clears inventory/effects
and entities, rebuilds the work area, and reads game rules, difficulty and game
mode back from the server. The world seed is 9272026. It is a fresh loopback-only
Fabric 1.21.11 world, not a copy of a user's save. Blocks and materials are real;
only fixture setup and independent assertions use operator commands.

| Job | Level 1 | Level 2 | Level 3 |
|---|---|---|---|
| Resource production | 6-block resource distance; supplied axe/pickaxe/fuel/furnace; chop logs → craft → mine 3 iron → smelt → iron pickaxe | 18-block distance, wall detour, weaker axe; mine stone and craft/place own furnace | 24-block distance, two detours, night/rain; start without tools, make wooden then stone pickaxe, mine own fuel, make furnace and iron pickaxe |
| Food production | 3 wheat plants; till → plant → fertilize → harvest → bread | 6 plants farther away behind detour; harvest, replant and make 2 bread | 9 plants at night/rain; first make crafting table and hoe from logs; replant, make 3 bread, actually get hungry and eat |
| Combat | Normal, 1 live-AI zombie; diamond sword, iron chest/legs and shield | Normal, 2 live-AI zombies; iron sword, same armour/shield | Hard, live-AI zombie + husk + skeleton, obstacle, night/rain, natural spawning enabled; iron sword, same armour/shield |

There is no resistance buff, forced enemy low health or `NoAI` in combat.
Production/agriculture disable natural spawning to isolate their own constraints;
they are **not** mixed work-under-attack tests. Combat retains bounded arena walls.
The arena has a bedrock support layer and a cobblestone surface. Stone is an
explicit outcrop, not the bot's only support floor.

The first crop is deliberately set to age 3 solely for a negative test: harvesting
must fail and leave it intact. Positive growth is real fertilization with at most
4 bone-meal applications per plant; maturity must be age 7 before harvesting.

## Pass/fail and evidence

- A requested skill outcome must match its contract and independently meet
  server assertions for inventory, exact block state, equipment or food.
- A player death is a failure even if automatic respawn restores HP to 20.
- Combat must observe real hostile death events and zero remaining tagged targets
  at the fixed arena centre. Running out of sensor range is not enemy defeat.
- Snapshots record HP, food, position, inventory, enemies and world time/weather
  every 250 ms. This sampling is diagnostic; event-based death detection is the
  survival gate.
- Discovery runs and post-fix cohorts remain separate. The default cohort runs
  each job/level twice and requires 100% observed passes, not retry-until-green.
  Two observations do not prove a statistical reliability guarantee.
- Two independent one-repeat cohorts on separate isolated worlds/ports can also
  provide two observations per cell without sharing bot/world state. Record both
  complete summaries, their ports and identical selected-source fingerprints.
Concurrent cohorts are correctness tests, not isolated latency benchmarks.

Run on the VM, after confirming the isolated port/session are free:

```bash
cd /home/azureuser/Shannon-dev/backend
node scripts/minecraft-isolated-lab.mjs
MINECRAFT_PROGRESSIVE_REPEATS=2 npm run minebot:progressive-probe
```

The launcher prints the exact temporary directory. Shut down the server with
`stop` after preserving reports/logs; remove only that verified temporary world.
JSON evidence lives under ignored `backend/saves/minecraft/progressive_reports/`;
the runner emits `MINECRAFT_PROGRESSIVE_REPORT` for its complete cohort summary.
Jobs/levels can be selected with `MINECRAFT_PROGRESSIVE_JOBS` and
`MINECRAFT_PROGRESSIVE_TIERS`. There is no full-service startup or auto-fix.
An additional loopback lab uses `MINECRAFT_LAB_PORT=25578` for the launcher and
`MINECRAFT_PROBE_PORT=25578` for the runner; known shared ports are refused.

Infrastructure detail for the recorded paired cohorts: port 25577 was launched
before the generator-settings repair, with `{}` and a server `No key layers`
fallback warning. Port 25578 used explicit flat layers/biome. Both use the same
seed and reconstruct/read back the bounded test arena before each trial; their
underlying generated terrain must not be described as bit-identical. The updated
launcher always supplies explicit settings. The VM has 2 CPUs and about 16 GB RAM;
each test JVM is capped at 2 GB. Concurrent timings include resource competition,
connection/import/fixture work and game mechanics, not just action latency.

## Regressions found during discovery

1. Crop maturity compared a numeric block ID with 7, which selects the wrong age
   threshold for several crops. More importantly, live Prismarine integer states
   were strings, causing the numeric-only guard to be skipped entirely. The skill
   now normalizes the live age value, uses the versioned registry's age range,
   and refuses unknown maturity. Regression fixtures include string-valued ages.
2. Combat interpreted an empty entity scan immediately after player death and
   automatic respawn as annihilation. Death is now latched for the whole fight;
   escape, target loss and observed kills are distinct results.
3. Ranged-enemy shield priority could indefinitely preempt an available melee
   strike. Cooldown/ranged protection remains, but an available close strike can
   execute; it explicitly releases the shield first. Shield use also sends the
   correct modern packet rotation facing the threat. A shield-release decision
   now executes its intended ready strike in the same tick rather than spending
   an additional exposed tick before attacking.
4. Armour estimates gave an iron chestplate + leggings 5 points instead of 11.
   Slot-specific vanilla values now describe the equipment accurately; no new
   threat thresholds or scenario-specific fighting rules were introduced.
5. Legacy gamerule names silently failed on 1.21.11. The oracle translates them,
   reads the settings back, and protects query scores from stale-value passes.
6. Named item pickup matched `wheat_seeds` for a `wheat` request and returned
   success for any inventory increase. Known item IDs now match exactly, native
   dropped-item decoding is preferred, and the requested item itself must increase.
   Fuzzy lookup remains available for queries that are not known item IDs.
7. Nested drop-collection/pathfinding could mine another target, collecting both
   logs but reporting only one direct dig. `mine-block` now counts unique actual
   `diggingCompleted` targets, including nested movement, and removes the listener
   on every exit. It does not infer excavation count from multi-drop item yields.
   Repetition also exposed a batch target becoming out of reach after the previous
   drop pickup. The skill rechecks reach and moves again, and rescan can requeue a
   still-existing failed target instead of excluding every previously seen position.
   The three-consecutive-failure bound also applies across batches, preventing
   requeued permanently inaccessible targets from creating an endless loop.
8. Item-pickup pathfinding excavated farmland, collecting the wheat but destroying
   the field before replanting. Movement now preserves the pathfinder's default
   unbreakable set and protects agricultural blocks from incidental route digs.
   Fractional drop heights on farmland/slabs now resolve to the walking node
   above that solid surface rather than a goal inside the support block.
   Explicit harvesting/mining and ordinary obstacle excavation remain enabled.
9. `auto-eat` could resolve its consume task on an unrelated delayed held-item
   update, return after 33 ms and log completion before the real eating animation
   finished. The food/item assertions correctly failed, while snapshots later
   showed the meal completing. The skill now waits for observed food recovery
   with a bounded timeout and interruption/death checks; assertions stay unchanged.
10. Multi-craft window updates arrived incrementally: the server made 3 bread but
   the skill reported 2 after a fixed 400 ms wait. A bounded 2-second wait alone
   still reported 2 in a later full cohort. Mineflayer closes/copies the table
   inventory and ignores later packets for that closed window ID; waiting cannot
   refresh that stale copy. When table output appears incomplete, the skill now
   requests a fresh table snapshot through normal game interaction and closes it
   to synchronize inventory. No operator query is added to production crafting.
   This also applies to a craft that throws after partial execution. A bounded
   fallback preserves genuine partial/inventory-full/dropped-output recovery.
11. Harness-only errors: initial teleport before constructing the floor; excavating
   the thin support layer above a large drop; placing a crafting table after
   logging without walking back into placement range. These are fixture fixes,
   not product improvements, and old discovery passes are not promoted.

## Preserved pre-final evidence

The initial fixed-source paired cohort passed **16/18**, not 18/18. Both failed
cells were agriculture level 3, with different causes. These complete reports
remain in the evidence directory and are not replaced by later successful runs.

| Campaign (UTC) | Port | Selected-source SHA-256 | Result |
|---|---|---|---|
| `2026-09-28T16-26-03-424Z` | 25577 | `dbc1fb61995f964ccbcd14ce1484848f7766bf527216857c14cc5a7bde2cad79` | 8/9; eating returned before observed completion |
| `2026-09-28T16-27-33-842Z` | 25578 | same as above | 8/9; second log was no longer in reach after drop pickup |

After the reach/eating fixes, level-3 agriculture was independently replayed on
both worlds and passed **2/2**. Reports `2026-09-28T16-44-52-105Z` (25577) and
`2026-09-28T16-44-54-112Z` (25578) share selected-source SHA-256
`4abc1c87638ab7d6bf5d11e71735ddf0b483155443f54f0e515f0b9a33604c47`.
These targeted replays are not a complete new 18-trial cohort. They additionally
exposed the inaccurate incremental craft-count report described above.

## Full paired cohort after reach/eating fixes

The complete fixed-source cohorts `2026-09-28T16-49-24-407Z` (25577) and
`2026-09-28T16-49-27-579Z` (25578) passed **18/18 world-outcome trials**, with
zero player deaths. Both share selected-source SHA-256
`2f420f0266c651867cefc27cd28c7e205810527848a09ed1ba1421403edc04bf`.
There were no source/criterion changes or retries within these cohorts.
All 474 recorded server assertions passed. Both level-3 combat trials observed
one zombie, one husk and one skeleton death event, then independently verified
zero remaining tagged targets. Level-3 samples confirm midnight and rain.

| Job / level | Passes | Whole-trial seconds A / B | Minimum HP A / B |
|---|---:|---:|---:|
| Production 1 | 2/2 | 118.359 / 118.471 | 20 / 20 |
| Production 2 | 2/2 | 156.246 / 173.062 | 20 / 20 |
| Production 3 | 2/2 | 220.399 / 244.928 | 20 / 20 |
| Farming 1 | 2/2 | 35.142 / 32.589 | 20 / 20 |
| Farming 2 | 2/2 | 63.798 / 66.454 | 20 / 20 |
| Farming 3 | 2/2 | 136.510 / 133.010 | 19 / 19 |
| Combat 1 | 2/2 | 24.550 / 24.618 | 18.14 / 18.14 |
| Combat 2 | 2/2 | 30.736 / 30.789 | 18.14 / 17.28 |
| Combat 3 | 2/2 | 46.637 / 40.046 | 11.42 / 9.77 |

These cohorts still exposed the craft-count **narration** defect (world inventory
assertions passed). The fresh-table synchronization was added subsequently, so
the 18/18 result must not be relabelled as a full cohort of that newer source.
Post-synchronization verification is recorded separately below.

## Post-synchronization targeted verification

Selected-source SHA-256
`3e4abe8fc6bd55114077f5e2b278667fea597cf82a40dd28eb4150d0a3e2fb29`:

| Campaign (UTC) | Port | Selection | Passes | Whole-trial seconds |
|---|---:|---|---:|---|
| `2026-09-28T17-11-47-807Z` | 25577 | Farming 3, two fixed repeats | 2/2 | 141.749 / 138.078 |
| `2026-09-28T17-11-50-094Z` | 25578 | Production 1, two fixed repeats | 2/2 | 103.135 / 122.797 |

Both agriculture repeats actually took the fresh-table synchronization path and
reported **3 bread**, then independently passed replant/inventory/food/survival
assertions. Bread crafting completed in 968 / 937 ms, rather than the ineffective
2-second wait followed by an inaccurate partial-count narration. Production also
retained normal table crafting. These **4/4** targeted trials are not a complete
18-trial rerun of the newer source.

A subsequent type check exposed the public Window type's `string | number` union.
The last narrow change rejects unexpected numeric types before string operations;
it does not change the validated 1.21.11 string-window path. Validation of this
last guard is reported separately from the fixed-source campaigns.

Final guard source SHA-256:
`a62e3a343db9c9c4c97da83e14461bff8a822cc58855d997c2ec60492948d4b5`.
Five focused unit files passed **46/46** tests, including maturity/packet-shape,
inventory identity, farmland preservation, death/escape, combat shield/cooldown,
mining reach/count/failure bounds, delayed food/crafting and fresh-window recovery.
The numeric-window guard has its own refusal/partial-preservation regression.
Focused TypeScript checking of the runner and affected skill/combat/oracle paths
passed; this is not a claim that a full backend type check/build was run.

`shannon-progressive-craft-guard-smoke.log` records a successful final-source real
bread craft, exact server inventory count 3, accurate narration and the valid
string-window refresh path. That narrow protocol smoke explicitly invoked the
refresh helper after the public craft; it is not an additional end-to-end job.

Complete summaries/trial JSON, paired runner logs, targeted logs, diagnostic/
final smoke logs, unit/type-check logs and both server logs/configurations are
preserved in `backend/saves/minecraft/progressive_reports/` on the VM and local
checkout. Failed discovery/pre-final trials remain there. Generated test worlds
are disposable; the reusable launcher/fixtures recreate them.

Both generated lab directories (`progressive-lab-Hiefe1`, `progressive-lab-vpp15x`)
were removed only after graceful `stop`, completed world saves, closed loopback
ports and byte-identical archived log/config checks. No user world/template assets
were removed. Shannon-prod remained clean at
`5412c1f1c0ae6b121cba65898cd8c702c3d3e2a9`; no full Shannon runtime was started.

## Execution-efficiency follow-up

The subsequent sequential performance campaign and its retained failures are
recorded in [Minecraft execution efficiency](minecraft-execution-efficiency.md).
On the same explicit-settings loopback lab, motor source `63e9ba12…` passed
17/18, not 18/18: all resource/farming cases and five combat cases passed; one
Hard combat case safely escaped after one kill and failed the unchanged
three-kill/remaining-enemy oracle. Resource-production whole-trial means were
22.0–26.0% shorter than the one-repeat sequential baseline, while farming 1/2
were slightly slower. These are small-sample observations, not universal speed
or reliability claims. The linked document separates subsequent shield-facing
and native-furnace-progress refinements from that frozen motor-source cohort.

## Scope limits

These trials execute production skill implementations in scripted multi-step
jobs. They do not certify the LLM planner, Jev, execution critic, blackboard
feedback loop, autonomous long-horizon replanning, or all 93 skills under hard
conditions. No Minecraft client visual inspection is implied by command logs.
Further ladders should add dynamic route changes, tool breakage, fuel shortage,
inventory pressure, work interrupted by real enemies, and natural terrain only
after the bounded prerequisites have trustworthy results.

## Shared knowledge return: TI-KNOWLEDGE-MINEBOT-ORACLE

Requesting owner: Minecraft Shannon (legacy backend). Destination: Syzygy
knowledge hub / evaluation owners. Status: reusable candidate, not a new suite-wide
standard. The shared hub and Apple Shannon repository were not changed here.

Reusable findings:

- Processing barriers and successful tool returns are not authoritative outcomes.
  Read configuration back and independently assert the intended world change.
- Clear query storage before each query; a failed command must not inherit an old
  zero and falsely prove absence, safety or a disabled setting.
- Track irreversible events over the entire job: a later healthy snapshot after
  respawn cannot undo a death, and losing a target from sensor range is not a kill.
- Match regression fixtures to observed runtime payloads, including string-valued
  integer block states and post-dig AIR events, instead of idealized mocks.
- Check downstream invariants: collecting food is insufficient if the collection
  path destroyed the reusable farm needed by the next subtask.
- Preserve discovery failures. Fixes, setup corrections, fixed-source cohorts and
  inference about general reliability must remain distinct evidence categories.

Evidence and limits are the fixed cohorts and regression checks recorded in this
document. Promotion requires the same fail-closed pattern in another execution
environment; this does not authorize production rollout or model autonomy.
