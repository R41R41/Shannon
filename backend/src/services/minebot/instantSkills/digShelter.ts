import { isSealedIn } from '../utils/shelter.js';
import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { PROTECTED_UTILITY_BLOCKS } from '../constants.js';
import { actionDelay } from '../execution/observedWait.js';
import { holdsWater } from '../utils/waterBlocks.js';
import { soonestContact } from '../utils/threatTracker.js';
import { digMsWithBestTool } from '../utils/bestToolDigTime.js';
import { centreInColumn } from '../utils/breathingReflex.js';

const log = createLogger('Minebot:Skill:digShelter');

const SEAL_BLOCKS = [
  'cobblestone', 'dirt', 'stone', 'cobbled_deepslate', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff',
  'netherrack', 'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks',
  'mangrove_planks', 'cherry_planks', 'sandstone', 'coarse_dirt', 'rooted_dirt',
];
const DEPTH = 3;
const SIDES = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];

const isSolid = (block: any) => !!block && block.boundingBox === 'block';
const isLiquid = (block: any) => !!block && (block.name === 'lava' || holdsWater(block));
const SITE_RADIUS = 4;
const SITE_ATTEMPTS = 3;

/**
 * Early-game night refuge: dig three blocks straight down, then seal the
 * roof at ground level and any open wall, leaving the bot in a closed 1x1
 * shaft. Surface escape at night had the bot run into lakes and drown or be
 * cornered; a sealed shaft keeps zombies, skeletons and spiders out.
 */
class DigShelter extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'dig-shelter';
    this.description = '夜や敵が多い時の一時避難。足元を3段掘り下げて縦穴に入り、頭上（地面の高さ）と周囲の開口をブロックで塞ぐ。'
      + '足元が掘れない・横に液体がある時は、数ブロック以内の掘れる地点へ自分で移動してから掘る。'
      + '塞いだ後は朝までwait-timeで待つか、地下を横へ掘って作業を続けられる。出る時は頭上のブロックを掘る。'
      + '掘って塞ぐまで数秒かかるので、敵がそれより早く届く見込みの時は始めずに所要時間と到達見込みを返す。';
    this.params = [];
  }

  /** Seconds to dig the shaft with what is held and close it: the body's own measure, not a constant. */
  private secondsNeeded(column: Vec3[]): number {
    let digMs = 0;
    for (const pos of column) {
      const block = this.bot.blockAt(pos);
      if (!isSolid(block)) continue;
      // With the tool the dig will put in the hand, not what is held now (see digMsWithBestTool).
      const ms = digMsWithBestTool(this.bot as any, block);
      digMs += ms > 0 ? ms : 1000;
    }
    return digMs / 1000 + DEPTH * 0.3 + 1;
  }

  /** Why the last cell could not be closed: nothing to close it with, or the placement itself did not take. */
  private sealFailure = '';

  /** The two cells the body fills (its feet and its head): nothing is placed there. */
  private inBody(pos: Vec3): boolean {
    const at = this.bot.entity?.position;
    return !!at && pos.x === Math.floor(at.x) && pos.z === Math.floor(at.z) && (pos.y === Math.floor(at.y) || pos.y === Math.floor(at.y) + 1);
  }

  private async placeAt(pos: Vec3, viaSupport = true): Promise<boolean> {
    if (isSolid(this.bot.blockAt(pos))) return true;
    this.sealFailure = '';
    const around = [new Vec3(0, -1, 0), ...SIDES, new Vec3(0, 1, 0)];
    // A cell with nothing solid beside it cannot take a block: there is no face to put it against. In ground
    // that is full of hollows (the Nether, a fortress bridge) the open side of a shaft is such a cell, and the
    // body stood in a shaft it could not close (lab continuation L77r). A person puts one block against the
    // nearest solid first and the block that was wanted against that: the same here, one step out, the cell
    // under the one wanted first.
    if (viaSupport && !around.some(side => isSolid(this.bot.blockAt(pos.plus(side))))) {
      for (const side of around) {
        const support = pos.plus(side);
        const block = this.bot.blockAt(support);
        if (!block || isSolid(block) || isLiquid(block) || this.inBody(support)) continue;
        if (!around.some(next => isSolid(this.bot.blockAt(support.plus(next))))) continue;
        if (await this.placeAt(support, false)) break;
        if (this.shouldInterrupt()) return false;
      }
    }
    // Twice round the faces it could be placed against: a placement can fail for a moment (a mob or a dropped
    // block of sand in the cell, the look not yet arrived) and take the next time.
    for (let pass = 0; pass < 2; pass++) {
      const item = this.bot.inventory.items().find(i => SEAL_BLOCKS.includes(i.name));
      if (!item) { this.sealFailure = '塞ぐブロック（丸石・土など）を持っていません'; return false; }
      let faces = 0;
      for (const side of [...SIDES, new Vec3(0, 1, 0), new Vec3(0, -1, 0)]) {
        const reference = this.bot.blockAt(pos.plus(side));
        if (!isSolid(reference)) continue;
        faces++;
        try {
          await this.bot.equip(item, 'hand');
          await this.bot.lookAt(reference!.position.offset(0.5, 0.5, 0.5).minus(side.scaled(0.5)), true);
          await this.bot.placeBlock(reference!, side.scaled(-1));
        } catch { /* verified below */ }
        const deadline = Date.now() + 1500;
        while (Date.now() < deadline && !isSolid(this.bot.blockAt(pos))) await actionDelay(this.bot, 100);
        if (isSolid(this.bot.blockAt(pos))) return true;
        if (this.shouldInterrupt()) { this.sealFailure = '中断されました'; return false; }
      }
      // What it was told used to be "carry cobblestone or dirt" whatever the cause: a body with a stack of
      // cobblestone went looking for somewhere else to wall itself in (paid run L70).
      this.sealFailure = faces === 0 ? '隣に支えになるブロックがありません'
        : `${item.name}を${item.count}個持っていますが、設置が成立しませんでした（置き先に何かが重なっているか、サーバーが拒否）`;
      await actionDelay(this.bot, 300);
    }
    return false;
  }

  private async centre(): Promise<void> {
    if (typeof (this.bot as any).setControlState !== 'function') return;
    const deadline = Date.now() + 1500;
    try {
      while (Date.now() < deadline && !this.shouldInterrupt() && !centreInColumn(this.bot as any)) await actionDelay(this.bot, 50);
    } finally { this.bot.setControlState('forward', false); }
  }

  private shaft(top: Vec3): Vec3[] { return Array.from({ length: DEPTH }, (_, index) => top.offset(0, -1 - index, 0)); }

  /** Why a shaft dug from a bot standing at `top` would be unsafe, or null when it is fine. */
  private siteProblem(top: Vec3): string | null {
    for (const pos of this.shaft(top)) {
      const block = this.bot.blockAt(pos);
      if (!block || isLiquid(block) || PROTECTED_UTILITY_BLOCKS.has(block.name) || (isSolid(block) && !block.diggable))
        return `足元(${pos.x}, ${pos.y}, ${pos.z})の${block?.name ?? '未ロード'}は掘れないか危険です`;
      for (const side of SIDES) {
        if (isLiquid(this.bot.blockAt(pos.plus(side)))) return `穴の横(${pos.x + side.x}, ${pos.y}, ${pos.z + side.z})に液体があります`;
      }
    }
    const floor = this.bot.blockAt(top.offset(0, -1 - DEPTH, 0));
    if (!isSolid(floor) || isLiquid(floor)) return `穴の底(${top.x}, ${top.y - 1 - DEPTH}, ${top.z})が${floor?.name ?? '未ロード'}で空洞か危険です`;
    return null;
  }

  /** Dry cells to stand on near the bot whose shaft would be safe, nearest first. */
  private nearbySites(origin: Vec3): Vec3[] {
    const dry = (block: any) => !!block && !isSolid(block) && !isLiquid(block);
    const sites: Vec3[] = [];
    for (let dx = -SITE_RADIUS; dx <= SITE_RADIUS; dx++) for (let dz = -SITE_RADIUS; dz <= SITE_RADIUS; dz++) for (const dy of [0, 1, -1, 2, -2]) {
      if (!dx && !dz && !dy) continue;
      const top = origin.offset(dx, dy, dz);
      if (!isSolid(this.bot.blockAt(top.offset(0, -1, 0))) || !dry(this.bot.blockAt(top)) || !dry(this.bot.blockAt(top.offset(0, 1, 0)))) continue;
      if (!this.siteProblem(top)) sites.push(top);
    }
    return sites.sort((a, b) => a.distanceTo(origin) - b.distanceTo(origin));
  }

  async runImpl() {
    if (!this.bot.entity) return { success: false, result: 'Botの位置が不明です', failureType: 'not_ready', recoverable: true };
    if ((this.bot.entity as any).isInWater) {
      return { success: false, result: '水中では避難穴を作れません。乾いた地面へ移動してから実行してください', failureType: 'invalid_location', recoverable: true };
    }
    // Already closed in: there is nothing to dig. Asked again from inside its shelter (the task it went back to
    // had been summarised, and the summary did not say where the body was), the skill judged the floor of the
    // shaft as a site, found it wanting, and walked the body out through the wall to dig another, into the
    // skeleton and the zombie it had shut out forty seconds before (paid run L70 died there).
    if (isSealedIn(this.bot as any)) {
      const here = this.bot.entity.position.floored();
      return { success: true, result: `既に塞いだ縦穴(${here.x}, ${here.y}, ${here.z})の中にいます（頭上と周囲は塞がっています）。敵は入れません。`
        + 'このまま待つ（wait-time）か、横へ掘って地下を進めます。壁や天井を開けると敵に届くようになります' };
    }
    let top = this.bot.entity.position.floored();
    let problem = this.siteProblem(top);
    let moved = '';
    if (problem) {
      // The skill's job is a sealed shaft, not a verdict on one cell: a paid
      // run retried six times on a spot with water beside it while mobs closed in.
      const moveTo = this.bot.instantSkills.getSkill('move-to');
      for (const site of this.nearbySites(top).slice(0, SITE_ATTEMPTS)) {
        if (this.shouldInterrupt()) return { success: false, result: '中断されました', failureType: 'interrupted', recoverable: true };
        try { await moveTo?.run(site.x + 0.5, site.y, site.z + 0.5, 0, 'near'); } catch { /* verified by position below */ }
        const here = this.bot.entity.position.floored();
        if ((this.bot.entity as any).isInWater || this.siteProblem(here)) continue;
        moved = `足元は使えなかったため(${here.x}, ${here.y}, ${here.z})へ移動し、`;
        top = here; problem = null;
        break;
      }
      if (problem) return { success: false, result: `${problem}。${SITE_RADIUS}ブロック以内に掘れる地点が無いか、移動できませんでした`, failureType: 'invalid_location', recoverable: true };
    }
    const column = this.shaft(top);
    // A shaft the attacker reaches before the roof is on is a trap, not a
    // shelter: a zombie 12.7m away walked into the open pit and killed the bot
    // at the bottom (paid run L18).
    const needed = this.secondsNeeded(column);
    const arriving = soonestContact(this.bot);
    if (arriving && arriving.seconds < needed) {
      return { success: false, failureType: 'threat_too_close', recoverable: true,
        result: `間に合いません: ${arriving.name}（${arriving.distance.toFixed(0)}m）が約${arriving.seconds.toFixed(0)}秒で届く見込みで、縦穴を掘って塞ぐには約${needed.toFixed(0)}秒かかります。`
          + '掘り始めると塞ぐ前に穴の中で追いつかれます。' };
    }
    const dig = this.bot.instantSkills.getSkill('dig-block-at');
    if (!dig) return { success: false, result: 'dig-block-atが見つかりません', failureType: 'not_ready', recoverable: false };

    for (const pos of column) {
      if (this.shouldInterrupt()) return { success: false, result: '中断されました', failureType: 'interrupted', recoverable: true };
      // Over the middle of the cell: a body standing across the edge of two blocks does not fall into the
      // hole dug under one of them, and the next block down is then out of its reach (paid run L78).
      await this.centre();
      if (isSolid(this.bot.blockAt(pos))) {
        const dug: any = await dig.run(pos.x, pos.y, pos.z);
        if (!dug?.success && isSolid(this.bot.blockAt(pos))) {
          return { success: false, result: `(${pos.x}, ${pos.y}, ${pos.z})を掘れませんでした: ${dug?.result ?? ''}`, failureType: 'dig_failed', recoverable: true };
        }
      }
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && this.bot.entity.position.y > pos.y + 0.2) await actionDelay(this.bot, 100);
    }
    const bottom = column[DEPTH - 1];
    if (Math.floor(this.bot.entity.position.y) !== bottom.y
      || Math.floor(this.bot.entity.position.x) !== top.x || Math.floor(this.bot.entity.position.z) !== top.z) {
      return { success: false, result: `縦穴の底(${bottom.x}, ${bottom.y}, ${bottom.z})に入れませんでした（現在 ${this.bot.entity.position.floored()}）`, failureType: 'position_verification_failed', recoverable: true };
    }

    // Walls around the body, then the roof at ground level.
    const openings: Vec3[] = [];
    for (const level of [bottom, bottom.offset(0, 1, 0)]) {
      for (const side of SIDES) if (!isSolid(this.bot.blockAt(level.plus(side)))) openings.push(level.plus(side));
    }
    const roof = column[0];
    for (const pos of [...openings, roof]) {
      if (!await this.placeAt(pos)) {
        const noItem = this.sealFailure.includes('持っていません');
        return { success: false, result: `(${pos.x}, ${pos.y}, ${pos.z})を塞げませんでした: ${this.sealFailure}。縦穴(${bottom.x}, ${bottom.y}, ${bottom.z})には入っています`,
          failureType: noItem ? 'missing_item' : 'placement_failed', recoverable: true };
      }
    }
    log.info(`🕳 避難完了: (${bottom.x}, ${bottom.y}, ${bottom.z})、頭上(${roof.x}, ${roof.y}, ${roof.z})を封鎖`);
    return {
      success: true,
      result: `${moved}地下(${bottom.x}, ${bottom.y}, ${bottom.z})の縦穴に入り、頭上(${roof.x}, ${roof.y}, ${roof.z})と周囲を塞ぎました。`
        + '塞いでいる間、敵は縦穴に入れません。朝まで待つ（wait-time）か、横へ掘って地下で作業を続けられます。出る時は頭上のブロックを掘ってください',
    };
  }
}

export default DigShelter;
