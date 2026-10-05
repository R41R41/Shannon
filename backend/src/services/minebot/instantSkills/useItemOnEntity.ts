import pathfinder from 'mineflayer-pathfinder';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { gotoSafe } from '../utils/gotoSafe.js';
import { actionDelay } from '../execution/observedWait.js';

const { goals } = pathfinder;
const log = createLogger('Minebot:Skill:useItemOnEntity');

/** How long what the entity gives back is waited for after it has taken the item (a piglin looks its ingot over for six seconds). */
const RETURN_WAIT_MS = 9_000;
const REACH = 3;
const GIVE_TRIES = 6;

/**
 * Using what is in the hand on a living thing: the right click a person gives a piglin with a gold ingot, a
 * cow with wheat or a bucket, a sheep with shears. One skill for all of them, because they are one act: hold
 * the item, go up to the one meant, use it on it, and see what happened to the item and what came back. What
 * each such act is for is the planner's to know (and to learn); nothing here knows a piglin from a cow.
 *
 * It was missing: the body could use an item on a block and on nothing, and had one skill each for breeding
 * and for villagers. Trading gold with piglins is how fire resistance and ender pearls are come by before any
 * of them can be made, and there was no way to do it at all.
 */
class UseItemOnEntity extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'use-item-on-entity';
    this.description = '手に持ったアイテムを、近くの生き物に対して使います（右クリック）。例: ピグリンに gold_ingot を渡して物々交換、牛に bucket で牛乳、羊に shears。'
      + '相手に近づき、アイテムを使い、アイテムが減ったかと、返ってきた物（拾えた物）を報告します。countで回数を指定できます';
    this.params = [
      { name: 'itemName', type: 'string', description: '使うアイテム名（例: gold_ingot, wheat, bucket, shears）', required: true },
      { name: 'entityName', type: 'string', description: '相手の種類（例: piglin, cow, sheep）。最も近い1体が相手になる', required: true },
      { name: 'count', type: 'number', description: '使う回数（デフォルト: 1、最大16）。相手が受け取るまで待ってから次を渡す', default: 1 },
    ];
    this.maxDurationMs = 200_000;
  }

  /** The waits, as fields so that a test need not sit through them. */
  private returnWaitMs = RETURN_WAIT_MS;
  private takeWaitMs = 1200;
  private retryWaitMs = 1500;

  private held(name: string): number {
    return this.bot.inventory.items().filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
  }

  private pack(): Map<string, number> {
    const pack = new Map<string, number>();
    for (const item of this.bot.inventory.items()) pack.set(item.name, (pack.get(item.name) ?? 0) + item.count);
    return pack;
  }

  private gained(before: Map<string, number>, given: string): string[] {
    const gained: string[] = [];
    for (const [name, count] of this.pack()) {
      const more = count - (before.get(name) ?? 0);
      if (more > 0 && name !== given) gained.push(`${name}×${more}`);
    }
    return gained;
  }

  private nearest(entityName: string): any | null {
    const wanted = entityName.toLowerCase().trim();
    let best: any = null, bestDistance = 24;
    for (const entity of Object.values(this.bot.entities) as any[]) {
      if (!entity?.position || entity === this.bot.entity || entity.isValid === false) continue;
      if (String(entity.name ?? '').toLowerCase() !== wanted) continue;
      const distance = entity.position.distanceTo(this.bot.entity.position);
      if (distance < bestDistance) { best = entity; bestDistance = distance; }
    }
    return best;
  }

  /** Picks up what lies within a few blocks (what the entity threw back), without going far for it. */
  private async collect(): Promise<void> {
    const deadline = Date.now() + 5000;
    const given = new Set<number>();
    while (Date.now() < deadline && !this.shouldInterrupt()) {
      const item = this.bot.nearestEntity((entity: any) => entity.name === 'item' && !given.has(entity.id)
        && entity.position.distanceTo(this.bot.entity.position) < 6);
      if (!item) return;
      given.add(item.id);
      if (item.position.distanceTo(this.bot.entity.position) > 1) {
        try { await gotoSafe(this.bot, new goals.GoalNear(item.position.x, item.position.y, item.position.z, 0), { timeoutMs: 3000, stuckAbortCount: 2, logStuck: false }); } catch { /* seen in the pack or not */ }
      }
      await actionDelay(this.bot, 350);
    }
  }

  async runImpl(itemName: string, entityName: string, count: number = 1) {
    const times = Math.max(1, Math.min(16, Math.floor(Number(count) || 1)));
    if (!itemName || !entityName) return { success: false, result: 'itemName と entityName を指定してください', failureType: 'invalid_arguments', recoverable: true };
    const had = this.held(itemName);
    if (had === 0) return { success: false, result: `${itemName}を持っていません`, failureType: 'missing_item', recoverable: true };
    let target = this.nearest(entityName);
    if (!target) return { success: false, result: `24ブロック以内に${entityName}が見つかりません`, failureType: 'target_not_found', recoverable: true };
    const before = this.pack();
    let used = 0, refused = 0;
    for (let round = 0; round < times && this.held(itemName) > 0; round++) {
      if (this.shouldInterrupt()) break;
      target = (target?.isValid !== false && this.bot.entities[target.id]) ? target : this.nearest(entityName);
      if (!target) break;
      if (target.position.distanceTo(this.bot.entity.position) > REACH) {
        try { await gotoSafe(this.bot, new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2), { timeoutMs: 8000, stuckAbortCount: 3, logStuck: false }); } catch { /* judged by the distance below */ }
        if (target.position.distanceTo(this.bot.entity.position) > REACH + 1.5) {
          return { success: used > 0, result: `${entityName}に近づけませんでした（${target.position.distanceTo(this.bot.entity.position).toFixed(1)}m）。${this.report(itemName, entityName, used, refused, before)}`,
            failureType: used > 0 ? undefined : 'movement_failed', recoverable: true };
        }
      }
      // Given until it is taken: an entity busy with the last one (a piglin still looking its ingot over) takes nothing yet.
      const mine = this.held(itemName);
      let taken = false;
      for (let attempt = 0; attempt < GIVE_TRIES && !taken && !this.shouldInterrupt(); attempt++) {
        const item = this.bot.inventory.items().find(entry => entry.name === itemName);
        if (!item) break;
        try {
          await this.bot.equip(item, 'hand');
          await this.bot.lookAt(target.position.offset(0, (target.height ?? 1.6) * 0.8, 0), true);
          await (this.bot as any).activateEntity(target);
        } catch { /* seen in the pack or not */ }
        const deadline = Date.now() + this.takeWaitMs;
        while (Date.now() < deadline && this.held(itemName) >= mine) await actionDelay(this.bot, 100);
        taken = this.held(itemName) < mine;
        if (!taken) await actionDelay(this.bot, this.retryWaitMs);
      }
      if (!taken) { refused++; break; }
      used++;
      // What comes back is waited for, and picked up from where it fell.
      const waitUntil = Date.now() + this.returnWaitMs;
      const packThen = JSON.stringify([...this.pack()]);
      let seen = false;
      while (Date.now() < waitUntil && !this.shouldInterrupt()) {
        await actionDelay(this.bot, 300);
        const lying = this.bot.nearestEntity((entity: any) => entity.name === 'item' && entity.position.distanceTo(this.bot.entity.position) < 6);
        if (lying) { seen = true; await this.collect(); }
        if (JSON.stringify([...this.pack()]) !== packThen && !this.bot.nearestEntity((entity: any) => entity.name === 'item' && entity.position.distanceTo(this.bot.entity.position) < 6)) break;
        if (seen && !lying) break;
      }
    }
    const text = this.report(itemName, entityName, used, refused, before);
    log.info(`🤝 ${text}`);
    if (used === 0) return { success: false, result: text, failureType: 'not_accepted', recoverable: true };
    return { success: true, result: text };
  }

  private report(itemName: string, entityName: string, used: number, refused: number, before: Map<string, number>): string {
    const gained = this.gained(before, itemName);
    return `${entityName}に${itemName}を${used}回使った`
      + (refused ? '（その後は受け取らなかった: 相手がこのアイテムを受け取らない状態か、受け取る相手ではない）' : '')
      + `。受け取った物: ${gained.length ? gained.join('、') : 'なし'}。${itemName}の残り: ${this.held(itemName)}個`;
  }
}

export default UseItemOnEntity;
