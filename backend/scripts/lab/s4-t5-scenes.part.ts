// ===== T5: server -> body's worldFrame -> server, without a model ===========================================
// Concatenated before the hunt probe's run section. Uses its actor, operator, body, ask, scene, sites,
// dimensionOf, sleep and randomUUID. No new body behaviour: only fixture commands and native USE/RELEASE.
// Arena coordinates are offsets from the staged world's sites, never special cases in the body's decisions.
type T5Note = (text: string) => void;
type T5Values = Record<string, any>;
interface T5Field { key: string; nbt: string; entity?: string; storage?: string; separator?: string }
interface T5Server { sentAt: number; receivedAt: number; tickStart: number | null; tickEnd: number | null; values: T5Values; raw: string }
interface T5Row {
  phase: string; server: { before: T5Server; after: T5Server }; observation: T5Values;
  difference: T5Values; observationAgeMs: number | null; frameAgeMs: number | null;
  observedAt: number; captureMs: number; sourceAgeMs: T5Values; bracketMs: number;
  stimulus: string[]; sameServerTick: boolean; serverTickSpan: number;
}
interface T5Run {
  note: T5Note; rows: T5Row[]; errors: number; unknown: number; changing: number; fixtureErrors: number;
  until: number; storage: string; last: Record<string, number>; lastSelfMetadata: unknown;
  arena: { dimension: string; x: number; y: number; z: number }; deaths0: number;
}
const t5Number = (text: unknown): number | null => {
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  const match = /^\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)[bBsSlLfFdD]?\s*$/u.exec(String(text ?? ''));
  return match && Number.isFinite(Number(match[1])) ? Number(match[1]) : null;
};
const t5Position = (text: unknown): number[] | null => {
  const parts = String(text ?? '').replace(/^\[|\]$/gu, '').split(',').map(t5Number);
  return parts.length === 3 && parts.every(value => value !== null) ? parts as number[] : null;
};
const t5Positions = (text: string): number[][] => text.split(';').map(t5Position).filter((p): p is number[] => p !== null);
const t5Distance = (a: number[], b: number[]) => Math.hypot(...a.map((value, i) => value - b[i]!));
// The oracle's scale is independent of airLevel(): vanilla Air is ticks, Mineflayer oxygenLevel is Air / 15.
const t5Oxygen = (air: number | null) => air === null ? null : Math.max(0, Math.min(20, Math.round(air / 15)));

/** Same op-chat / tellraw fence as ask(). Deliberately no ask()'s final 250 ms sleep in the measurement path.
 * Commands are serialized on one connection; never run two exchanges concurrently. Each server snapshot's
 * values are read by ONE tellraw command. tickStart/tickEnd bound its preceding queries, not an exact tick. */
async function t5Exchange(commands: string[], until: number): Promise<{ lines: string[]; sentAt: number; receivedAt: number }> {
  const marker = `T5_END_${randomUUID().replace(/-/gu, '')}`, sentAt = Date.now();
  if (sentAt >= until || disconnected) throw new Error('T5_DEADLINE_OR_DISCONNECT');
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    const finish = (error?: Error) => {
      clearTimeout(timer); operator.removeListener('message', listener);
      if (error) reject(error); else resolve({ lines, sentAt, receivedAt: Date.now() });
    };
    const listener = (message: unknown) => {
      const text = String(message);
      if (text.includes(marker)) finish(); else lines.push(text);
    };
    const timer = setTimeout(() => finish(new Error(`T5_COMMAND_TIMEOUT: ${commands[0]}`)), Math.min(5000, until - sentAt));
    operator.on('message', listener);
    try {
      for (const command of commands) {
        // Mineflayer's ordinary chat wrapper may split at the chat length limit. Modern protocol chat()
        // sends a long slash command as one command packet, which tellraw's component list needs.
        if (command.length >= 256) {
          if (typeof operator._client.chat !== 'function') throw new Error('T5_LONG_COMMAND_TRANSPORT_UNAVAILABLE');
          operator._client.chat(`/${command}`);
        } else operator.chat(`/${command}`);
      }
      operator.chat(`/tellraw @s ${JSON.stringify({ text: marker })}`);
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}

const t5PlayerFields = (paths: string[]): T5Field[] => paths.map(nbt => ({ key: nbt, nbt, entity: ACTOR }));
async function t5Server(run: T5Run, fields: T5Field[], commands: string[] = []): Promise<T5Server> {
  const prefix = `T5_VALUE_${randomUUID().replace(/-/gu, '')}`, endPrefix = `${prefix}_END=`, store = run.storage;
  const allFields: T5Field[] = [
    { key: 'tickStart', nbt: 'sample.tickStart', storage: store },
    ...fields,
  ];
  // One tellraw per field: a selector matching several entities made the components of a single line merge unpredictably.
  const { dimension, x, y, z } = run.arena;
  const fieldLines = allFields.map(field => `execute in minecraft:${dimension} positioned ${x + 0.5} ${y} ${z + 0.5} run tellraw @s ${JSON.stringify([
    { text: `${prefix}|${field.key}=` }, { nbt: field.nbt,
      ...(field.storage ? { storage: field.storage } : { entity: field.entity }),
      ...(field.separator ? { separator: { text: field.separator } } : {}) }])}`);
  const reply = await t5Exchange([
    `execute store result storage ${store} sample.tickStart int 1 run time query gametime`,
    ...commands,
    ...fieldLines,
    `execute store result storage ${store} sample.tickEnd int 1 run time query gametime`,
    `tellraw @s ${JSON.stringify([{ text: endPrefix }, { nbt: 'sample.tickEnd', storage: store }])}`,
  ], run.until);
  const rawLines = reply.lines.filter(line => line.startsWith(`${prefix}|`));
  if (rawLines.length < allFields.length) throw new Error(`T5_SNAPSHOT_MISSING: ${reply.lines.join(' ').slice(0, 300)}`);
  const raw = rawLines.join('\n');
  const values: T5Values = {};
  for (const line of rawLines) {
    const part = line.slice(prefix.length + 1), at = part.indexOf('='); values[part.slice(0, at)] = part.slice(at + 1);
  }
  values.tickEnd = reply.lines.find(line => line.startsWith(endPrefix))?.slice(endPrefix.length) ?? '';
  if (t5Number(values.tickStart) === null || t5Number(values.tickEnd) === null) throw new Error('T5_SERVER_TICK_MISSING');
  // Failed condition commands are valid false/zero results. Syntax / permission errors are fixture failures.
  const bad = reply.lines.filter(line => /Unknown|Incorrect|Expected|Invalid|permission|not allowed/iu.test(line));
  if (bad.length) { run.fixtureErrors += bad.length; run.note(`T5 command errors ${JSON.stringify(bad)}`); }
  return { sentAt: reply.sentAt, receivedAt: reply.receivedAt,
    tickStart: t5Number(values.tickStart), tickEnd: t5Number(values.tickEnd), values, raw };
}

/** Null is missing evidence. Changing brackets are reported separately from stable mismatches. */
function t5Compare(run: T5Run, before: any, observed: any, after: any, tolerance = 0): T5Values {
  if (before === null || before === undefined || observed === null || observed === undefined || after === null || after === undefined) {
    run.unknown++; return { status: 'unknown', before: before ?? null, observed: observed ?? null, after: after ?? null };
  }
  const numeric = [before, observed, after].every(value => typeof value === 'number' && Number.isFinite(value));
  const stable = numeric ? Math.abs(before - after) <= tolerance : JSON.stringify(before) === JSON.stringify(after);
  const deltaBefore = numeric ? observed - before : null, deltaAfter = numeric ? observed - after : null;
  const matches = numeric ? Math.abs(deltaBefore) <= tolerance : JSON.stringify(before) === JSON.stringify(observed);
  if (!stable) {
    run.changing++;
    const outside = numeric && (observed < Math.min(before, after) - tolerance || observed > Math.max(before, after) + tolerance);
    if (outside) run.errors++;
    return { status: outside ? 'outside_bracket' : 'changing', deltaBefore, deltaAfter };
  }
  if (!matches) run.errors++;
  return { status: matches ? 'match' : 'mismatch', deltaBefore, deltaAfter };
}

async function t5Sample(run: T5Run, phase: string, fields: T5Field[], read: (world: any) => T5Values,
  compare: (a: T5Values, observation: T5Values, b: T5Values) => T5Values,
  channel: string, commands: string[] = [], queries: string[] = []): Promise<T5Row> {
  if (dimensionOf() !== run.arena.dimension || deaths !== run.deaths0) throw new Error('T5_ACTOR_DIMENSION_OR_LIFE_CHANGED');
  const before = await t5Server(run, fields, [...commands, ...queries]);
  const started = Date.now(), envelope = body.observe() as any, finished = Date.now();
  const world = envelope.state?.world;
  if (!world) throw new Error('T5_BODY_OBSERVATION_HAS_NO_WORLD');
  // Read the actual head-facing world, not a reconstruction from actor.health / actor.entities.
  const observation = { worldObservedAt: world.observedAt, bodyStateAt: envelope.stateAt, ...read(world) }, observedAt = finished;
  const frameAt = Date.parse(world.observedAt ?? envelope.stateAt ?? '');
  const sourceAgeMs = Object.fromEntries(['health', 'selfMetadata', 'equipment', 'entities', 'blocks'].map(key =>
    [key, run.last[key] === undefined ? null : Math.max(0, finished - run.last[key]!)]));
  const after = await t5Server(run, fields, queries);
  const row: T5Row = { phase, server: { before, after }, observation,
    difference: compare(before.values, observation, after.values),
    observationAgeMs: sourceAgeMs[channel] ?? null,
    frameAgeMs: Number.isFinite(frameAt) ? Math.max(0, finished - frameAt) : null,
    observedAt, captureMs: finished - started, sourceAgeMs, bracketMs: after.receivedAt - before.sentAt, stimulus: commands,
    sameServerTick: before.tickStart === after.tickEnd, serverTickSpan: after.tickEnd! - before.tickStart! };
  run.rows.push(row); run.note(`T5 row ${JSON.stringify(row)}`);
  return row;
}

/** A transition's detection interval, NOT an exact latency. Tick counts in lagMs/50 are nominal 20 TPS. */
function t5Lags(rows: T5Row[], key: string): T5Values[] {
  return rows.flatMap((row, index) => {
    const value = t5Number(row.server.before.values[key]);
    if (!index || value === null || value === t5Number(rows[index - 1]!.server.before.values[key])) return [];
    const nextChange = rows.findIndex((next, i) => i > index && t5Number(next.server.before.values[key]) !== value);
    const found = rows.slice(index, nextChange < 0 ? undefined : nextChange).find(next => next.observation[key] === value);
    const earliest = row.stimulus.length ? row.server.before : rows[index - 1]!.server.before;
    const lag = found ? [Math.max(0, found.observedAt - row.server.before.receivedAt), Math.max(0, found.observedAt - earliest.sentAt)] : null;
    return [{ value, serverTickRange: [earliest.tickStart, row.server.before.tickEnd],
      detectionLagMsRange: lag, detectionLagSecondsRange: lag?.map(ms => ms / 1000) ?? null,
      detectionLagTicksAt20TpsRange: lag?.map(ms => ms / 50) ?? null, censored: !found }];
  });
}

async function t5Run(note: T5Note, seconds: number, dimension: 'overworld' | 'the_end',
  fn: (run: T5Run) => Promise<T5Values>): Promise<T5Values> {
  const origin = (dimension === 'the_end' ? sites.endPlatform : sites.spawn) as number[] | undefined;
  if (!origin || origin.length < 3 || !origin.every(Number.isFinite)) {
    const failure = `T5_MISSING_SITE:${dimension}`;
    note(`T5 stopped ${failure}`);
    note('T5 totals {"errors":0,"unknown":0,"changing":0,"fixtureErrors":1}');
    return { failure, errors: 0, unknown: 0, changing: 0, fixtureErrors: 1, rows: [] };
  }
  const run: T5Run = { note, rows: [], errors: 0, unknown: 0, changing: 0, fixtureErrors: 0,
    until: Date.now() + seconds * 1000, storage: `shannon_t5:p${randomUUID().replace(/-/gu, '')}`,
    last: {}, lastSelfMetadata: null, deaths0: deaths,
    arena: { dimension, x: Math.floor(origin[0]!) + 48, y: Math.min(220, Math.max(70, Math.floor(origin[1]!) + 20)), z: Math.floor(origin[2]!) } };
  const packet = (data: any, meta: { name: string }) => {
    const now = Date.now();
    if (meta.name === 'update_health') run.last.health = now;
    if (meta.name === 'entity_metadata' && data.entityId === actor.entity?.id) {
      run.last.selfMetadata = now; run.lastSelfMetadata = data.metadata;
    }
    if (meta.name === 'set_slot' || meta.name === 'window_items') run.last.equipment = now;
    if (['spawn_entity', 'entity_destroy', 'rel_entity_move', 'entity_teleport', 'entity_move_look', 'entity_position_sync'].includes(meta.name)
      && data.entityId !== actor.entity?.id) run.last.entities = now;
    if (['block_change', 'multi_block_change', 'map_chunk'].includes(meta.name)) run.last.blocks = now;
  };
  actor._client.on('packet', packet);
  let details: T5Values = {}, failure: string | null = null;
  try {
    const { x, y, z } = run.arena;
    const at = `execute in minecraft:${dimension} run `;
    // 1.21.11 renamed the gamerules to snake_case: try both spellings, neither is fatal.
    for (const rule of ['gamerule spawn_mobs false', 'gamerule doMobSpawning false']) await ask(rule, 5000);
    // Only the disposable lab copy is changed. Put the actor in creative until the floor/chunks are ready.
    for (const command of [`gamemode creative ${ACTOR}`, 'difficulty normal',
      `effect clear ${ACTOR}`, `clear ${ACTOR}`,
      `${at}forceload add ${x - 14} ${z - 14} ${x + 14} ${z + 14}`,
      `${at}fill ${x - 12} ${y - 1} ${z - 12} ${x + 12} ${y - 1} ${z + 12} minecraft:bedrock`,
      `${at}fill ${x - 12} ${y} ${z - 12} ${x + 12} ${y + 6} ${z + 12} minecraft:air`,
      `${at}tp ${ACTOR} ${x + 0.5} ${y} ${z + 0.5} -90 0`,
      `effect give ${ACTOR} minecraft:instant_health 1 5 true`,
      `effect give ${ACTOR} minecraft:saturation 1 5 true`]) {
      const response = await ask(command, 5000);
      if (/Unknown|Incorrect|Expected|Invalid|not loaded|outside of the world|\[timeout\]/iu.test(response)) {
        throw new Error(`T5_SETUP_FAILED: ${command}: ${response.slice(0, 200)}`);
      }
      if (command.includes('forceload add')) await sleep(1500);
    }
    const loadedUntil = Math.min(run.until, Date.now() + 10000);
    while (Date.now() < loadedUntil && (dimensionOf() !== dimension || !actor.entity?.position
      || t5Distance([actor.entity.position.x, actor.entity.position.y, actor.entity.position.z], [x + 0.5, y, z + 0.5]) > 2)) await sleep(100);
    await sleep(500); await ask(`effect clear ${ACTOR}`);
    note(`T5 arena ${JSON.stringify(run.arena)}; age(ms)=last relevant packet receipt, null=no packet since scene start; frameAgeMs only dates construction. Self metadata / entity / block ages are channel diagnostics, not per-field freshness guarantees.`);
    details = await fn(run);
  } catch (error) {
    failure = String((error as Error)?.message ?? error); run.fixtureErrors++; note(`T5 stopped ${failure}`);
  } finally {
    actor._client.removeListener('packet', packet);
    try { actor.deactivateItem(); actor.clearControlStates(); } catch { /* disconnected */ }
    // Cleanup also runs after a deadline/error; never leave USE held, a drowning player, or tagged fixtures.
    const { x, y, z } = run.arena;
    for (const command of [`gamemode creative ${ACTOR}`, `effect clear ${ACTOR}`,
      `execute in minecraft:${dimension} run tp ${ACTOR} ${x + 0.5} ${y + 5} ${z + 0.5}`,
      `execute in minecraft:${dimension} run kill @e[tag=shannon_t5]`,
      `execute in minecraft:${dimension} run forceload remove ${x - 14} ${z - 14} ${x + 14} ${z + 14}`,
      `data remove storage ${run.storage} sample`]) {
      try { await ask(command, 3000); } catch { /* best effort after a broken connection */ }
    }
  }
  const counts = { errors: run.errors, unknown: run.unknown, changing: run.changing, fixtureErrors: run.fixtureErrors };
  note(`T5 totals ${JSON.stringify(counts)}; errors=stable field mismatches + numeric values outside changing brackets; unknown/changing are not passes.`);
  return { ...details, ...counts, failure, rows: run.rows };
}

// ---- life: damage, natural regeneration, food and saturation -------------------------------------------------
scene('t5_life', 'T5 life: server Health / foodLevel / foodSaturationLevel against worldFrame and transition lag bounds', note =>
  t5Run(note, 120, 'overworld', async run => {
    const paths = ['Health', 'foodLevel', 'foodSaturationLevel'];
    const sample = (phase: string, commands: string[] = []) => t5Sample(run, phase, t5PlayerFields(paths), world => ({
      Health: world.health ?? null, foodLevel: world.food ?? null, foodSaturationLevel: world.saturation ?? null,
    }), (a, o, b) => Object.fromEntries(paths.map(key => [key, t5Compare(run, t5Number(a[key]), o[key], t5Number(b[key]), key === 'foodSaturationLevel' ? 0.11 : 0.01)])), 'health', commands);
    await ask(`gamemode survival ${ACTOR}`); await ask('gamerule natural_health_regeneration false'); await ask('gamerule naturalRegeneration false');
    try {
      const baseline = await sample('full');
      if (t5Number(baseline.server.before.values.Health) !== 20) { run.fixtureErrors++; note('T5 life: baseline is not 20 HP'); }
      const damaged = await sample('damage-8', [`damage ${ACTOR} 8 minecraft:generic`]);
      if (t5Number(damaged.server.before.values.Health) !== 12) { run.fixtureErrors++; note('T5 life: damage did not produce 12 HP'); }
      for (let i = 0; i < 8; i++) { await sleep(100); await sample('damage-follow'); }
      await ask('gamerule natural_health_regeneration true'); await ask('gamerule naturalRegeneration true');
      const until = Math.min(run.until - 8000, Date.now() + 45000);
      let recovered = false;
      while (Date.now() < until) {
        const row = await sample('natural-heal');
        if (t5Number(row.server.after.values.Health) === 20 && row.observation.Health === 20) { recovered = true; break; }
        await sleep(350);
      }
      if (!recovered) { run.fixtureErrors++; note('T5 life: full recovery was not reached in the window'); }
      await sample('saturation-effect', [`effect give ${ACTOR} minecraft:saturation 2 1 true`]);
      for (let i = 0; i < 6; i++) { await sleep(400); await sample('saturation-follow'); }
      const lag = t5Lags(run.rows, 'Health'); note(`T5 health lag ${JSON.stringify(lag)}`);
      return { targetHealth: 12, recovered, healthLag: lag };
    } finally { await ask('gamerule natural_health_regeneration true'); await ask('gamerule naturalRegeneration true'); }
  }));

// ---- saturation packets: does the server send update_health when only the saturation changes? -----------------
scene('t5_saturation_packets', 'T5 saturation packets: arrival of update_health (health / food / saturation) for saturation-only, food and health changes', async note => {
  const packets: Array<{ at: number; phase: string; health: number; food: number; saturation: number }> = [];
  let phase = 'start';
  const client = (actor as unknown as { _client: { on(name: string, fn: (p: any) => void): void; removeListener(name: string, fn: (p: any) => void): void } })._client;
  const onHealth = (p: any) => packets.push({ at: Date.now(), phase, health: p.health, food: p.food, saturation: p.foodSaturation });
  client.on('update_health', onHealth);
  const serverSaturation = async () => (await ask(`data get entity ${ACTOR} foodSaturationLevel`, 5000)).replace(/\s+/gu, ' ').slice(0, 120);
  const marks: Array<{ phase: string; at: number; server: string }> = [];
  const mark = async (name: string, command?: string) => {
    phase = name; if (command) await ask(command, 5000);
    marks.push({ phase: name, at: Date.now(), server: await serverSaturation() });
  };
  try {
    await ask(`gamemode survival ${ACTOR}`); await ask('gamerule natural_health_regeneration false'); await ask('gamerule naturalRegeneration false');
    await mark('idle'); await sleep(3000);
    await mark('saturation-effect', `effect give ${ACTOR} minecraft:saturation 1 0 true`); await sleep(3000);
    await mark('saturation-quiet'); await sleep(3000);
    await mark('damage-3', `damage ${ACTOR} 3 minecraft:generic`); await sleep(3000);
    await mark('food-drop', `effect give ${ACTOR} minecraft:hunger 2 20 true`); await sleep(4000);
    await mark('end');
  } finally {
    client.removeListener('update_health', onHealth);
    await ask('gamerule natural_health_regeneration true'); await ask('gamerule naturalRegeneration true'); await ask(`effect clear ${ACTOR}`);
  }
  const byPhase: Record<string, number> = {};
  for (const p of packets) byPhase[p.phase] = (byPhase[p.phase] ?? 0) + 1;
  note(`T5 saturation packets by phase ${JSON.stringify(byPhase)}`);
  note(`T5 saturation packets marks ${JSON.stringify(marks)}`);
  note(`T5 saturation packets list ${JSON.stringify(packets.slice(0, 40))}`);
  return { packets: packets.length, byPhase };
});

// ---- oxygen: two dives, alone and with neighbours whose Air differs -----------------------------------------
scene('t5_oxygen', 'T5 oxygen: own Air 300 -> 0, resurfacing, and submerged villagers with different Air', note =>
  t5Run(note, 115, 'overworld', async run => {
    const { x, y, z } = run.arena, at = `execute in minecraft:overworld run `;
    await ask(`${at}fill ${x - 2} ${y - 1} ${z - 2} ${x + 2} ${y + 3} ${z + 2} minecraft:bedrock hollow`);
    await ask(`${at}fill ${x - 1} ${y} ${z - 1} ${x + 1} ${y + 2} ${z + 1} minecraft:water`);
    await ask(`${at}tp ${ACTOR} ${x + 5.5} ${y} ${z + 0.5}`); await ask(`gamemode survival ${ACTOR}`);
    const fields = [...t5PlayerFields(['Air']), { key: 'villagerAir', nbt: 'Air', entity: '@e[type=minecraft:villager,tag=shannon_t5]', separator: ';' }];
    const sample = (phase: string, commands: string[] = []) => t5Sample(run, phase, fields,
      world => ({ oxygen: world.oxygen ?? null, isInWater: world.isInWater, nativeOxygenLevel: actor.oxygenLevel ?? null }),
      (a, o, b) => ({ oxygen: t5Compare(run, t5Oxygen(t5Number(a.Air)), o.oxygen, t5Oxygen(t5Number(b.Air))),
        airTicksBefore: t5Number(a.Air), airTicksAfter: t5Number(b.Air), scale: 'clamp(round(Air/15),0,20)' }), 'selfMetadata', commands);
    const reachedZero: Record<string, boolean> = {};
    for (const neighbours of [false, true]) {
      const phase = neighbours ? 'with-villagers' : 'alone';
      if (neighbours) {
        for (const [index, air] of [1, 300].entries()) await ask(`${at}summon minecraft:villager ${x - 0.5 + index * 2} ${y} ${z - 0.5} {Tags:["shannon_t5"],NoAI:1b,Invulnerable:1b,PersistenceRequired:1b,Air:${air}s}`);
      }
      await sleep(1000); const surface = await sample(`${phase}-surface`);
      if ((t5Number(surface.server.after.values.Air) ?? 0) < 300) { run.fixtureErrors++; note(`T5 ${phase}: Air was not full before diving`); }
      await sample(`${phase}-dive`, [`${at}tp ${ACTOR} ${x + 0.5} ${y} ${z + 0.5}`]);
      const until = Math.min(run.until - 10000, Date.now() + 25000);
      reachedZero[phase] = false;
      while (Date.now() < until) {
        const row = await sample(phase);
        if (t5Number(row.server.after.values.Air) !== null && t5Number(row.server.after.values.Air)! <= 0) { reachedZero[phase] = true; break; }
        await sleep(200);
      }
      if (!reachedZero[phase]) { run.fixtureErrors++; note(`T5 ${phase}: own Air did not reach zero; dive incomplete`); }
      await sample(`${phase}-surface-again`, [`${at}tp ${ACTOR} ${x + 5.5} ${y} ${z + 0.5}`]);
      for (let i = 0; i < 4; i++) { await sleep(300); await sample(`${phase}-refill`); }
    }
    return { reachedZero, neighbours: 'villagers Air=1 and Air=300 at summon; every bracket reads own player Air explicitly' };
  }));

// ---- shield: equipment, native USE/RELEASE and a directional server-side hit ---------------------------------
scene('t5_shield', 'T5 shield: offhand, USE / RELEASE, UsingItem / active_item availability and directional damage', note =>
  t5Run(note, 85, 'overworld', async run => {
    const { x, y, z } = run.arena;
    await ask(`gamemode survival ${ACTOR}`); await ask('gamerule natural_health_regeneration false'); await ask('gamerule naturalRegeneration false');
    await ask(`item replace entity ${ACTOR} weapon.offhand with minecraft:shield`);
    await ask(`execute in minecraft:overworld run summon minecraft:zombie ${x + 3.5} ${y} ${z + 0.5} {Tags:["shannon_t5"],NoAI:1b,Silent:1b,Invulnerable:1b,PersistenceRequired:1b}`);
    const fields = [...t5PlayerFields(['Health', 'UsingItem', 'active_item']),
      { key: 'offhand', nbt: 'Inventory[{Slot:-106b}].id', entity: ACTOR },
      { key: 'shieldDamage', nbt: 'Inventory[{Slot:-106b}].components."minecraft:damage"', entity: ACTOR }];
    const sample = (phase: string, commands: string[] = []) => t5Sample(run, phase, fields, world => ({
      worn: world.worn ?? null,
      // This revision's worldFrame has no active-shield field. Keep the missing coverage visible.
      shieldActiveInWorldFrame: null, nativeUsingHeldItem: actor.usingHeldItem ?? null,
      nativeSelfMetadata: run.lastSelfMetadata, Health: world.health ?? null,
    }), (a, o, b) => ({
      equipment: t5Compare(run, a.offhand ? a.offhand.includes('minecraft:shield') : null,
        typeof o.worn === 'string' ? /\bshield\b/u.test(o.worn) : null, b.offhand ? b.offhand.includes('minecraft:shield') : null),
      UsingItem: t5Compare(run, t5Number(a.UsingItem), o.shieldActiveInWorldFrame, t5Number(b.UsingItem)),
      active_item: t5Compare(run, a.active_item || null, o.shieldActiveInWorldFrame, b.active_item || null),
      nativeUsingItemDiagnostic: t5Compare(run, t5Number(a.UsingItem) === null ? null : t5Number(a.UsingItem) !== 0,
        o.nativeUsingHeldItem, t5Number(b.UsingItem) === null ? null : t5Number(b.UsingItem) !== 0),
      health: t5Compare(run, t5Number(a.Health), o.Health, t5Number(b.Health), 0.01),
    }), 'selfMetadata', commands);
    try {
      await sample('equipped-lowered');
      // A literal use packet, kept up while sampling. act/use's short lifetime would miss the raised interval.
      actor.activateItem(true); await sample('use-immediate');
      await sleep(400); await sample('use-after-8-nominal-ticks');
      const hit = [`damage ${ACTOR} 3 minecraft:mob_attack by @e[type=minecraft:zombie,tag=shannon_t5,limit=1]`];
      await sample('hit-while-using', hit);
      actor.deactivateItem(); await sample('release-immediate');
      await sleep(1200); await sample('hit-after-release', hit);
      note('T5 shield: blank UsingItem/active_item NBT = unavailable, never false. nativeUsingHeldItem is a client diagnostic, not server proof or a worldFrame field. HP / shieldDamage are outcomes; damage commands do not guarantee a blocked hit.');
      return { activeShieldFieldAvailable: false, stimulus: 'native offhand USE/RELEASE; damage mob_attack from the front' };
    } finally { actor.deactivateItem(); await ask('gamerule natural_health_regeneration true'); await ask('gamerule naturalRegeneration true'); }
  }));

// ---- use state: a real arrow on a raised shield, eating, death and respawn (the stimuli that cleared usingHeldItem) --------
scene('t5_use_state', 'T5 use state: usingHeldItem / oxygen against the server with skeleton arrows on a raised shield, eating, and death + respawn', note =>
  t5Run(note, 110, 'overworld', async run => {
    const { x, y, z } = run.arena;
    const trace: Array<{ phase: string; ms: number; native: boolean | null; server: string; hp: string; oxygen: number | null; food: string }> = [];
    const t0 = Date.now();
    const point = async (phase: string) => {
      const server = (await ask(`data get entity ${ACTOR} UsingItem`, 4000)).replace(/\s+/gu, ' ').replace(/^.*entity data: /u, '').slice(0, 40);
      const hp = (await ask(`data get entity ${ACTOR} Health`, 4000)).replace(/^.*entity data: /u, '').replace(/\s+/gu, ' ').slice(0, 20);
      const food = (await ask(`data get entity ${ACTOR} foodLevel`, 4000)).replace(/^.*entity data: /u, '').replace(/\s+/gu, ' ').slice(0, 12);
      trace.push({ phase, food, ms: Date.now() - t0, native: actor.usingHeldItem ?? null, server, hp, oxygen: (actor as unknown as { oxygenLevel?: number }).oxygenLevel ?? null });
    };
    await ask(`gamemode survival ${ACTOR}`); await ask('gamerule natural_health_regeneration false'); await ask('gamerule naturalRegeneration false');
    try {
      // 1. skeleton arrows (status 29 on a block, 2 on a hit) while the shield is held up; the zombie is a bystander (any entity's status 2 / 3 / 9)
      await ask(`item replace entity ${ACTOR} weapon.offhand with minecraft:shield`);
      await ask(`execute in minecraft:overworld run summon minecraft:skeleton ${x + 8.5} ${y} ${z + 0.5} {Tags:["shannon_t5"],PersistenceRequired:1b,HandItems:[{id:"minecraft:bow",count:1},{}]}`);
      await ask(`execute in minecraft:overworld run summon minecraft:zombie ${x - 6.5} ${y} ${z + 0.5} {Tags:["shannon_t5"],PersistenceRequired:1b,NoAI:1b,Silent:1b}`);
      await ask(`tp ${ACTOR} ${x + 0.5} ${y} ${z + 0.5} -90 0`); await sleep(500);
      actor.activateItem(true);
      for (let i = 0; i < 24; i++) { await sleep(250); await point(i % 6 === 5 ? 'shield-up-arrows' : 'shield-up'); }
      // a bystander is hurt and killed while the shield is up: another entity's status must not end the use
      await ask(`damage @e[type=minecraft:zombie,tag=shannon_t5,limit=1] 1 minecraft:generic`); await sleep(300); await point('bystander-hurt');
      await ask(`kill @e[type=minecraft:zombie,tag=shannon_t5]`); await sleep(300); await point('bystander-killed');
      actor.deactivateItem(); await sleep(300); await point('shield-released');
      await ask(`kill @e[type=minecraft:skeleton,tag=shannon_t5]`);
      // 2. eating: status 9 of the bot ends the use
      await ask(`effect give ${ACTOR} minecraft:hunger 9 100 true`); await sleep(9500); await ask(`effect clear ${ACTOR} minecraft:hunger`);
      await ask(`item replace entity ${ACTOR} weapon.mainhand with minecraft:cooked_beef 4`);
      actor.activateItem();
      for (let i = 0; i < 10; i++) { await sleep(300); await point(i < 6 ? 'eating' : 'eaten'); }
      actor.deactivateItem();
      // 3. death and respawn: the use state after the new life
      await ask(`item replace entity ${ACTOR} weapon.offhand with minecraft:shield`);
      actor.activateItem(true); await sleep(300); await point('before-death');
      await ask(`kill ${ACTOR}`); await sleep(2500); await point('after-respawn');
      await ask(`gamemode survival ${ACTOR}`); await sleep(500); await point('respawn-settled');
    } finally { actor.deactivateItem?.(); await ask(`kill @e[tag=shannon_t5]`); await ask('gamerule natural_health_regeneration true'); await ask('gamerule naturalRegeneration true'); }
    const byPhase: Record<string, string> = {};
    for (const phase of new Set(trace.map(row => row.phase))) {
      const rows = trace.filter(row => row.phase === phase);
      byPhase[phase] = `n=${rows.length} native=${rows.map(row => (row.native === null ? '?' : row.native ? 'T' : 'F')).join('')} food=${rows.map(row => row.food).join(',')}`;
    }
    note(`T5 use state by phase ${JSON.stringify(byPhase)}`);
    note(`T5 use state trace ${JSON.stringify(trace)}`);
    return { byPhase, hpEnd: trace[trace.length - 1]?.hp ?? null };
  }));

// ---- crystals: exact scoped server count and unordered positions -------------------------------------------
scene('t5_crystals', 'T5 End crystals: scoped server count / positions before summon, after summon and removal', note =>
  t5Run(note, 85, 'the_end', async run => {
    const { x, y, z } = run.arena;
    const selector = '@e[type=minecraft:end_crystal,distance=..12]';
    const fields: T5Field[] = [
      { key: 'count', nbt: 'sample.count', storage: run.storage },
      { key: 'positions', nbt: 'Pos', entity: selector, separator: ';' },
    ];
    // Count is the result of execute if entity (number matched), NOT countServer(), which counts inventory items.
    const count = `execute in minecraft:the_end positioned ${x + 0.5} ${y} ${z + 0.5} store result storage ${run.storage} sample.count int 1 if entity ${selector}`;
    const sample = async (phase: string, commands: string[] = []) => {
      const row = await t5Sample(run, phase, fields, world => {
        const crystals = (world.nearbyEntities ?? []).filter((entity: any) => entity.name === 'end_crystal'
          && entity.position && t5Distance([entity.position.x, entity.position.y, entity.position.z], [x + 0.5, y, z + 0.5]) <= 12);
        return { count: crystals.length, positions: crystals.map((entity: any) => [entity.position.x, entity.position.y, entity.position.z]),
          nearbyEntityLimit: 16, dimension: world.dimension };
      }, (a, o, b) => {
        const before = t5Positions(a.positions), after = t5Positions(b.positions);
        const positionsKnown = before.length === t5Number(a.count) && after.length === t5Number(b.count);
        const canonical = (positions: number[][]) => [...positions].sort((p, q) => p[0]! - q[0]! || p[1]! - q[1]! || p[2]! - q[2]!);
        const stable = JSON.stringify(canonical(before)) === JSON.stringify(canonical(after));
        const remaining = [...o.positions] as number[][], missing: number[][] = [], offsets: number[] = [];
        for (const position of before) {
          const nearest = remaining.map((candidate, index) => ({ index, distance: t5Distance(position, candidate) })).sort((p, q) => p.distance - q.distance)[0];
          if (!nearest || nearest.distance > 0.15) missing.push(position);
          else { offsets.push(nearest.distance); remaining.splice(nearest.index, 1); }
        }
        return { count: t5Compare(run, t5Number(a.count), o.count, t5Number(b.count)),
          positions: !positionsKnown ? t5Compare(run, null, null, null)
            : stable ? t5Compare(run, true, !missing.length && !remaining.length, true) : t5Compare(run, false, null, true),
          missing, extra: remaining, matchedPositionErrors: offsets, toleranceBlocks: 0.15 };
      }, 'entities', commands, [count]);
      const expectedCount = phase.startsWith('empty') || phase.startsWith('remove-all') ? 0 : phase.startsWith('remove-one') ? 2 : 3;
      const actualCount = t5Number(row.server.after.values.count);
      if (actualCount !== expectedCount) { run.fixtureErrors++; note(`T5 crystal fixture expected ${expectedCount}, server=${actualCount}; phase=${phase}`); }
      return row;
    };
    await sample('empty');
    const summon = [-4, 0, 4].map((dx, index) => `execute in minecraft:the_end run summon minecraft:end_crystal ${x + dx + 0.5} ${y} ${z + 4.5} {Tags:["shannon_t5","shannon_t5_c${index}"],ShowBottom:0b}`);
    await sample('summon-immediate', summon); await sleep(700); await sample('summon-settled');
    await sample('remove-one-immediate', ['execute in minecraft:the_end run kill @e[type=minecraft:end_crystal,tag=shannon_t5_c1]']);
    await sleep(700); await sample('remove-one-settled');
    await sample('remove-all-immediate', ['execute in minecraft:the_end run kill @e[type=minecraft:end_crystal,tag=shannon_t5]']);
    await sleep(700); await sample('remove-all-settled');
    note('T5 crystals: count / position scope is the same 12-block sphere on the server and in worldFrame; kill removes fixtures without an explosion. No dragon fight or head text is inferred.');
    return { scopeRadius: 12, positionTolerance: 0.15, removedBy: 'server kill (entity removal, no explosion)' };
  }));

// ---- sight: independent server block comparison, explicitly an approximation --------------------------------
scene('t5_sight', 'T5 zombie / skeleton sight: solid wall -> open -> wall; server horizontal eye-ray approximation', note =>
  t5Run(note, 130, 'overworld', async run => {
    const { x, y, z } = run.arena;
    const at = 'execute in minecraft:overworld run ';
    const mob = '@e[tag=shannon_t5,limit=1]';
    const wall = (block: string) => `${at}fill ${x + 4} ${y} ${z - 2} ${x + 4} ${y + 2} ${z + 2} minecraft:${block}`;
    // On this fixture only, the ray is horizontal, all intervening cells are air or full stone. Compare the
    // whole 7-cell eye-height strip with an empty strip above it. No client blockAt / threatExposure oracle.
    // This does NOT test AI targeting, attack range, arrow ballistics, partial blocks, or reach/pathToMe.
    const ray = `execute in minecraft:overworld store success storage ${run.storage} sample.sight byte 1 positioned ${x + 1} ${y + 1} ${z} if blocks ~ ~ ~ ${x + 7} ${y + 1} ${z} ${x + 1} ${y + 4} ${z} all`;
    const fields: T5Field[] = [...t5PlayerFields(['Pos']),
      { key: 'mobPos', nbt: 'Pos', entity: mob },
      { key: 'sightApprox', nbt: 'sample.sight', storage: run.storage }];
    for (const kind of ['zombie', 'skeleton']) {
      await ask(`${at}kill @e[tag=shannon_t5]`);
      await ask(`${at}summon minecraft:${kind} ${x + 8.5} ${y} ${z + 0.5} {Tags:["shannon_t5"],NoAI:1b,Silent:1b,Invulnerable:1b,PersistenceRequired:1b}`);
      for (const [phase, block] of [['wall', 'stone'], ['open', 'air'], ['wall-again', 'stone']]) {
        await ask(wall(block!));
        const changedAt = Date.now();
        for (const delay of [0, 1200, 3500]) {
          await sleep(Math.max(0, changedAt + delay - Date.now()));
          await t5Sample(run, `${kind}-${phase}-${Date.now() - changedAt}ms`, fields, world => {
            const entity = (world.nearbyThreats ?? []).find((entry: any) => entry.name === kind);
            return { canSee: entity?.canSee ?? null, lineOfSight: entity?.lineOfSight ?? null, shooter: entity?.shooter ?? null,
              canReachMe: entity?.canReachMe ?? null, reach: entity?.reach ?? null, position: world.position,
              mobPosition: entity?.position ?? null };
          }, (a, o, b) => {
            const from = t5Position(a.Pos), to = t5Position(a.mobPos), fromAfter = t5Position(b.Pos), toAfter = t5Position(b.mobPos);
            const aligned = from && to && fromAfter && toAfter
              && [from, fromAfter].every(p => t5Distance(p, [x + 0.5, y, z + 0.5]) < 0.2)
              && [to, toAfter].every(p => t5Distance(p, [x + 8.5, y, z + 0.5]) < 0.2);
            if (!aligned) { run.fixtureErrors++; return { status: 'fixture-moved; ray approximation inapplicable' }; }
            const before = t5Number(a.sightApprox), after = t5Number(b.sightApprox);
            if (before !== (phase === 'open' ? 1 : 0) || after !== (phase === 'open' ? 1 : 0)) {
              run.fixtureErrors++; return { status: 'fixture-wall-or-reference-strip-wrong', before, after };
            }
            return { canSee: t5Compare(run, before === null ? null : before === 1, o.canSee, after === null ? null : after === 1),
              lineOfSight: t5Compare(run, before === null ? null : before === 1, o.lineOfSight, after === null ? null : after === 1),
              shooter: t5Compare(run, kind === 'skeleton', o.shooter, kind === 'skeleton'), approximation: true };
          }, 'blocks', [], [ray]);
        }
      }
    }
    note('T5 sight oracle is an approximation: server execute if blocks checks the entire horizontal eye-height air strip. NoAI fixtures separate visibility from AI targeting. Both actor/mob positions are server-verified; movement invalidates the comparison.');
    return { approximation: 'horizontal full-block eye ray by server execute if blocks', kinds: ['zombie', 'skeleton'] };
  }));
