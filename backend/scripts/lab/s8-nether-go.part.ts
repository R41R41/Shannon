// ---- S8's Nether walk measure (inserted before `// ---- run -` of the hunt probe by s4-section-probe.sh with S4_SCENES_PART=<this file>) ----
// Scene nether_go: c1, from the Nether arrival to the blaze stand (about 144 m) and on to the warped forest stand (about 249 m), by go the way the head
// sends it (canDig netherrack/basalt/blackstone, canPlace cobblestone/netherrack, maxDig 120, maxPlace 40, seconds 100), sprint left to the body unless
// the label says -sprint or -walk. Per go: where the seconds went (the body's lastGoTiming). Per leg: metres a second, stops, search_timeouts, hp lost, deaths.
import { lastGoTiming } from '../src/services/minebot/utils/primitives/go.js';

const s8Planar = (to: number[]): number => { const at = actor.entity?.position as Vec3 | undefined; return at ? Math.hypot(at.x - (to[0] + 0.5), at.z - (to[2] + 0.5)) : Number.NaN; };
const S8_KIT = { iron_sword: 1, diamond_pickaxe: 1, iron_pickaxe: 1, bow: 1, arrow: 32, water_bucket: 1, flint_and_steel: 1, cobblestone: 64, torch: 16, cooked_beef: 16 };
const s8Short = (text: string, n = 200) => text.replace(/\s+/gu, ' ').slice(0, n);
const s8Key = (why: string): string => why.replace(/-?\d+(\.\d+)?/gu, '#').slice(0, 120);
const s8Why = (run: ActRun): string => { const line = run.lines.find(text => /止まった|stopped|NO|failed/u.test(text)) ?? run.lines[0] ?? run.error ?? ''; return s8Short(`${run.stoppedBy ?? ''} ${run.stoppedWhy ?? ''} ${line}`, 220); };
async function s8Eat(): Promise<void> { if (Number(actor.health) < 12 || Number(actor.food) < 14) await act('eat', [{ do: 'eat' }], 15); }
// The runner passes no environment of its own: the sprint is read from the label (in the report's path): "-sprint" true, "-walk" false, else the body's choice.
const s8Label = String(process.env.MINECRAFT_HUNT_REPORT ?? '');
const s8Sprint = /-sprint(?:[-/]|$)/u.test(s8Label) ? true : /-walk(?:[-/]|$)/u.test(s8Label) ? false : undefined;

async function s8Leg(name: string, goal: number[], limitMs: number, note: (text: string) => void, deaths0: number): Promise<Record<string, unknown>> {
  const started = Date.now();
  const start = r1(s8Planar(goal));
  const leg = { name, startDistance: start, endDistance: start, seconds: 0, mps: 0, acts: 0, okActs: 0, stops: [] as string[], searchTimeouts: 0, hpLost: 0, lowestHp: 20,
    digs: 0, places: 0, searchMs: 0, walkMs: 0, digMs: 0, placeMs: 0, climbMs: 0, mendMs: 0, sprintMs: 0, goMs: 0, reached: false, died: false };
  let sameStop = 0, lastStop = '';
  while (Date.now() - started < limitMs) {
    if (Number(actor.health) <= 0 || deaths !== deaths0 || disconnected) { leg.died = true; break; }
    if (s8Planar(goal) <= 4) { leg.reached = true; break; }
    const hp0 = Number(actor.health);
    const hand: Record<string, unknown> = { do: 'go', to: { x: goal[0], y: goal[1], z: goal[2] }, range: 3, seconds: 100, canDig: ['netherrack', 'basalt', 'blackstone'],
      canPlace: ['cobblestone', 'netherrack'], maxDrop: 4, maxDig: 120, maxPlace: 40 };
    if (s8Sprint !== undefined) hand.sprint = s8Sprint;
    const run = await act(`${name}#${leg.acts + 1}`, [hand], 130);
    leg.acts++; if (run.ok) leg.okActs++;
    const timing = lastGoTiming(actor);
    if (timing) {
      leg.digs += timing.digs; leg.places += timing.places; leg.searchMs += timing.searchMs; leg.walkMs += timing.walkMs; leg.digMs += timing.digMs; leg.placeMs += timing.placeMs;
      leg.climbMs += timing.climbMs; leg.mendMs += timing.mendMs; leg.sprintMs += timing.sprintMs; leg.goMs += timing.totalMs;
      note(`${name}#${leg.acts} go ${(timing.totalMs / 1000).toFixed(1)}s ${timing.metres}m search ${(timing.searchMs / 1000).toFixed(1)}s/${timing.searches} walk ${(timing.walkMs / 1000).toFixed(1)}s dig ${(timing.digMs / 1000).toFixed(1)}s/${timing.digs} place ${(timing.placeMs / 1000).toFixed(1)}s/${timing.places} sprint ${(timing.sprintMs / 1000).toFixed(1)}s`);
    }
    leg.hpLost += Math.max(0, hp0 - Number(actor.health)); leg.lowestHp = Math.min(leg.lowestHp, Number(actor.health));
    if (!run.ok) {
      const why = s8Why(run);
      if (/search_timeout/u.test(why)) leg.searchTimeouts++;
      leg.stops.push(`${Math.round((Date.now() - started) / 1000)}s ${why}`);
      const key = s8Key(why); sameStop = key === lastStop ? sameStop + 1 : 1; lastStop = key;
      await sleep(1000);
      if (sameStop >= 4) { note(`the same stop four times: ${why}`); break; }
    } else sameStop = 0;
    await s8Eat();
  }
  leg.seconds = r1((Date.now() - started) / 1000);
  leg.endDistance = r1(s8Planar(goal));
  leg.mps = leg.seconds > 0 ? Math.round(((leg.startDistance - leg.endDistance) / leg.seconds) * 100) / 100 : 0;
  leg.stops = leg.stops.slice(0, 12);
  note(`LEG ${name} ${leg.reached ? 'reached' : 'NOT reached'} ${leg.startDistance}->${leg.endDistance} m in ${leg.seconds}s = ${leg.mps} m/s; acts ${leg.acts}, search_timeout ${leg.searchTimeouts}, hp lost ${r1(leg.hpLost)}, digs ${leg.digs}, places ${leg.places}, sprint ${(leg.sprintMs / 1000).toFixed(0)}s`);
  return leg;
}

scene('nether_go', 'S8: the Nether walk on c1 (arrival to the blaze stand, then to the warped stand) by go as the head sends it; m/s, stops, deaths and where the seconds went', async note => {
  const arrival = sites.netherArrival as number[] | undefined, stand = sites.blazeStand as number[] | undefined, warped = sites.warpedStand as number[] | undefined;
  if (!arrival || !stand || !warped) throw new Error('no netherArrival / blazeStand / warpedStand in the sites');
  const deaths0 = deaths;
  await ask('difficulty normal'); await ask('gamerule doMobSpawning true');
  await equip(S8_KIT, { armor: 'iron', shield: true, goldBoots: true });
  await placeActor('the_nether', arrival[0], arrival[1], arrival[2], 48);
  const total = (timedSeconds || 900) * 1000, began = Date.now();
  const legs: Array<Record<string, unknown>> = [];
  try {
    legs.push(await s8Leg('to_stand', stand, Math.min(total, 480_000), note, deaths0));
    if (deaths === deaths0 && legs[0]!.reached && Date.now() - began < total) legs.push(await s8Leg('to_warped', warped, total - (Date.now() - began), note, deaths0));
  } finally { await ask('gamerule doMobSpawning false'); }
  return { sprint: s8Sprint ?? 'body', legs, deathsHere: deaths - deaths0, seconds: r1((Date.now() - began) / 1000) };
});

