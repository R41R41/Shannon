// ---- night_sleep: the act's sleep hand, called by a stand-in head (2026-11-05, runs 60 and 61: a bed carried through a night of work, never laid down) -----
// When and where she sleeps is the head's (the owner's rule of 10/21); the body sets the bed down, sleeps and takes it back as one hand,
// `{do:'sleep'}` (utils/primitives/sleep). The floor does not sleep by itself. Three nights, each advanced with `time add`, the hand sent each time
// as the head would send it (S3's night arm: night, a bed in the pack, no enemy within 8 m):
//   A  playersSleepingPercentage 50 (the operator is the second player): the night passes, the bed comes back to the pack. Before it, by day,
//      the same hand stops `not_night` with the seconds to night.
//   B  playersSleepingPercentage 100 (the operator stays awake): `night_went_on`; the body gets up and takes the bed back.
//   C  a zombie caged 5 blocks off (in the game's box): `enemy_near` with the kind, the count and the distance, and no bed set down;
//      the zombie killed, the same hand sleeps and the night passes.
// No model: the head's choice is the scene's.
async function s4BedCount(feet: { x: number; y: number; z: number }): Promise<{ beds: number; bedBlocks: number; tod: number }> {
  const beds = (actor.inventory.items() as Array<{ name: string; count: number }>).filter(item => item.name.endsWith('_bed')).reduce((sum, item) => sum + item.count, 0);
  let bedBlocks = 0;
  for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) for (let dy = -1; dy <= 2; dy++) if (String(actor.blockAt(new Vec3(feet.x + dx, feet.y + dy, feet.z + dz))?.name ?? '').endsWith('_bed')) bedBlocks++;
  return { beds, bedBlocks, tod: Number(actor.time?.timeOfDay ?? -1) };
}
async function s4NextNight(): Promise<void> {
  const tod = Number(actor.time?.timeOfDay ?? 0);
  await ask(`time add ${(24000 - tod) + 13000}`);
  await sleep(1500);
}
/** The head's call: one sleep hand, and whether the body lay down while it ran. */
async function s4SleepHand(label: string, feet: { x: number; y: number; z: number }): Promise<Record<string, unknown>> {
  const tod = Number(actor.time?.timeOfDay ?? -1);
  let slept = false;
  const watch = setInterval(() => { if (actor.isSleeping) slept = true; }, 100);
  const run = await act(label, [{ do: 'sleep', item: 'white_bed' }], 70);
  clearInterval(watch);
  return { todBefore: tod, ok: run.ok, wallMs: run.wallMs, lines: run.lines.map(line => line.slice(0, 260)), stoppedBy: run.stoppedBy ?? null, slept, after: await s4BedCount(feet) };
}

scene('night_sleep', 'the act\'s sleep hand called by a stand-in head: by day not_night, at night the night passes and the bed comes back (A); the night goes on, the body gets up and takes the bed (B); an enemy in the box stops it with the facts, killed it sleeps (C)', async note => {
  await ask('difficulty normal'); await ask('gamerule doMobSpawning false'); await ask('gamerule spawn_mobs false'); await ask('gamerule doDaylightCycle true');
  const spawn = sites.spawn as number[];
  const here = { x: Math.floor(spawn[0]) - 40, z: Math.floor(spawn[2]) + 40 };
  await placeActor('overworld', here.x, spawn[1] + 2, here.z, 20);
  await sleep(2000);
  const y = Math.floor(actor.entity.position.y);
  const feet = { x: Math.floor(actor.entity.position.x), y, z: Math.floor(actor.entity.position.z) };
  const stage = async () => {
    await ask('kill @e[type=minecraft:zombie]'); await ask('kill @e[type=minecraft:item]');
    for (const command of [`fill ${feet.x - 7} ${y - 1} ${feet.z - 7} ${feet.x + 7} ${y - 1} ${feet.z + 7} minecraft:stone`, `fill ${feet.x - 7} ${y} ${feet.z - 7} ${feet.x + 7} ${y + 4} ${feet.z + 7} minecraft:air`]) await ask(command);
    await equip({ white_bed: 1, bread: 4 }, { armor: 'iron' });
    await ask(`tp ${ACTOR} ${feet.x + 0.5} ${y} ${feet.z + 0.5}`);
    await sleep(800);
  };
  const out: Record<string, unknown> = {};

  // A: by day the hand stops not_night; at night the night passes
  await stage(); await ask('gamerule playersSleepingPercentage 50');
  await ask('time set 1000'); await sleep(1000);
  out.day = await s4SleepHand('sleep_by_day', feet);
  note(`day: ${JSON.stringify(out.day)}`);
  await s4NextNight();
  out.A = await s4SleepHand('sleep_A', feet);
  note(`A night passes: ${JSON.stringify(out.A)}`);

  // B: the night goes on (the operator awake: a spectator is not counted by the game's sleep rule, so it turns creative for this night)
  await stage(); await ask('gamerule playersSleepingPercentage 100'); await ask('gamemode creative ShannonProbe');
  await s4NextNight();
  out.B = await s4SleepHand('sleep_B', feet);
  await ask('gamemode spectator ShannonProbe');
  note(`B night goes on: ${JSON.stringify(out.B)}`);

  // C: a zombie in the box stops the hand with the facts; killed, the same hand sleeps
  await stage(); await ask('gamerule playersSleepingPercentage 50');
  await ask(`fill ${feet.x + 4} ${y} ${feet.z - 1} ${feet.x + 6} ${y + 2} ${feet.z + 1} minecraft:glass hollow`);
  await ask(`summon minecraft:zombie ${feet.x + 5.5} ${y} ${feet.z + 0.5} {NoAI:1b,PersistenceRequired:1b}`);
  await s4NextNight();
  const held = await s4SleepHand('sleep_C_zombie', feet);
  await ask('kill @e[type=minecraft:zombie]'); await sleep(1000);
  const after = await s4SleepHand('sleep_C_killed', feet);
  out.C = { held, after };
  note(`C enemy in box: ${JSON.stringify(held)}; after the kill: ${JSON.stringify(after)}`);
  await ask('gamerule playersSleepingPercentage 100');
  return out;
});
