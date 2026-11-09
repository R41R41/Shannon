import { Vec3 } from 'vec3';
import { nativeActionHost } from '../execution/ActionExecution.js';
import { bedBurstWorld } from './bedBurstRuntime.js';
import { dragonLandingTarget } from './dragonLandingPath.js';
import { landingFountainStandSearch } from './dragonBedGeometry.js';
import { fountainOf, isEnd } from './dragonState.js';
import type { P3 } from './dragonParts.js';

/** Bounded read of today's loaded cells and current phase2 packets. No movement, placement, future trace or chosen combat policy. */
export async function probeBedsite(given: any, target: unknown) {
  const bot: any = nativeActionHost(given), base = { v: 1 as const, kind: 'bedsite' };
  const refused = (code: string) => ({ ...base, text: `bedsite ${code}`, ready: false, code });
  if (typeof target !== 'string' || !/^#(?:0|[1-9][0-9]*)$/u.test(target) || !Number.isSafeInteger(Number(target.slice(1)))) return refused('exact_dragon_id_required');
  if (!isEnd(bot) || !bot._client || !bot.entity?.position) return refused('not_in_end');
  const id = Number(target.slice(1)), world = bedBurstWorld(bot), receipt = world.dragon(id);
  if (!receipt || receipt.phase !== 2) return refused('current_phase2_required');
  const epoch = world.epoch(), approach = receipt.approach, entity = receipt.entity, stand = { ...bot.entity.position };
  if (receipt.history.length < 2 || receipt.history.at(-1)!.tick - receipt.history[0].tick < 11) return refused('packet_history_pending');
  const read = (p: P3) => bot.blockAt(new Vec3(p.x, p.y, p.z));
  const centre = fountainOf(bot), minY = bot.game?.minY ?? 0, maxY = minY + (bot.game?.height ?? 256) - 1;
  const landingTarget = centre && dragonLandingTarget(centre, minY, maxY, read);
  if (!landingTarget) return refused('landing_target_unread');
  const countObsidian = () => (bot.inventory?.items?.() ?? []).filter((item: any) => item.name === 'obsidian')
    .reduce((sum: number, item: any) => sum + (Number.isInteger(item.count) && item.count > 0 ? item.count : 0), 0);
  const obsidian = countObsidian();
  const search = landingFountainStandSearch(landingTarget, stand, read, Math.min(12, obsidian), Number(bot.health), [...receipt.history]);
  const until = Date.now() + 1500;
  try {
    while (Date.now() < until) {
      const current = world.dragon(id);
      if (world.stopped() || world.epoch() !== epoch || !current || current.entity !== entity || current.approach !== approach || current.phase !== 2) return refused('approach_changed');
      const r = world.compute(search, 2);
      if (r.done) {
        const site = r.value;
        if (!site) return refused('no_layout_within_twelve');
        const options = site.options.slice(0, 4);
        const cells = [...new Map([...site.footing, ...site.screen].map(p => [`${p.x},${p.y},${p.z}`, p])).values()];
        const durable = (p: P3) => ['obsidian', 'bedrock'].includes(read(p)?.name ?? '');
        const shared = new Set(cells.map(p => `${p.x},${p.y},${p.z}`));
        const details = options.map(layout => {
          const tops = [layout.foot, layout.head].map(p => ({ ...p, y: p.y - 1 }));
          const supports = [...new Map([...layout.supports, ...tops].map(p => [`${p.x},${p.y},${p.z}`, p])).values()];
          const extra = supports.filter(p => !durable(p) && !shared.has(`${p.x},${p.y},${p.z}`));
          return { layout: { ...layout, supports }, extra, count: cells.filter(p => !durable(p)).length + extra.length };
        });
        const newObsidian = Math.max(...details.map(d => d.count));
        const available = countObsidian();
        if (newObsidian > Math.min(12, available)) return refused('materials_changed');
        for (const { layout } of details) {
          // Reused columns cost no new inventory, but remain physical collision cells. Do not lose them from the blueprint.
          const physical = new Map(layout.screen.map(p => [`${p.x},${p.y},${p.z}`, p]));
          for (const half of [layout.foot, layout.head]) for (let y = Math.floor(layout.stand.y) - 1; y < half.y; y++) {
            const p = { x: half.x, y, z: half.z };
            if (['obsidian', 'bedrock'].includes(read(p)?.name ?? '')) physical.set(`${p.x},${p.y},${p.z}`, p);
          }
          world.rememberSite(id, { ...layout, screen: [...physical.values()] }, landingTarget);
        }
        return { ...base, text: `bedsite 新設黒曜石${newObsidian}/${Math.min(12, available)}、配置${options.length}。施工・移動・起爆は頭が別々に頼む`, ready: true,
          target: `#${id}`, approach, observedTick: world.tick(), landingTarget, stand: site.stand, staging: site.staging,
          footing: site.footing, screen: site.screen, newObsidian, availableObsidian: available,
          options: details.map(({ layout: { foot, head, region }, extra, count }) => ({ foot, head, supports: extra, newObsidian: count, ...(region ? { region } : {}) })),
          assumptions: 'current_loaded_cells_and_phase2_packets; not_ready_to_fire; burst_rechecks_everything' };
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return refused('computation_budget');
  } finally { search.return(null); }
}
