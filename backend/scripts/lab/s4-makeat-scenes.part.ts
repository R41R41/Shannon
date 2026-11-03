// ---- mc_make_at, the body's half: the act the head's purpose tool expands to (go to the table, craft), stopped five ways -----------------------------
// The head's `purposeHands` (minecraftLlmcPurpose.ts, branch claude/dragon-head-purpose) sends one act: hands [go {range 4, maxDig 0, maxPlace 0, onFail stop},
// craft {item, count, onFail stop, dependsOn [1]}], pre [[have ..., at feet r 0.25]], stopIf {hpBelow, hostileWithin}. The coordinator's rule (d40): after a
// reflex or a failure the body must start NO further hand of that act (0 continuations). Each case below says what stops it and counts the hands that ran
// after the stop. No head, no model.
function s4MakeAtAct(table: { x: number; y: number; z: number }, feet: { x: number; y: number; z: number }, stopIf: Record<string, number>, seconds = 30, count = 1) {
  return {
    hands: [
      { do: 'go', to: table, range: 4, seconds, maxDig: 0, maxPlace: 0, onFail: 'stop' },
      { do: 'craft', item: 'iron_pickaxe', count, onFail: 'stop', dependsOn: [1] },
    ],
    pre: [[{ k: 'have', item: 'iron_ingot', n: 3 * count }, { k: 'have', item: 'stick', n: 2 * count }, { k: 'at', x: feet.x, y: feet.y, z: feet.z, r: 0.25 }]],
    stopIf,
    why: 'S4 make_at: go to the table and craft',
  };
}
const s4Pickaxes = async (): Promise<number> => countServer('iron_pickaxe');

async function s4MakeAtCase(note: (text: string) => void, label: string, expectStopped: boolean, setup: () => Promise<{ table: any; feet: any; stopIf: Record<string, number>; seconds?: number; during?: () => Promise<void> }>) {
  await ask('difficulty normal'); await ask('gamerule doMobSpawning false'); await ask('gamerule spawn_mobs false');
  const prepared = await setup();
  const input = s4MakeAtAct(prepared.table, prepared.feet, prepared.stopIf, prepared.seconds ?? 30);
  if (prepared.during) setTimeout(() => { void prepared.during!(); }, 1500);
  const before = await countHeld('iron_pickaxe');
  // `pre` is a task-queue field the head checks before it sends the act (minecraftActContract.ts): the body's act schema does not take it
const result = await act(label, input.hands, (prepared.seconds ?? 30) + 10, { stopIf: input.stopIf, why: input.why });
  const after = await countHeld('iron_pickaxe');
  const statuses = result.lines.map(line => line.split(':')[0]);
  const crafted = after - before;
  const started = result.lines.filter(line => !/ skipped/.test(line.split(':')[0])).length;   // skipped = 未実行: the hand never started
  note(`make_at ${label}: ok ${result.ok}, stoppedBy ${result.stoppedBy ?? '-'}, hands ${JSON.stringify(statuses)}, hands started ${started}, pickaxes crafted ${crafted}, hp ${result.hp}`);
  return { label, expectStopped, ok: result.ok, stoppedBy: result.stoppedBy ?? null, statuses, started, crafted, wallMs: result.wallMs };
}
async function countHeld(name: string): Promise<number> {
  const items = (actor.inventory?.items?.() ?? []) as Array<{ name: string; count: number }>;
  return items.filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
}

scene('s4_makeat_body', 'mc_make_at, the body\'s half: the expanded act (go range 4 + craft, pre, stopIf) stopped by an unreachable table, a missing material, a hostile and low hp; hands started after the stop must be 0', async note => {
  const here = { x: Math.floor((sites.spawn as number[])[0]) + 40, z: Math.floor((sites.spawn as number[])[2]) + 40 };
  await placeActor('overworld', here.x, (sites.spawn as number[])[1] + 2, here.z, 20);
  await sleep(2000);
  const y = Math.floor(actor.entity.position.y);
  const feet = { x: Math.floor(actor.entity.position.x), y, z: Math.floor(actor.entity.position.z) };
  const table = { x: feet.x + 26, y, z: feet.z };   // far enough that the walk lasts several seconds: the injected hostile / damage (1.5 s in) lands in the middle of it
  const stage = async (items: Record<string, number>, withTable: boolean) => {
    await equip(items, { armor: 'iron' });
    await ask(`tp ${ACTOR} ${feet.x + 0.5} ${y} ${feet.z + 0.5}`);
    await ask(`kill @e[type=minecraft:zombie]`); await ask(`kill @e[type=minecraft:item]`);
    for (const command of [`fill ${feet.x - 3} ${y - 1} ${feet.z - 3} ${feet.x + 30} ${y - 1} ${feet.z + 3} minecraft:stone`, `fill ${feet.x - 3} ${y} ${feet.z - 3} ${feet.x + 30} ${y + 4} ${feet.z + 3} minecraft:air`]) await ask(command);
    if (withTable) await ask(`setblock ${table.x} ${y} ${table.z} minecraft:crafting_table`);
    await sleep(800);
  };
  const results: any[] = [];
  // 0: the plain case: the pickaxe is made (the control)
  results.push(await s4MakeAtCase(note, 'success', false, async () => { await stage({ iron_ingot: 3, stick: 2 }, true); return { table, feet, stopIf: { hpBelow: 6, hostileWithin: 6 } }; }));
  // 1: the table is walled in: go cannot reach it within its seconds; the craft must not start
  results.push(await s4MakeAtCase(note, 'unreachable_table', true, async () => {
    await stage({ iron_ingot: 3, stick: 2 }, true);
    await ask(`fill ${table.x - 1} ${y} ${table.z - 1} ${table.x + 1} ${y + 3} ${table.z + 1} minecraft:stone hollow`);
    await ask(`fill ${table.x - 3} ${y} ${table.z - 3} ${table.x + 3} ${y + 3} ${table.z + 3} minecraft:stone hollow`);
    return { table, feet, stopIf: { hpBelow: 6, hostileWithin: 6 }, seconds: 12 };
  }));
  // 2: no table at the cell (it vanished): go arrives, craft finds no table; no other table may be placed
  results.push(await s4MakeAtCase(note, 'table_gone', true, async () => { await stage({ iron_ingot: 3, stick: 2, oak_planks: 8 }, false); return { table, feet, stopIf: { hpBelow: 6, hostileWithin: 6 } }; }));
  // 3: a material is missing (the head's pre would refuse before sending; here the body gets the act anyway): go runs, craft fails, nothing else
  results.push(await s4MakeAtCase(note, 'material_missing', true, async () => { await stage({ iron_ingot: 2, stick: 2 }, true); return { table, feet, stopIf: { hpBelow: 6, hostileWithin: 6 } }; }));
  // 4: a hostile close at the start (stopIf hostileWithin already true): no hand
  results.push(await s4MakeAtCase(note, 'hostile_at_start', true, async () => {
    await stage({ iron_ingot: 3, stick: 2 }, true);
    await ask(`summon minecraft:zombie ${feet.x + 3.5} ${y} ${feet.z + 0.5} {NoAI:1b,Silent:1b,PersistenceRequired:1b}`);
    return { table, feet, stopIf: { hpBelow: 6, hostileWithin: 6 } };
  }));
  // 5: a hostile arrives while walking (spawned 1.5 s into the act): the walk stops, the craft must not start
  results.push(await s4MakeAtCase(note, 'hostile_arrives', true, async () => {
    await stage({ iron_ingot: 3, stick: 2 }, true);
    return { table, feet, stopIf: { hpBelow: 6, hostileWithin: 5 }, during: async () => { await ask(`summon minecraft:zombie ${feet.x + 4.5} ${y} ${feet.z + 1.5} {NoAI:1b,Silent:1b,PersistenceRequired:1b}`); } };
  }));
  // 6: low hp at the start (stopIf hpBelow above her health, kept as given): no hand
  results.push(await s4MakeAtCase(note, 'low_hp_at_start', true, async () => {
    await stage({ iron_ingot: 3, stick: 2 }, true);
    await ask(`damage ${ACTOR} 12 minecraft:generic`); await sleep(300);
    return { table, feet, stopIf: { hpBelow: 12, hostileWithin: 6 } };
  }));
  // 7: hp falls during the walk (damage 1.5 s in)
  results.push(await s4MakeAtCase(note, 'hp_falls', true, async () => {
    await stage({ iron_ingot: 3, stick: 2 }, true);
    return { table, feet, stopIf: { hpBelow: 17, hostileWithin: 6 }, during: async () => { await ask(`damage ${ACTOR} 5 minecraft:generic`); } };
  }));
  const violations = results.filter(r => r.expectStopped && (r.crafted > 0 || r.statuses.some((s: string, i: number) => i > 0 && /^\d+\.craft ok/.test(s))));
  // a hand that ran after a hand that stopped the act: with onFail stop the second hand of a failed first is skipped; here the first hand either finished or never started
const lateStarts = results.filter(r => r.expectStopped && r.statuses.some((status: string, i: number) => i > 0 && !/ skipped/.test(status) && /stopped|failed/.test(r.statuses[0] ?? '')));
  note(`make_at summary: ${results.length} cases, crafted although it should have stopped ${violations.length}, cases with a hand started after the first stopping hand ${lateStarts.length}`);
  return { results, violations: violations.length, lateStarts: lateStarts.length };
});
