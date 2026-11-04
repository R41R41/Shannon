import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { bodyReader } from '../../src/services/minebot/utils/localMap.js';
import { CLUTCH_REACH, clutchWanted, groundUnder, runFallClutch, type FallBody, type FallMemory } from '../../src/services/minebot/utils/fallClutch.js';
import { actionSignal, createMotorPort, executeAction, preemptLowerPriorityActions } from '../../src/services/minebot/execution/ActionExecution.js';

// Keep this test independent of the dragon's readers/providers; no live world or service.
vi.mock('../../src/services/minebot/utils/dragonState.js', () => ({ isEnd: (bot: FallBody) => bot.game?.dimension === 'the_end' }));

const cube = [[0, 0, 0, 1, 1, 1]];
const cellKey = (v: Vec3) => `${Math.floor(v.x)},${Math.floor(v.y)},${Math.floor(v.z)}`;
const nextVy = (vy: number) => (vy - 0.08) * 0.98;
// Exercise the installed Mineflayer's empty-slot/LRU equip policy, including its bare-bot calls after awaits.
const injectInventory = createRequire(import.meta.url)('mineflayer/lib/plugins/simple_inventory.js') as (bot: any) => void;

/**
 * Local simulate/apply has already set P(N) when physicsTick fires (physics.js:81-82).
 * emit models physicsTick -> updatePosition/write position -> move, with no promise turn
 * between them. The server ray uses ONLY the last position packet, P(N-1) during physicsTick,
 * P(N) during move. This is an ordered packet model, not a server/latency test.
 */
function rig(top: (x: number, z: number) => number = () => 65, name = 'end_stone', waterDelayTicks = 1, rejectUse = false, positionPacket = 'position') {
  const water = new Map<string, Vec3>();
  const sends: Array<{ tick: number; eye: Vec3; source: Vec3 | null; reachable: boolean; pitch: number }> = [];
  const wire: Array<{ tick: number; name: string; position: Vec3 }> = [];
  const pending: Array<{ tick: number; source: Vec3 }> = [];
  let tick = 0;
  let serverPosition = new Vec3(0.5, 100, 0.5);
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 100, 0.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: false, isInWater: false },
    game: { dimension: 'the_end' }, health: 20,
    heldItem: { name: 'water_bucket', slot: 37 }, quickBarSlot: 1,
    inventory: { items: () => [bot.heldItem] },
    look: vi.fn((_yaw: number, _pitch: number) => new Promise<void>(() => {})), // a look that never settles must not stall a pour
    lookAt: vi.fn(async () => undefined),
    blockAt: (p: Vec3) => {
      const c = p.floored(), wet = water.has(cellKey(c));
      const solid = c.y < top(c.x, c.z);
      return { name: wet ? 'water' : solid ? name : 'air', metadata: 0, boundingBox: solid ? 'block' : 'empty', shapes: solid ? cube : [] };
    },
    _client: { write: (_name: string, data: { x?: number; y?: number; z?: number; rotation?: { x: number; y: number } }) => {
      if (_name === 'position' || _name === 'position_look') serverPosition = new Vec3(data.x!, data.y!, data.z!);
      wire.push({ tick, name: _name, position: serverPosition.clone() });
      if (_name !== 'use_item') return;
      if (bot.heldItem.name !== 'water_bucket') return; // scoop-back is covered by minecraftDragonFight; count pours only
      const eye = serverPosition.offset(0, 1.62, 0);
      const yaw = Math.PI - (data.rotation?.x ?? 180) * Math.PI / 180;
      const pitch = -(data.rotation?.y ?? 0) * Math.PI / 180;
      const direction = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
      let source: Vec3 | null = null;
      for (let distance = 0; distance <= 4.5; distance += 0.005) {
        const at = eye.plus(direction.scaled(distance)), block = bot.blockAt(at);
        if (block.boundingBox === 'block') { source = at.floored().offset(0, 1, 0); break; }
      }
      sends.push({ tick, eye, source, reachable: source !== null, pitch });
      if (source && !rejectUse && bot.heldItem.name === 'water_bucket') {
        bot.heldItem = { ...bot.heldItem, name: 'bucket' };
        if (waterDelayTicks === 0) observe(source);
        else pending.push({ tick: tick + waterDelayTicks, source });
      }
    } },
    activateItem: () => bot._client.write('use_item', { rotation: { x: 180, y: 0 } }),
    deactivateItem: () => undefined,
  });
  const memory: FallMemory = {};
  function observe(source: Vec3) {
    const old = { ...bot.blockAt(source), position: source };
    water.set(cellKey(source), source);
    bot.emit('blockUpdate', old, { ...bot.blockAt(source), position: source });
  }
  const emit = () => {
    tick++;
    bot.emit('physicsTick');
    for (const update of pending.filter(update => update.tick === tick)) observe(update.source);
    const old = serverPosition.clone();
    const p = bot.entity.position;
    bot._client.write(positionPacket, { x: p.x, y: p.y, z: p.z });
    bot.emit('move', old);
  };
  const collisionTop = (p: Vec3) => {
    let highest = -Infinity;
    for (let x = Math.floor(p.x - 0.3 + 1e-6); x <= Math.floor(p.x + 0.3 - 1e-6); x++)
      for (let z = Math.floor(p.z - 0.3 + 1e-6); z <= Math.floor(p.z + 0.3 - 1e-6); z++) highest = Math.max(highest, top(x, z));
    return highest;
  };
  return { bot, memory, sends, water, emit, collisionTop, wire, get tick() { return tick; } };
}

/** 843f814's physicsTick + predicted-eye decision, restricted to these flat, loaded full-cube fixtures.
 * The forecast, eye and rotation formula are copied from the old targetForPour; only bucket preparation is omitted. */
function legacyPhysicsPour(f: ReturnType<typeof rig>, floor: number) {
  const listener = () => {
    const b = f.bot.entity, v = b.velocity;
    if (b.onGround || v.y > -0.75) return;
    let feet = b.position.clone(), vy = v.y;
    for (let tick = 0; tick < 8; tick++) {
      vy = nextVy(vy); feet = feet.offset(v.x, vy, v.z);
      if (feet.y > floor) continue;
      const eye = b.position.offset(v.x, nextVy(v.y) + 1.62, v.z);
      const aim = new Vec3(Math.floor(feet.x) + 0.5, floor, Math.floor(feet.z) + 0.5).minus(eye);
      if (eye.y <= floor || aim.norm() > 4.4) return;
      const yaw = Math.atan2(-aim.x, -aim.z), pitch = Math.atan2(aim.y, Math.hypot(aim.x, aim.z));
      f.bot._client.write('use_item', { rotation: { x: (180 / Math.PI) * (Math.PI - yaw), y: -(180 / Math.PI) * pitch } });
      f.bot.removeListener('physicsTick', listener);
      return;
    }
  };
  f.bot.on('physicsTick', listener);
}

function packedRig(full = false, clickMs = 40, floorTop: number | ((x: number, z: number) => number) = 65) {
  const f = rig(typeof floorTop === 'function' ? floorTop : () => floorTop), slots: Array<{ name: string; slot: number } | null> = Array(46).fill(null);
  slots[36] = { name: 'iron_sword', slot: 36 };
  if (full) for (let slot = 37; slot <= 44; slot++) slots[slot] = { name: `hotbar_${slot}`, slot };
  if (full) for (let slot = 9; slot < 36; slot++) slots[slot] = { name: `pack_${slot}`, slot };
  slots[20] = { name: 'water_bucket', slot: 20 };
  const packets: Array<{ name: string; slot?: number; mode?: number }> = [];
  const original = f.bot._client.write;
  const bot = Object.assign(f.bot, {
    quickBarSlot: 0, heldItem: slots[36]!,
    supportFeature: () => false,
    updateHeldItem: () => { bot.heldItem = slots[36 + bot.quickBarSlot]!; },
    inventory: {
      items: () => slots.filter((item): item is NonNullable<typeof item> => item !== null), slots,
      firstEmptySlotRange: (start: number, end: number) => {
        for (let slot = start; slot < end; slot++) if (!slots[slot]) return slot;
        return null;
      },
    },
    // Model native click completion/ACK latency. A full destination needs a third click to put the displaced stack back.
    moveSlotItem: async (source: number, destination: number) => {
      const moved = slots[source]!, displaced = slots[destination];
      await click(source);
      await click(destination);
      slots[destination] = { ...moved, slot: destination }; slots[source] = null; bot.updateHeldItem();
      if (displaced) { await click(source); slots[source] = { ...displaced, slot: source }; }
    },
  });
  async function click(slot: number) {
    // Includes a delay before write, like native clickWindow's recent-dig wait: an entry-only port guard is insufficient.
    await new Promise(resolve => setTimeout(resolve, clickMs));
    bot._client.write('window_click', { slot, mode: 0 } as never);
  }
  bot._client.write = ((name: string, data: any) => {
    if (['window_click', 'held_item_slot', 'use_item'].includes(name)) packets.push({ name, slot: data.slot ?? data.slotId, mode: data.mode });
    original(name, data);
    if (name === 'use_item') slots[36 + bot.quickBarSlot] = bot.heldItem;
  }) as typeof original;
  injectInventory(bot);
  // Capture the actual equip without replacing the implementation.
  const equip = vi.spyOn(bot as unknown as FallBody & { equip: NonNullable<FallBody['equip']> }, 'equip');
  return { ...f, bot: bot as typeof bot & Required<Pick<FallBody, 'equip' | 'setQuickBarSlot'>>, slots, packets, equip };
}

// r233-report.json scenes.end_bed_kill.knocks[0].trajectory, ticks 2664..2715 (tick, x/y/z, vx/vy/vz).
// Inline evidence keeps the regression independent of the untracked lab reports. These are test coordinates only.
const r233Frames = [
  [2664, 1.6261382898425467, 142.84630850284884, -4.3660775357695725, -0.03949651401529117, -0.07066830821567566, 0.25791870618455237],
  [2665, 1.5866417758272555, 142.77564019463316, -4.10815882958502, -0.039798759292004014, -0.14765494492513206, 0.25989241735030205],
  [2666, 1.5468430165352516, 142.62798524970802, -3.848266412234718, -0.040073802493812705, -0.2231018503688029, 0.2616884945111343],
  [2667, 1.5067692140414388, 142.4048833993392, -3.586577917723584, -0.04032409180745861, -0.29703981914263583, 0.26332292472749164],
  [2668, 1.4664451222339803, 142.10784358019657, -3.3232549929960924, -0.04055185508287639, -0.36949902995124695, 0.2648102562243768],
  [2669, 1.425893267151104, 141.73834455024533, -3.0584447367717154, -0.04075911966350657, -0.44050905792573564, 0.2661637278865423],
  [2670, 1.3851341474875973, 141.2978354923196, -2.792281008885173, -0.04094773043188003, -0.5100988866951434, 0.2673953870991129],
  [2671, 1.3441864170557174, 140.78773660562445, -2.5248856217860602, -0.04111936623109989, -0.5782969202164835, 0.2685161969825522],
  [2672, 1.3030670508246176, 140.20943968540797, -2.256369424803508, -0.04127555480838995, -0.6451309943681711, 0.2695361339764819],
  [2673, 1.2617914960162275, 139.5643086910398, -1.986833290827026, -0.04141768641372391, -0.7106283883115838, 0.27046427664095796],
  [2674, 1.2203738096025036, 138.8536803027282, -1.7163690141860684, -0.04154702617457781, -0.7748158356253918, 0.27130888646563117],
  [2675, 1.1788267834279258, 138.07886446710282, -1.4450601277204371, -0.04166472535695486, -0.8377195352172021, 0.2720774814060838],
  [2676, 1.137162058070971, 137.24114493188563, -1.1729826463143533, 0, -0.899365162016969, 0],
  [2677, 1.137162058070971, 136.34177976986865, -1.1729826463143533, -0.003856931538089053, -0.9597778774565376, 0.025186394722359413],
  [2678, 1.137162058070971, 135.38200189241212, -1.1729826463143533, -0.003856931538089053, -1.018982339739596, 0.025186394722359413],
  [2679, 1.1333051265328817, 134.3630195526725, -1.147796251591994, -0.007366739237750091, -1.0770027139062288, 0.04810601391970648],
  [2680, 1.1259383872951316, 133.28601683876627, -1.0996902376722875, -0.010560664244441636, -1.1338626816961797, 0.06896286738929232],
  [2681, 1.1153777230506898, 132.1521541570701, -1.030727370282995, -0.013467136000530943, -1.1895854512148494, 0.08794260404661543],
  [2682, 1.1019105870501589, 130.96256870585526, -0.9427847662363797, -0.01611202529857221, -1.2441937664059732, 0.10521416440477944],
  [2683, 1.1019105870501589, 129.7183749394493, -0.9427847662363797, -0.003856931538089053, -1.2977099163348456, 0.025186394722359413],
  [2684, 1.0980536555120697, 128.42066502311445, -0.9175983715140204, -0.007366739237750091, -1.35015574428588, 0.04810601391970648],
  [2685, 1.0906869162743196, 127.07050927882857, -0.8694923575943139, -0.010560664244441636, -1.4015526566782186, 0.06896286738929232],
  [2686, 1.0801262520298778, 125.66895662215035, -0.8005294902050215, -0.013467136000530943, -1.4519216318030286, 0.08794260404661543],
  [2687, 1.0801262520298778, 124.21703499034732, -0.8005294902050215, -0.003856931538089053, -1.5012832283860544, 0.025186394722359413],
  [2688, 1.0762693204917886, 122.71575176196126, -0.7753430954826621, -0.007366739237750091, -1.5496575939789174, 0.04810601391970648],
  [2689, 1.0689025812540385, 121.16609416798234, -0.7272370815629556, -0.010560664244441636, -1.597064473182591, 0.06896286738929232],
  [2690, 1.0583419170095967, 119.56902969479975, -0.6582742141736633, -0.013467136000530943, -1.6435232157064055, 0.08794260404661543],
  [2691, 1.0448747810090657, 117.92550647909334, -0.5703316101270479, -0.01611202529857221, -1.689052784265874, 0.10521416440477944],
  [2692, 1.0448747810090657, 116.23645369482747, -0.5703316101270479, -0.003856931538089053, -1.7336717623225606, 0.025186394722359413],
  [2693, 1.0410178494709765, 114.50278193250492, -0.5451452154046885, -0.007366739237750091, -1.777398361669153, 0.04810601391970648],
  [2694, 1.0336511102332264, 112.72538357083576, -0.4970392014849821, -0.010560664244441636, -1.8202504298628324, 0.06896286738929232],
  [2695, 1.0230904459887846, 110.90513314097292, -0.42807633409568974, -0.013467136000530943, -1.8622454575099763, 0.08794260404661543],
  [2696, 1.0230904459887846, 109.04288768346295, -0.42807633409568974, -0.003856931538089053, -1.903400585405169, 0.025186394722359413],
  [2697, 1.0192335144506954, 107.13948709805778, -0.40288993937333034, -0.007366739237750091, -1.9437326115274296, 0.04810601391970648],
  [2698, 1.0118667752129453, 105.19575448653036, -0.35478392545362386, -0.010560664244441636, -1.9832579978965172, 0.06896286738929232],
  [2699, 1.0013061109685035, 103.21249648863385, -0.2858210580643315, -0.013467136000530943, -2.02199287729211, 0.08794260404661543],
  [2700, 0.9878389749679726, 101.19050361134174, -0.1978784540177161, -0.01611202529857221, -2.0599530598386004, 0.10521416440477944],
  [2701, 0.9878389749679726, 99.13055055150313, -0.1978784540177161, -0.003856931538089053, -2.097154039458194, 0.025186394722359413],
  [2702, 0.9839820434298834, 97.03339651204494, -0.1726920592953567, -0.007366739237750091, -2.1336110001949478, 0.04810601391970648],
  [2703, 0.9839820434298834, 94.89978551185, -0.1726920592953567, -0.003856931538089053, -2.1693388224123282, 0.025186394722359413],
  [2704, 0.9801251118917942, 92.73044668943767, -0.1475056645729973, -0.007366739237750091, -2.204352088866815, 0.04810601391970648],
  [2705, 0.9727583726540441, 90.52609460057086, -0.09939965065329082, -0.010560664244441636, -2.238665090660037, 0.06896286738929232],
  [2706, 0.9621977084096023, 88.28742950991082, -0.030436783263998513, -0.013467136000530943, -2.272291833071863, 0.08794260404661543],
  [2707, 0.9487305724090713, 86.01513767683896, 0.0575058207826169, -0.01611202529857221, -2.305246041276832, 0.10521416440477944],
  [2708, 0.9487305724090713, 83.70989163556213, 0.0575058207826169, -0.003856931538089053, -2.337541165946253, 0.025186394722359413],
  [2709, 0.9448736408709821, 81.37235046961588, 0.08269221550497632, -0.007366739237750091, -2.3691903887382666, 0.04810601391970648],
  [2710, 0.937506901633232, 79.00316008087762, 0.1307982294246828, -0.010560664244441636, -2.400206627678101, 0.06896286738929232],
  [2711, 0.937506901633232, 76.60295345319952, 0.1307982294246828, -0.003856931538089053, -2.430602542430726, 0.025186394722359413],
  [2712, 0.9336499700951428, 74.1723509107688, 0.15598462414704223, -0.007366739237750091, -2.460390539468055, 0.04810601391970648],
  [2713, 0.9262832308573927, 71.71196037130075, 0.2040906380667487, -0.010560664244441636, -2.489582777132798, 0.06896286738929232],
  [2714, 0.9157225666129509, 69.22237759416795, 0.273053505456041, -0.013467136000530943, -2.5181911706010442, 0.08794260404661543],
  [2715, 0.90225543061242, 68, 0.3609961095026564, -0.012255093760483159, -0.0784000015258789, 0.08002776968242004],
] as const;
const r233Top = (x: number, z: number) => x === 0 && z === 0 ? 68 : 64;

afterEach(() => { vi.useRealTimers(); });

describe('r224/r225 packet order and target water confirmation', () => {
  const replays = [
    { round: 224, oldTick: 2026, newTick: 2027, previousEyeHeight: 6.336308105325671, frames: [
      [2025, -5.194960240307605, 69.71630810532567, 7.975961519272122, 0.12327883979143109, -1.6208084776877505, -0.17530631025644572],
      [2026, -5.071681400516174, 68.09549962763792, 7.800655209015677, 0.12684056773525784, -1.6667923405743428, -0.18037119718291195],
      [2027, -4.944840832780916, 66.42870728706357, 7.620284011832765, 0.13008174016414017, -1.711856527080276, -0.18498024428599624],
      [2028, -4.814759092616776, 65, 7.435303767546769, 0.11837438354936757, -0.0784000015258789, -0.1683320223002566],
    ] },
    { round: 225, oldTick: 5882, newTick: 5883, previousEyeHeight: 8.598070386232152, frames: [
      [5881, 1.6041737753252698, 71.97807038623215, -1.7623803404050153, 0.04765928366461286, -2.4503554728747945, -0.2703021641418133],
      [5882, 1.6518330589898826, 69.52771491335736, -2.0326825045468286, 0.04779429835125807, -2.4797484116799993, -0.2710679071237672],
      [5883, 1.6996273573411407, 67.04796650167737, -2.303750411670596, 0.04791716171610521, -2.508553492269726, -0.2717647332373453],
      [5884, 1.7475445190572458, 65, -2.575515144907941, 0.04360461716165574, -0.0784000015258789, -0.24730590724598422],
    ] },
  ];

  it.each(replays)('r$round: legacy sends from P(N-1) out of reach; move sends from the first in-reach P(N)', async replay => {
    vi.useFakeTimers();
    for (const legacy of [true, false]) {
      const f = rig(), b = f.bot.entity;
      b.position.y = replay.frames[0][2]; b.velocity.y = replay.frames[0][5];
      let running: ReturnType<typeof runFallClutch> | undefined;
      if (legacy) legacyPhysicsPour(f, 65);
      else running = runFallClutch(f.bot, f.bot, f.memory);
      for (const [index, [, x, y, z, vx, vy, vz]] of replay.frames.entries()) {
        Object.assign(b, { position: new Vec3(x, y, z), velocity: new Vec3(vx, vy, vz), onGround: index === replay.frames.length - 1 });
        f.emit();
        await vi.advanceTimersByTimeAsync(50);
      }
      await vi.advanceTimersByTimeAsync(3000);
      const result = await running;
      expect(f.sends).toHaveLength(1);
      const send = f.sends[0], useIndex = f.wire.findIndex(p => p.name === 'use_item');
      expect(replay.frames[send.tick - 1][0]).toBe(legacy ? replay.oldTick : replay.newTick);
      expect(send.reachable).toBe(!legacy);
      if (legacy) {
        expect(send.eye.y - 65).toBeCloseTo(replay.previousEyeHeight, 10);
        expect(f.wire[useIndex - 1].tick).toBe(send.tick - 1);
        expect(f.wire[useIndex + 1]).toMatchObject({ name: 'position', tick: send.tick });
        expect(f.water.size).toBe(0);
      } else {
        expect(send.eye.distanceTo(send.source!.offset(0.5, 0, 0.5))).toBeLessThanOrEqual(CLUTCH_REACH);
        expect(f.wire[useIndex - 1]).toMatchObject({ name: 'position', tick: send.tick });
        expect(f.water.size).toBe(1);
        expect(f.memory.waterObserved).toHaveLength(1);
        expect(result?.result).toContain('waterObserved=あり');
      }
    }
  });

  it.each([0, 1, 2])('retains the target blockUpdate at %s tick(s), independently of the bucket slot update', async delay => {
    vi.useFakeTimers();
    const f = rig(() => 65, 'end_stone', delay), b = f.bot.entity;
    b.position.y = 67; b.velocity.y = -2.4;
    const running = runFallClutch(f.bot, f.bot, f.memory);
    f.emit();
    expect(f.bot.heldItem.name).toBe('bucket'); // slot ACK alone is not water
    if (delay > 0) {
      expect(f.memory.waterObserved).toEqual([]);
      f.bot.emit('blockUpdate', null, null);
      f.bot.emit('blockUpdate', null, { name: 'water', position: new Vec3(1, 65, 0) });
      f.bot.emit('blockUpdate', null, { name: 'air', position: new Vec3(0, 65, 0) });
      expect(f.memory.waterObserved).toEqual([]);
    }
    for (let n = 0; n < delay; n++) f.emit();
    expect(f.memory.pour).toMatchObject({ x: 0, y: 65, z: 0, ticks: delay, status: 'water_observed' });
    expect(f.memory.waterObserved).toEqual([expect.objectContaining({ x: 0, y: 65, z: 0, ticks: delay })]);
    b.position.y = 65; b.onGround = true;
    await vi.advanceTimersByTimeAsync(3000);
    expect((await running).result).toContain(`waterObserved=あり（${delay}tick後）`);
    for (const event of ['physicsTick', 'move', 'blockUpdate', 'end']) expect(f.bot.listenerCount(event)).toBe(0);
  });

  it.each(['position', 'position_look'])('writes use after %s and never from physicsTick alone', async packet => {
    vi.useFakeTimers();
    const f = rig(() => 65, 'end_stone', 1, false, packet), b = f.bot.entity;
    b.position.y = 67; b.velocity.y = -2.4;
    const running = runFallClutch(f.bot, f.bot, f.memory);
    f.bot.emit('physicsTick');
    expect(f.sends).toHaveLength(0);
    f.emit();
    expect(f.wire.map(p => p.name)).toEqual([packet, 'use_item']);
    b.onGround = true; f.emit();
    await vi.advanceTimersByTimeAsync(3000); await running;
  });

  it('accepts a target water update after the second tick position/move, before the next physicsTick', async () => {
    vi.useFakeTimers();
    const f = rig(() => 65, 'end_stone', 99), b = f.bot.entity;
    b.position.y = 67; b.velocity.y = -2.4;
    const running = runFallClutch(f.bot, f.bot, f.memory);
    f.emit(); f.emit(); f.emit(); // pour, tick 1, tick 2; all in one JS turn
    expect(f.memory.pour?.status).toBe('sent_unconfirmed');
    const source = new Vec3(0, 65, 0);
    f.water.set(cellKey(source), source);
    f.bot.emit('blockUpdate', null, { name: 'water', position: source });
    expect(f.memory.pour).toMatchObject({ ticks: 2, status: 'water_observed' });
    b.position.y = 65; b.onGround = true;
    await vi.advanceTimersByTimeAsync(3000); await running;
  });

  it.each(['two_ticks', 'stalled', 'end', 'abort'])('reports unconfirmed water and cleans up after %s', async stop => {
    vi.useFakeTimers();
    const f = rig(() => 65, 'end_stone', 1, true), b = f.bot.entity;
    b.position.y = 67; b.velocity.y = -2.4;
    const running = executeAction(f.bot as never, 'floor-clutch', 8000,
      (() => runFallClutch(f.bot, createMotorPort(f.bot), f.memory)) as never,
      { priority: 380, safetyLease: true, waitForQuiescence: false });
    await vi.advanceTimersByTimeAsync(0);
    f.emit();
    if (stop === 'two_ticks') { f.emit(); f.emit(); f.emit(); } // next physicsTick closes the two completed tick intervals
    if (stop === 'stalled') await vi.advanceTimersByTimeAsync(151);
    if (stop === 'end') f.bot.emit('end');
    if (stop === 'abort') preemptLowerPriorityActions(f.bot, 500, 'wall-escape');
    // A late real update can exist without having been confirmed in the two-tick window.
    f.bot.emit('blockUpdate', null, { name: 'water', position: new Vec3(0, 65, 0) });
    b.onGround = true; b.position.y = 65;
    await vi.advanceTimersByTimeAsync(3000);
    const result = await running;
    expect(result.success).toBe(false);
    if (stop !== 'abort') expect(result.result).toContain('waterObserved=なし');
    expect(f.memory.pour?.status).toBe('sent_unconfirmed');
    expect(f.memory.waterObserved).toEqual([]);
    for (const event of ['physicsTick', 'move', 'blockUpdate', 'end']) expect(f.bot.listenerCount(event)).toBe(0);
  });

  it('never pours on a grounded move even if the current eye is in reach', async () => {
    vi.useFakeTimers();
    const f = rig(); f.bot.entity.velocity.y = -3.9;
    const running = runFallClutch(f.bot, f.bot, f.memory);
    f.bot.entity.position.y = 65; f.bot.entity.onGround = true; f.emit();
    expect(await running).toMatchObject({ success: false });
    expect(f.sends).toHaveLength(0); expect(f.memory.pour).toBeUndefined();
  });

  it('sends nothing when a stronger owner takes the body between physicsTick and its position/move', async () => {
    vi.useFakeTimers();
    const f = rig(), b = f.bot.entity;
    b.position.y = 67; b.velocity.y = -2.4;
    const running = executeAction(f.bot as never, 'floor-clutch', 8000,
      (() => runFallClutch(f.bot, createMotorPort(f.bot), f.memory)) as never,
      { priority: 380, safetyLease: true, waitForQuiescence: false });
    await vi.advanceTimersByTimeAsync(0);
    f.bot.once('physicsTick', () => preemptLowerPriorityActions(f.bot, 500, 'wall-escape'));
    f.emit();
    expect(await running).toMatchObject({ success: false, failureType: 'interrupted' });
    expect(f.sends).toHaveLength(0);
    expect(f.memory.pour).toBeUndefined();
    for (const event of ['physicsTick', 'move', 'blockUpdate', 'end']) expect(f.bot.listenerCount(event)).toBe(0);
  });
});

describe('airborne reach window skipped by fast falls', () => {
  it('quantifies uniform last-step phases for vy -2.0 .. -3.9 at 0.1 intervals (10000 phases each)', () => {
    const samples = 10000, window = CLUTCH_REACH - 1.62;
    const rows: Array<{ vy: number; misses: number; percent: number }> = [];
    for (let tenth = 20; tenth <= 39; tenth++) {
      const speed = tenth / 10;
      let misses = 0;
      for (let index = 0; index < samples; index++) {
        // Constant speed over the final step, vertical aim at the cell centre, uniformly spaced midpoint phases.
        const lastAirborneHeight = speed * (index + 0.5) / samples;
        const inReach = [lastAirborneHeight + speed, lastAirborneHeight, 0].some(height => height > 0 && height + 1.62 <= CLUTCH_REACH);
        if (!inReach) misses++;
      }
      const expected = Math.max(0, 1 - window / speed);
      expect(Math.abs(misses / samples - expected)).toBeLessThanOrEqual(1 / samples);
      rows.push({ vy: -speed, misses, percent: misses / samples * 100 });
    }
    console.info('fallClutch skipped-window simulation:', JSON.stringify(rows));
  });

  it.each([-2.0, -2.8, -3.0, -3.5, -3.9])('actual move hook at vy=%s sends only if an airborne in-reach sample exists', async vy => {
    vi.useFakeTimers();
    for (const clearance of [0.5, 2.5, 2.79, 3.2]) {
      if (clearance >= -vy) continue;
      const f = rig(), b = f.bot.entity;
      b.position.y = 65 + clearance - vy; b.velocity.y = vy;
      const running = runFallClutch(f.bot, f.bot, f.memory);
      f.emit();
      b.position.y = 65 + clearance; f.emit();
      const canPour = clearance + 1.62 <= CLUTCH_REACH;
      expect(f.sends).toHaveLength(canPour ? 1 : 0);
      b.position.y = 65; b.onGround = true; f.emit();
      await vi.advanceTimersByTimeAsync(3000); await running;
      expect(f.water.size).toBe(canPour ? 1 : 0);
    }
  });
});

describe('pack bucket preparation and forecast start (r220)', () => {
  it.each([false, true])('equips a pack bucket through the motor and pours before landing; full hotbar=%s', async full => {
    vi.useFakeTimers();
    const f = packedRig(full), b = f.bot.entity;
    b.velocity.y = -1.6;
    expect(clutchWanted(f.bot, f.memory, 1000)).not.toBeNull();
    const running = executeAction(f.bot as never, 'floor-clutch', 8000,
      (() => runFallClutch(f.bot, createMotorPort(f.bot), f.memory)) as never,
      { priority: 380, safetyLease: true, waitForQuiescence: false, legacyExecutingSkill: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.equip).toHaveBeenCalledWith(expect.objectContaining({ name: 'water_bucket', slot: 20 }), 'hand');
    for (let n = 0; n < 50 && !b.onGround; n++) {
      b.position = b.position.plus(b.velocity); b.velocity.y = nextVy(b.velocity.y);
      if (b.position.y <= 65) { b.position.y = 65; b.onGround = true; }
      b.isInWater = f.water.has(cellKey(b.position));
      f.emit(); await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(4000);
    expect(await running).toMatchObject({ success: true });
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0].reachable).toBe(true);
    expect(f.packets.filter(p => p.name === 'window_click').map(p => p.slot)).toEqual(full ? [20, 36, 20] : [20, 37]);
    // Native LRU moves the displaced stack back into the bucket's old pack slot; no empty hotbar slot or discarded stack is needed.
    if (full) expect(f.slots[20]).toEqual({ name: 'iron_sword', slot: 20 });
    else expect(f.bot.heldItem.name).toBe('iron_sword');
    expect(f.bot.listenerCount('physicsTick')).toBe(0);
    expect(f.bot.listenerCount('end')).toBe(0);
  });

  it.each([1, 2, 3])('does not start a pack swap with only %s tick(s) until impact, even if damage is lethal', async left => {
    vi.useFakeTimers();
    const f = packedRig(), b = f.bot.entity;
    b.position.y = 65 + left * 2; b.velocity.y = -2.4; f.memory.from = 168;
    expect(clutchWanted(f.bot, f.memory, 1000)).toBeNull();
    expect(await runFallClutch(f.bot, f.bot, f.memory)).toMatchObject({ success: false });
    expect(f.equip).not.toHaveBeenCalled();
    expect(f.packets).toHaveLength(0);
  });

  it('refuses pack preparation without equip capability or a known source slot', () => {
    const f = packedRig(); f.bot.entity.velocity.y = -1.6;
    const equip = f.bot.equip;
    (f.bot as FallBody).equip = undefined;
    expect(clutchWanted(f.bot, f.memory, 1000)).toBeNull();
    f.bot.equip = equip;
    delete (f.slots[20] as { slot?: number }).slot;
    expect(clutchWanted(f.bot, f.memory, 1000)).toBeNull();
    expect(f.packets).toHaveLength(0);
  });

  it('ends pack preparation after three catch-up ticks even if no wall time has passed', async () => {
    vi.useFakeTimers();
    const f = packedRig(true, 250); f.bot.entity.velocity.y = -1.6;
    const running = runFallClutch(f.bot, f.bot, f.memory);
    for (let i = 0; i < 4; i++) f.emit();
    expect(await running).toMatchObject({ success: false });
    await vi.advanceTimersByTimeAsync(300);
    expect(f.packets.filter(p => p.name === 'window_click')).toHaveLength(0);
    expect(f.bot.listenerCount('physicsTick')).toBe(0);
  });

  it('retains the immediate hotbar path at the last pour opportunity and prefers it over a pack duplicate', async () => {
    vi.useFakeTimers();
    const f = packedRig(), b = f.bot.entity;
    f.slots[40] = { name: 'water_bucket', slot: 40 };
    b.position.y = 67; b.velocity.y = -2.4; f.memory.from = 168;
    expect(clutchWanted(f.bot, f.memory, 1000)).not.toBeNull();
    const running = runFallClutch(f.bot, f.bot, f.memory);
    f.emit(); b.onGround = true; b.position.y = 65;
    await vi.advanceTimersByTimeAsync(4000); await running;
    expect(f.equip).not.toHaveBeenCalled();
    expect(f.packets.filter(p => p.name === 'window_click')).toHaveLength(0);
    expect(f.sends).toHaveLength(1);
  });

  it('fences delayed native clicks after preemption, releases promptly, and permits the next owner to select its hand', async () => {
    vi.useFakeTimers();
    const f = packedRig(true), b = f.bot.entity;
    b.velocity.y = -1.6;
    const original = f.bot._client.write;
    const running = executeAction(f.bot as never, 'floor-clutch', 8000,
      (() => runFallClutch(f.bot, createMotorPort(f.bot), f.memory)) as never,
      { priority: 380, safetyLease: true, waitForQuiescence: false, legacyExecutingSkill: true });
    await vi.advanceTimersByTimeAsync(50); // first native click sent; second is waiting inside the bare-bot method
    expect(f.packets.filter(p => p.name === 'window_click')).toHaveLength(1);
    preemptLowerPriorityActions(f.bot, 500, 'wall-escape');
    await vi.advanceTimersByTimeAsync(0);
    expect(await running).toMatchObject({ success: false, failureType: 'interrupted' });
    expect(f.bot.listenerCount('physicsTick')).toBe(0);
    const next = executeAction(f.bot as never, 'wall-escape', 1000,
      (async () => { createMotorPort(f.bot).setQuickBarSlot(2); return { success: true, result: 'fixture' }; }) as never,
      { priority: 500, safetyLease: true, waitForQuiescence: false });
    await vi.advanceTimersByTimeAsync(0); await next;
    const afterCut = f.packets.length;
    b.position.y = 69; b.velocity.y = -2.4; f.emit();
    await vi.advanceTimersByTimeAsync(300);
    expect(f.packets).toHaveLength(afterCut);
    expect(f.packets[f.packets.length - 1]).toMatchObject({ name: 'held_item_slot', slot: 2 });
    expect(f.sends).toHaveLength(0);
    expect(f.bot._client.write).toBe(original);
    expect(f.memory.scoop).toBeUndefined();
  });

  it('sends nothing if ownership is taken before pack equip begins', async () => {
    vi.useFakeTimers();
    const f = packedRig(); f.bot.entity.velocity.y = -1.6;
    const running = executeAction(f.bot as never, 'floor-clutch', 8000, (() => {
      preemptLowerPriorityActions(f.bot, 500, 'wall-escape');
      return runFallClutch(f.bot, createMotorPort(f.bot), f.memory);
    }) as never, { priority: 380, safetyLease: true, waitForQuiescence: false });
    await vi.advanceTimersByTimeAsync(300);
    expect(await running).toMatchObject({ success: false, failureType: 'interrupted' });
    expect(f.equip).not.toHaveBeenCalled(); expect(f.packets).toHaveLength(0);
  });

  it.each(['timeout', 'end', 'dead', 'landed'])('stops a slow equip on %s and blocks its later native packets', async reason => {
    vi.useFakeTimers();
    const f = packedRig(true, 250); f.bot.entity.velocity.y = -1.6;
    const original = f.bot._client.write;
    const running = runFallClutch(f.bot, f.bot, f.memory);
    if (reason === 'end') f.bot.emit('end');
    if (reason === 'dead') { f.bot.health = 0; f.emit(); }
    if (reason === 'landed') { f.bot.entity.onGround = true; f.emit(); }
    await vi.advanceTimersByTimeAsync(160);
    expect(await running).toMatchObject({ success: false });
    const afterStop = f.packets.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(f.packets).toHaveLength(afterStop);
    expect(f.sends).toHaveLength(0);
    expect(f.bot._client.write).toBe(original);
    expect(f.bot.listenerCount('physicsTick')).toBe(0);
    expect(f.bot.listenerCount('end')).toBe(0);
  });

  it('reproduces r220 depth exhaustion, then starts at 8411 with 29 ticks until ground despite the bucket being in the pack', () => {
    const f = packedRig(false, 40, 64), b = f.bot.entity;
    // Same local surface as the descending r220 samples; no fixture coordinates are used by the implementation.
    const at = (y: number, vy: number) => { b.position.y = y; b.velocity = new Vec3(-0.05, vy, 0.04); };
    at(168.44968243998906, -0.06757544541092037);
    expect(clutchWanted(f.bot, f.memory, 1000)).toBeNull();
    at(164.48534267783214, -0.7722887410403505); // 8388
    expect(groundUnder(bodyReader(f.bot as never), b.position).kind).toBe('void');
    expect(clutchWanted(f.bot, f.memory, 2000)).toBeNull();
    at(134.7198898466626, -1.9017802857172537); // 8410: block y=63 lies outside the 70-cell scan
    expect(groundUnder(bodyReader(f.bot as never), b.position).kind).toBe('void');
    expect(clutchWanted(f.bot, f.memory, 3000)).toBeNull();
    at(132.81810956094535, -1.9421447178023679); // 8411
    expect(groundUnder(bodyReader(f.bot as never), b.position).kind).toBe('floor');
    expect(clutchWanted(f.bot, f.memory, 3050)).not.toBeNull();
    expect(8440 - 8411).toBe(29);
  });

  it('equips early enough after r220 tick 8411 and pours at 8439 after its position packet', async () => {
    vi.useFakeTimers();
    const f = packedRig(true, 40, 64), b = f.bot.entity;
    const frames = [
      [8411, 11.851234113797528, 132.81810956094535, -8.498072511543468, -0.05656363307977265, -1.9421447178023679, 0.04084066748540961],
      [8412, 11.794670480717755, 130.87596484314298, -8.457231844058057, -0.0721308926917508, -1.98170186201567, 0.052080703509531305],
      [8413, 11.794670480717755, 128.8942629811273, -8.457231844058057, -0.02065798658915768, -2.0204678640991984, 0.014915696097808559],
      [8414, 11.774012494128598, 126.8737951170281, -8.442316147960248, -0.03945675438529117, -2.0584585468804595, 0.02848897954681435],
      [8437, 9.771757087467941, 71.30613209759059, -6.99662670349042, -0.18334305787412541, -2.7503063814559865, 0.13237927719096687],
      [8438, 9.588414029593816, 68.5558257161346, -6.864247426299452, -0.18750016925461183, -2.773700307810677, 0.13538083834158843],
      [8439, 9.400913860339204, 65.78212540832394, -6.728866587957864, -0.19128314061085444, -2.7966263560844773, 0.13811225898865404],
      [8440, 9.209630719728349, 64, -6.59075432896921, -0.17406765795587756, -0.0784000015258789, 0.12568215567967517],
    ];
    f.memory.from = 168.44968243998906;
    let running: Promise<unknown> | undefined, sentTick: number | undefined;
    for (const [tick, x, y, z, vx, vy, vz] of frames) {
      Object.assign(b, { position: new Vec3(x, y, z), velocity: new Vec3(vx, vy, vz), onGround: tick === 8440 });
      if (!running) {
        expect(clutchWanted(f.bot, f.memory, Date.now())).not.toBeNull();
        running = runFallClutch(f.bot, createMotorPort(f.bot), f.memory);
      }
      f.emit();
      if (f.sends.length && sentTick === undefined) sentTick = tick;
      await vi.advanceTimersByTimeAsync(50);
      if (tick === 8414) expect(f.bot.heldItem.name).toBe('water_bucket');
    }
    await vi.advanceTimersByTimeAsync(4000); await running;
    expect(sentTick).toBe(8439);
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0]).toMatchObject({ reachable: true, source: { x: 9, y: 64, z: -7 } });
  });

  it('starts while over void when the forecast reaches the island, and pours onto that landing footprint', async () => {
    vi.useFakeTimers();
    const f = rig(x => x >= 3 ? 65 : -Infinity), b = f.bot.entity;
    b.position = new Vec3(0.5, 75, 0.5); b.velocity = new Vec3(1, -1.6, 0); f.memory.from = 100;
    expect(groundUnder(bodyReader(f.bot as never), b.position).kind).toBe('void');
    expect(clutchWanted(f.bot, f.memory, 1000)).not.toBeNull();
    const running = runFallClutch(f.bot, f.bot, f.memory);
    for (let n = 0; n < 12 && !b.onGround; n++) {
      b.position = b.position.plus(b.velocity); b.velocity.y = nextVy(b.velocity.y);
      if (b.position.y <= 65 && b.position.x >= 3) { b.position.y = 65; b.onGround = true; }
      b.isInWater = f.water.has(cellKey(b.position));
      f.emit(); await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(4000); await running;
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0].reachable).toBe(true);
    expect(f.sends[0].source!.x).toBeGreaterThanOrEqual(3);
  });

  it.each(['void', 'unknown', 'lava', 'water', 'partial'])('waits when every predicted footprint is %s; starts once a loaded full cube is seen', ground => {
    const f = rig(), b = f.bot.entity, original = f.bot.blockAt;
    b.position = new Vec3(0.5, 85, 0.5); b.velocity = new Vec3(5.1, -1.6, -3.7);
    let visible = false;
    f.bot.blockAt = p => {
      if (visible || p.y >= 65) return original(p);
      if (ground === 'unknown') return null as never;
      if (ground === 'partial') return { ...original(p), shapes: [[0, 0, 0, 1, 0.5, 1]] };
      return { ...original(p), name: ground === 'void' ? 'air' : ground, shapes: [], boundingBox: 'empty' };
    };
    expect(clutchWanted(f.bot, f.memory, 1000)).toBeNull();
    visible = true;
    expect(clutchWanted(f.bot, f.memory, 1050)).not.toBeNull();
  });
});

describe('r233 pack preparation after the horizontal forecast changes', () => {
  it('reproduces the 2676 start with carried horizontal velocity, then loses the forecast support at 2676/2677', () => {
    const f = packedRig(false, 40, r233Top), b = f.bot.entity;
    for (const [tick, x, y, z, vx, vy, vz] of r233Frames) {
      if (tick >= 2676) break;
      Object.assign(b, { position: new Vec3(x, y, z), velocity: new Vec3(vx, vy, vz) });
      expect(clutchWanted(f.bot, f.memory, 1000)).toBeNull();
    }
    const [, x, y, z, , vy] = r233Frames[2676 - 2664];
    const previous = r233Frames[2675 - 2664];
    // The report samples AFTER the handover: it does not contain the exact pre-stop vx/vz.
    // Carry the last observed horizontal velocity to show how the high (0,0) support was seen.
    Object.assign(b, { position: new Vec3(x, y, z), velocity: new Vec3(previous[4], vy, previous[6]) });
    expect(groundUnder(bodyReader(f.bot as never), b.position).kind).toBe('void');
    expect(groundUnder(bodyReader(f.bot as never), { x: 0.5, y, z: 0.5 })).toMatchObject({ kind: 'floor', top: 68, drop: 69 });
    expect(clutchWanted(f.bot, f.memory, 1000)).toBe('落ちて75ブロック（地面まであと69、受ける被害およそ72）');
    for (const tick of [2676, 2677]) {
      const [, fx, fy, fz, vx, fvy, vz] = r233Frames[tick - 2664];
      Object.assign(b, { position: new Vec3(fx, fy, fz), velocity: new Vec3(vx, fvy, vz) });
      // No floor is inside the forecast footprints' 70-cell columns after the horizontal stop.
      expect(clutchWanted(f.bot, f.memory, 1000)).toBeNull();
    }
  });

  it.each([false, true].flatMap(full => [2676, 2677].map(start => ({ full, start }))))('r233: starts pack equip at $start despite the missing support, then pours at 2714; full hotbar=$full', async ({ full, start }) => {
    vi.useFakeTimers();
    const f = packedRig(full, 40, r233Top), b = f.bot.entity;
    f.memory.from = r233Frames[0][2];
    let running: ReturnType<typeof runFallClutch> | undefined;
    for (const [tick, x, y, z, vx, vy, vz] of r233Frames) {
      Object.assign(b, { position: new Vec3(x, y, z), velocity: new Vec3(vx, vy, vz), onGround: tick === 2715, isInWater: f.water.has(cellKey(new Vec3(x, y, z))) });
      if (tick === start) {
        f.memory.clutchAt = Date.now(); // The floor already admitted this fall and started its unchanged 6s cooldown.
        running = runFallClutch(f.bot, createMotorPort(f.bot), f.memory);
        expect(f.equip, 'a lost support must not mean that only three ticks remain').toHaveBeenCalledTimes(1);
      }
      f.emit();
      await vi.advanceTimersByTimeAsync(50);
      if (tick === start + 2) expect(f.bot.heldItem.name).toBe('water_bucket');
    }
    await vi.advanceTimersByTimeAsync(4000);
    expect(await running).toMatchObject({ success: true });
    expect(f.sends).toHaveLength(1);
    expect(r233Frames[f.sends[0].tick - 1][0]).toBe(2714);
    expect(f.sends[0]).toMatchObject({ reachable: true, source: { x: 0, y: 68, z: 0 } });
    const use = f.wire.findIndex(packet => packet.name === 'use_item');
    expect(f.wire[use - 1]).toMatchObject({ name: 'position', tick: f.sends[0].tick });
    expect(f.memory.pour?.status).toBe('water_observed');
    expect(f.packets.filter(packet => packet.name === 'window_click').map(packet => packet.slot)).toEqual(full ? [20, 36, 20] : [20, 37]);
    if (full) expect(f.slots[20]).toEqual({ name: 'iron_sword', slot: 20 });
    for (const event of ['physicsTick', 'move', 'blockUpdate', 'end']) expect(f.bot.listenerCount(event)).toBe(0);
  });

  it.each([
    { drop: 69, vy: -1.1, allowed: true },
    { drop: 10, vy: -0.75, allowed: true },
    { drop: 10, vy: -2.4, allowed: false },
    { drop: 5, vy: -2.4, allowed: false },
    { drop: 5, vy: -0.75, allowed: false },
    { drop: 19, vy: -3.9, allowed: false }, // Four movements clear the old reach margin, but the fifth hits the floor.
  ])('shares the pack preparation decision at drop=$drop, vy=$vy between wanted and run', async ({ drop, vy, allowed }) => {
    vi.useFakeTimers();
    const f = packedRig(), b = f.bot.entity;
    b.position.y = 65 + drop; b.velocity.y = vy; f.memory.from = 170;
    expect(clutchWanted(f.bot, f.memory, 1000) !== null).toBe(allowed);
    const running = runFallClutch(f.bot, f.bot, f.memory);
    expect(f.equip).toHaveBeenCalledTimes(allowed ? 1 : 0);
    if (allowed) f.bot.emit('end');
    else expect((await running).result).toContain('持ち替え');
    await running;
    expect(f.packets.filter(packet => packet.name === 'window_click')).toHaveLength(0);
    if (!allowed) expect(f.packets).toHaveLength(0);
  });

  it('keeps the pour opportunity after equip settles even if a correction has already brought the floor into reach', async () => {
    vi.useFakeTimers();
    const f = packedRig(true), b = f.bot.entity;
    b.velocity.y = -1.1;
    const running = runFallClutch(f.bot, createMotorPort(f.bot), f.memory);
    b.position.y = 67; b.velocity.y = -2.4;
    await vi.advanceTimersByTimeAsync(120);
    expect(f.bot.heldItem.name).toBe('water_bucket');
    f.emit();
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0].reachable).toBe(true);
    b.position.y = 65; b.onGround = true; f.emit();
    await vi.advanceTimersByTimeAsync(4000); await running;
  });

  it('uses a higher forecast support for the budget even when the centre column is much deeper', async () => {
    const f = packedRig(false, 40, x => x >= 1 ? 94 : 65), b = f.bot.entity;
    b.velocity = new Vec3(0.5, -2.4, 0); f.memory.from = 170;
    expect(groundUnder(bodyReader(f.bot as never), b.position).drop).toBe(35);
    expect(clutchWanted(f.bot, f.memory, 1000)).toBeNull();
    expect(await runFallClutch(f.bot, f.bot, f.memory)).toMatchObject({ success: false });
    expect(f.equip).not.toHaveBeenCalled(); expect(f.packets).toHaveLength(0);
  });

  it.each(['unknown', 'lava', 'water', 'partial'])('refuses pack preparation over %s instead of treating it as a clear deep column', async kind => {
    const f = packedRig(), original = f.bot.blockAt;
    f.bot.entity.velocity.y = -1.1;
    f.bot.blockAt = p => {
      if (p.y >= 65) return original(p);
      if (kind === 'unknown') return null as never;
      return { ...original(p), name: kind === 'partial' ? 'end_stone' : kind, shapes: kind === 'partial' ? [[0, 0, 0, 1, 0.5, 1]] : [], boundingBox: kind === 'partial' ? 'block' : 'empty' };
    };
    expect(clutchWanted(f.bot, f.memory, 1000)).toBeNull();
    expect(await runFallClutch(f.bot, f.bot, f.memory)).toMatchObject({ success: false });
    expect(f.equip).not.toHaveBeenCalled(); expect(f.packets).toHaveLength(0);
  });
});

describe('fall clutch after position packets (last received position model)', () => {
  const matrix = { cases: 0, placed: 0, skippedWindow: 0, legacyUses: 0, legacyRejected: 0 };
  afterAll(() => console.info('fallClutch height/velocity matrix:', JSON.stringify(matrix)));
  it('replays r214 fatal final ticks: centre top 64, collision top 65; the old 4.2 check has no airborne sample', async () => {
    vi.useFakeTimers();
    const f = rig((_x, z) => z >= 2 ? 65 : 64, 'bedrock');
    const frames = [
      [-1.4725474993075245, 69.2468094052377, 2.0584381423203593, -2.364348011203669],
      [-1.257598274267116, 66.88246139403402, 1.8906578407404178, -2.3954610976018342],
      [-1.0419088755679375, 65, 1.722299790812388, -0.0784000015258789],
    ];
    Object.assign(f.bot.entity, { position: new Vec3(...frames[0].slice(0, 3) as [number, number, number]), velocity: new Vec3(0.214949225, frames[0][3], -0.167780302) });
    const running = runFallClutch(f.bot, f.bot, f.memory);
    const oldReach: number[] = [];
    for (const [i, [x, y, z, vy]] of frames.entries()) {
      Object.assign(f.bot.entity, { position: new Vec3(x, y, z), velocity: new Vec3(0.214949225, vy, -0.167780302), onGround: i === 2 });
      const ground = groundUnder(bodyReader(f.bot as never), f.bot.entity.position);
      if (i < 2) oldReach.push(y + 1.62 - ground.top);
      if (i === 1) { expect(ground.top).toBe(64); expect(f.collisionTop(f.bot.entity.position)).toBe(65); }
      f.emit();
      await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(3000);
    await running;
    expect(oldReach).toEqual([5.866809405237703, 4.502461394034029]);
    expect(oldReach.every(distance => distance > 4.2)).toBe(true);
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0]).toMatchObject({ tick: 2, reachable: true, source: { y: 65 } });
    expect(f.bot.listenerCount('physicsTick')).toBe(0);
  });

  const heights = [10, 15, 20, 30, 40, 50, 65, 80, 100, 110, 120, 150, 175, 200];
  for (const floor of [{ name: 'end_stone', top: 65 }, { name: 'bedrock', top: 68 }, { name: 'bedrock', top: -17 }]) {
    it.each(heights)(`${floor.name} top ${floor.top}: %dm fall, six initial velocities and three sub-block phases`, async height => {
      vi.useFakeTimers();
      for (const up of [0, 0.15, 0.3, -1, -2, -3.9]) for (const fraction of [0, 0.25, 0.75]) {
        const f = rig(() => floor.top, floor.name), b = f.bot.entity;
        const old = rig(() => floor.top, floor.name);
        legacyPhysicsPour(old, floor.top);
        b.position.y = floor.top + height + fraction; b.velocity.y = up;
        f.memory.from = b.position.y;
        // Both servers start knowing the configured P(0), including 10m falls with a fast initial descent.
        for (const initial of [f, old]) initial.bot._client.write('position', { x: b.position.x, y: b.position.y, z: b.position.z });
        let running: Promise<unknown> | undefined, landingTick = -1, firstOpportunity = -1;
        for (let n = 0; n < 220 && !b.onGround; n++) {
          b.position = b.position.plus(b.velocity);
          b.velocity.y = nextVy(b.velocity.y);
          if (b.position.y <= floor.top) { b.position.y = floor.top; b.onGround = true; landingTick = f.tick + 1; }
          b.isInWater = f.water.has(cellKey(b.position));
          if (!running && clutchWanted(f.bot, f.memory, Date.now())) running = runFallClutch(f.bot, f.bot, f.memory);
          const currentEyeToFloor = b.position.y + 1.62 - floor.top;
          if (running && firstOpportunity < 0 && !b.onGround && b.velocity.y <= -0.75 && currentEyeToFloor <= CLUTCH_REACH) firstOpportunity = f.tick + 1;
          Object.assign(old.bot.entity, { position: b.position.clone(), velocity: b.velocity.clone(), onGround: b.onGround });
          old.emit();
          f.emit();
          await vi.advanceTimersByTimeAsync(50);
        }
        await vi.advanceTimersByTimeAsync(3000);
        await running;
        expect(running, `height=${height}+${fraction}, up=${up}`).toBeDefined();
        expect(f.sends.length, `height=${height}+${fraction}, up=${up}`).toBe(firstOpportunity < 0 ? 0 : 1);
        if (firstOpportunity >= 0) {
          expect(f.sends[0].reachable).toBe(true);
          expect(f.sends[0].tick).toBe(firstOpportunity);
          expect(f.sends[0].tick).toBeLessThan(landingTick);
          const packet = f.wire.findIndex(p => p.name === 'use_item');
          expect(f.wire[packet - 1]).toMatchObject({ name: 'position', tick: firstOpportunity });
          expect(f.memory.pour?.status).toBe('water_observed');
        }
        expect(f.water.has(`${0},${floor.top},${0}`)).toBe(firstOpportunity >= 0);
        expect(old.sends.every(send => !send.reachable)).toBe(true);
        expect(old.water.size).toBe(0);
        matrix.cases++;
        if (firstOpportunity < 0) matrix.skippedWindow++; else matrix.placed++;
        matrix.legacyUses += old.sends.length;
        matrix.legacyRejected += old.sends.filter(send => !send.reachable).length;
        expect(f.bot.listenerCount('physicsTick')).toBe(0);
        expect(f.bot.listenerCount('move')).toBe(0);
        expect(f.bot.listenerCount('blockUpdate')).toBe(0);
      }
    });
  }

  it('aims into r214 short fall landing cell (-9,65,6), not the departing cell (-10,65,6)', async () => {
    vi.useFakeTimers();
    const f = rig(), b = f.bot.entity;
    const frames = [
      [-9.221670258672425, 68.6866159854884, 6.287110262967512, -0.9370638919468484, 0.068545352989073],
      [-9.153124905683352, 67.74955209354155, 6.274112598121848, -0.9967226335068657, 0.087410182687525],
      [-9.065714722995827, 66.75282946003469, 6.257537758119902, -1.055188201373583, 0.104577177713116],
      [-8.96113754528271, 65.69764125866111, 6.237707688725741, -1.112484458998108, 0.120199143186402],
      [-8.840938402096308, 65, 6.214915360584664, 0, 0],
    ];
    b.position = new Vec3(frames[0][0], frames[0][1], frames[0][2]);
    const running = runFallClutch(f.bot, f.bot, f.memory);
    for (const [i, [x, y, z, vy, vx]] of frames.entries()) {
      Object.assign(b, { position: new Vec3(x, y, z), velocity: new Vec3(vx, vy, -0.013), onGround: i === frames.length - 1 });
      f.emit(); await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(3000); await running;
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0]).toMatchObject({ tick: 3, reachable: true, source: { x: -9, y: 65, z: 6 } });
    expect(f.sends[0].pitch).toBeGreaterThan(-Math.PI / 2); // diagonal aim across the cell edge
    expect(f.memory.scoop).toMatchObject({ x: -9, y: 65, z: 6 });
  });

  it('aims at r212 raised bedrock top 68 and waits until tick 14136 is sent', async () => {
    vi.useFakeTimers();
    const f = rig((x, z) => x === 0 && z === 0 ? 68 : 64, 'bedrock'), b = f.bot.entity;
    b.position = new Vec3(0.3445072988199184, 71.43550085849769, 0.9518799097836754);
    b.velocity = new Vec3(0.15232646703780214, -2.8293435153903577, -0.20614693381013469);
    const running = runFallClutch(f.bot, f.bot, f.memory);
    f.emit(); // 14135: current eye distance 5.0555, out of reach despite the prediction
    expect(f.sends).toHaveLength(0);
    b.position = new Vec3(0.49683376585772054, 68.60615734310733, 0.7457329759735407);
    f.emit();
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0]).toMatchObject({ tick: 2, reachable: true, source: { x: 0, y: 68, z: 0 } });
    b.onGround = true; b.position.y = 68;
    await vi.advanceTimersByTimeAsync(3000); await running;
    expect(f.sends).toHaveLength(1);
  });

  it('acts inside a catch-up move event, without waiting for promises or wall time; no duplicate use', async () => {
    vi.useFakeTimers();
    const f = rig(), b = f.bot.entity;
    b.position.y = 80; b.velocity.y = -2.2;
    const running = runFallClutch(f.bot, f.bot, f.memory);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.sends).toHaveLength(0);
    for (const y of [77, 74, 71, 69, 67]) { b.position.y = y; f.emit(); }
    expect(f.sends).toHaveLength(1); // still the same JS turn: an await-per-tick loop would have missed it
    expect(f.sends[0].tick).toBe(5);
    b.onGround = true; b.position.y = 65;
    await vi.advanceTimersByTimeAsync(3000); await running;
    expect(f.bot.listenerCount('physicsTick')).toBe(0);
    expect(f.bot.listenerCount('end')).toBe(0);
  });

  it('removes subscriptions on abort, and never pours through an expired motor port even at the urgent tick', async () => {
    vi.useFakeTimers();
    const f = rig(), b = f.bot.entity;
    b.position.y = 90; b.velocity.y = -2.4;
    const running = executeAction(f.bot as never, 'floor-clutch', 8000,
      (() => runFallClutch(f.bot, createMotorPort(f.bot), f.memory)) as never,
      { priority: 380, safetyLease: true, waitForQuiescence: false, legacyExecutingSkill: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.bot.listenerCount('physicsTick')).toBe(1);
    preemptLowerPriorityActions(f.bot, 500, 'wall-escape');
    await vi.advanceTimersByTimeAsync(0);
    b.position.y = 69; f.emit();
    expect(await running).toMatchObject({ success: false, failureType: 'interrupted' });
    expect(f.sends).toHaveLength(0);
    expect(f.bot.listenerCount('physicsTick')).toBe(0);
    expect(f.bot.listenerCount('end')).toBe(0);
    expect(f.memory.scoop).toBeUndefined();
  });

  it('uses the existing priority 380 lease to pre-empt a flee at 250, including an urgent pour', async () => {
    vi.useFakeTimers();
    const f = rig(), b = f.bot.entity;
    const fleeing = executeAction(f.bot as never, 'floor-flee', 3000,
      (() => new Promise<void>(resolve => actionSignal(f.bot)?.addEventListener('abort', () => resolve(), { once: true }))) as never,
      { priority: 250, safetyLease: true, waitForQuiescence: false, legacyExecutingSkill: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(preemptLowerPriorityActions(f.bot, 380, 'floor-clutch')).toBe(true);
    expect(await fleeing).toMatchObject({ success: false, failureType: 'interrupted' });
    b.position.y = 67; b.velocity.y = -2.4;
    const running = executeAction(f.bot as never, 'floor-clutch', 8000,
      (() => runFallClutch(f.bot, createMotorPort(f.bot), f.memory)) as never,
      { priority: 380, safetyLease: true, waitForQuiescence: false, legacyExecutingSkill: true });
    await vi.advanceTimersByTimeAsync(0);
    f.emit();
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0].reachable).toBe(true);
    b.onGround = true; b.position.y = 65;
    await vi.advanceTimersByTimeAsync(3000); await running;
  });

  it('does not send from an out-of-reach current position even when the prediction is in reach', async () => {
    vi.useFakeTimers();
    const f = rig(), b = f.bot.entity;
    b.position.y = 69; b.velocity.y = -2.4;
    const running = runFallClutch(f.bot, f.bot, f.memory);
    f.emit();
    expect(f.sends).toHaveLength(0); // current eye 5.62m, next eye 3.1896m
    b.onGround = true; b.position.y = 65;
    f.emit();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await running).toMatchObject({ success: false });
    expect(f.water.size).toBe(0);
    expect(f.memory.scoop).toBeUndefined();
  });

  it('removes event handlers, its temporary packet wrapper and the scoop note when the use throws', async () => {
    vi.useFakeTimers();
    const f = rig(), b = f.bot.entity;
    const original = f.bot._client.write;
    f.bot.activateItem = () => { throw new Error('fixture packet failure'); };
    b.position.y = 67; b.velocity.y = -2.4;
    const running = runFallClutch(f.bot, f.bot, f.memory);
    const rejected = expect(running).rejects.toThrow('fixture packet failure');
    f.emit(); await rejected;
    expect(f.bot._client.write).toBe(original);
    expect(f.bot.listenerCount('physicsTick')).toBe(0);
    expect(f.bot.listenerCount('end')).toBe(0);
    expect(f.memory.scoop).toBeUndefined();
  });

  it.each(['end', 'timeout', 'dead', 'changed_hand'])('cleans up and does not pour on %s', async reason => {
    vi.useFakeTimers();
    const f = rig(), b = f.bot.entity;
    b.position.y = 90; b.velocity.y = -2.4;
    const running = runFallClutch(f.bot, f.bot, f.memory);
    if (reason === 'end') f.bot.emit('end');
    if (reason === 'timeout') await vi.advanceTimersByTimeAsync(8100);
    if (reason === 'dead') { f.bot.health = 0; f.emit(); }
    if (reason === 'changed_hand') { f.bot.heldItem = { name: 'diamond_sword', slot: 36 }; b.position.y = 67; f.emit(); }
    expect(await running).toMatchObject({ success: false });
    b.position.y = 69; f.emit();
    expect(f.sends).toHaveLength(0);
    expect(f.bot.listenerCount('physicsTick')).toBe(0);
    expect(f.bot.listenerCount('end')).toBe(0);
  });

  it.each(['lava', 'unknown', 'partial_cube'])('keeps the existing refusal for %s ground', async ground => {
    vi.useFakeTimers();
    const f = rig(), b = f.bot.entity;
    const original = f.bot.blockAt;
    f.bot.blockAt = (p: Vec3) => {
      if (p.y < 65) {
        if (ground === 'unknown') return null as never;
        if (ground === 'lava') return { ...original(p), name: 'lava', boundingBox: 'empty', shapes: [] };
        return { ...original(p), shapes: [[0, 0, 0, 1, 0.5, 1]] };
      }
      return original(p);
    };
    b.position.y = 69; b.velocity.y = -2.4;
    const running = runFallClutch(f.bot, f.bot, f.memory);
    f.emit(); b.onGround = true; f.emit();
    expect(await running).toMatchObject({ success: false });
    expect(f.sends).toHaveLength(0);
  });
});
