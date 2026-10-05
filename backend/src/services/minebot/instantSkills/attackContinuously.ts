import pathfinder from 'mineflayer-pathfinder';
import { createLogger } from '../../../utils/logger.js';
import { CustomBot, InstantSkill } from '../types.js';
import { shouldRefuseAggressiveCombat } from '../utils/minebotToolPolicy.js';
import { gotoSafe } from '../utils/gotoSafe.js';
import { actionDelay } from '../execution/observedWait.js';
import { visiblePointOn } from '../utils/sightLine.js';

const { goals } = pathfinder;
const log = createLogger('Minebot:Skill:attackContinuously');

/**
 * 原子的スキル: エンティティを追跡しながら連続攻撃
 *
 * 武器を自動装備し、対象が逃げても追いかけて攻撃し続ける。
 * 1体倒した後は自動的に次のターゲットを探して攻撃を続行する。
 * 倒した後に周囲の同種モブを再スキャンし、結果に含める。
 */
const DROP_COLLECT_BUDGET_MS = 8_000;
const DROP_COLLECT_RADIUS = 10;
/** From the eyes to the nearest point of a target's body within which a blow lands. */
const HOLD_REACH = 3;

class AttackContinuously extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'attack-continuously';
    this.description = '対象を追跡しながら連続攻撃。武器自動装備。1体倒すと自動で次を攻撃。maxKillsで倒す数を制限可能。';
    this.params = [
      {
        name: 'entityName',
        type: 'string',
        description: '攻撃対象。単体名(cow)、カンマ区切り(cow,pig,chicken,sheep)、または特殊キーワード: "food_animals"(食料モブ一括), "hostile"(敵対Mob)。省略時は敵対的Mobのみ。'
          + 'ここで指定した相手は、このスキルの実行中は「近くに居る・当ててきた」だけでは緊急対応に中断されない（体力が半分以下になるか、指定していない別の種類が近づくと中断される）',
        default: '',
      },
      {
        name: 'maxAttacks',
        type: 'number',
        description: '最大攻撃回数（デフォルト: 30）',
        default: 30,
      },
      {
        name: 'maxDistance',
        type: 'number',
        description: '探索範囲（デフォルト: 24ブロック）。この範囲内の対象を追跡して攻撃する',
        default: 24,
      },
      {
        name: 'maxKills',
        type: 'number',
        description: '最大キル数（0=制限なし。指定するとその数だけ倒して停止）',
        default: 0,
      },
      {
        name: 'holdPosition',
        type: 'boolean',
        description: 'trueにすると、その場から動かず、手の届く所に来た対象だけを攻撃する（囲いの中や、壁の穴ごしに戦う時用。追いかけず、落とし物も取りに出ない）。デフォルト: false',
        default: false,
      },
    ];
  }

  async runImpl(entityName: string = '', maxAttacks: number = 30, maxDistance: number = 24, maxKills: number = 0, holdPosition: boolean = false) {
    this.holding = holdPosition === true;
    try {
      const refuse = shouldRefuseAggressiveCombat(this.bot, entityName, this.holding);
      if (refuse) {
        return { success: false, result: refuse };
      }
      if (maxAttacks < 1 || maxAttacks > 200) {
        return { success: false, result: '攻撃回数は1～200の範囲で指定してください' };
      }

      const hostileMobs = [
        'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'creeper', 'spider',
        'enderman', 'witch', 'slime', 'magma_cube', 'phantom', 'blaze', 'ghast',
        'zombified_piglin', 'piglin', 'piglin_brute', 'hoglin', 'zoglin',
        'wither_skeleton', 'wither', 'cave_spider', 'silverfish', 'endermite',
        'guardian', 'elder_guardian', 'shulker', 'vindicator', 'evoker', 'vex',
        'pillager', 'ravager', 'warden',
      ];

      const foodAnimals = ['cow', 'pig', 'chicken', 'sheep', 'rabbit', 'mooshroom'];

      const rawInput = entityName.toLowerCase().trim();

      // 特殊キーワードまたはカンマ区切りの複数指定を解決
      const targetNames: string[] = rawInput === 'food_animals' || rawInput === 'food' || rawInput === 'livestock'
        ? foodAnimals
        : rawInput === 'hostile'
          ? hostileMobs
          : rawInput
            ? rawInput.split(',').map(s => s.trim()).filter(Boolean)
            : [];

      const matchesTarget = (name: string): boolean => {
        if (targetNames.length > 0) {
          return targetNames.some(t => name.includes(t));
        }
        return hostileMobs.some(mob => name.includes(mob));
      };

      const targetDesc = targetNames.length > 0
        ? (targetNames.length <= 3 ? targetNames.join('/') : `${targetNames.slice(0, 3).join('/')}等`)
        : '敵対的Mob';

      // ── 武器を装備 ──
      const weaponEquipped = await this.equipBestWeapon();

      // ── 対象を検索 (広い範囲) ──
      const findTarget = () => this.bot.nearestEntity((entity) => {
        if (!entity || !entity.position) return false;
        const d = entity.position.distanceTo(this.bot.entity.position);
        if (d > maxDistance) return false;
        const name = entity.name?.toLowerCase() || '';
        return matchesTarget(name);
      });

      let target = findTarget();
      if (!target) {
        return {
          success: false,
          result: `${maxDistance}ブロック以内に${targetDesc}が見つかりません`,
          failureType: 'target_not_found',
          recoverable: true,
        };
      }

      let attackCount = 0;
      let kills = 0;
      let lastTargetName = target.name || 'unknown';
      const killedNames: string[] = [];
      const allCollected: string[] = [];
      const startTime = Date.now();
      const TIMEOUT = 60000;

      // Until that many blows have been struck, not that many times round: a round that only closes the
      // distance, waits for the target to come down into reach, or counts a kill is no blow. Counting rounds,
      // a call for forty blows went back to the planner after ten, with two blazes a block away (lab; the
      // time limit below is what bounds a fight that cannot be had).
      while (attackCount < maxAttacks) {
        if (this.shouldInterrupt()) {
          this.stopMovement();
          const killInfo = kills > 0 ? `（${kills}体撃破: ${killedNames.join(', ')}）` : '';
          return {
            success: attackCount > 0,
            result: attackCount > 0
              ? `中断。${attackCount}回攻撃${killInfo}（${weaponEquipped}使用）`
              : '中断されました',
          };
        }

        if (Date.now() - startTime > TIMEOUT) {
          this.stopMovement();
          break;
        }

        // 対象が死んだか消えた → キルカウント + ドロップ回収 + 再検索
        if (!target.isValid) {
          kills++;
          killedNames.push(lastTargetName);
          log.info(`🎯 ${lastTargetName}を撃破 (${kills}体目, ${attackCount}回攻撃)`, 'green');

          const drops = await this.collectNearbyDrops();
          if (drops.length > 0) {
            allCollected.push(...drops);
            log.info(`📦 ドロップ回収: ${drops.join(', ')}`, 'green');
          } else {
            log.warn(`📦 ドロップ未回収（${lastTargetName}のキル後）`);
          }

          if (maxKills > 0 && kills >= maxKills) break;

          target = findTarget();
          if (!target) break;
          lastTargetName = target.name || 'unknown';
          log.info(`🔄 次のターゲット: ${lastTargetName} (${Math.round(target.position.distanceTo(this.bot.entity.position))}m)`, 'cyan');
          continue;
        }

        const distance = target.position.distanceTo(this.bot.entity.position);

        if (distance > maxDistance) {
          target = findTarget();
          if (!target) break;
          lastTargetName = target.name || 'unknown';
          continue;
        }

        // Holding its ground (inside a cover, at a hole in a wall): it does not go after anything. A blow is
        // struck only at what has come within a blow of the eyes, and the nearest of those is the one struck.
        if (this.holding) {
          const inReach = this.nearestInReach(matchesTarget);
          if (inReach) {
            target = inReach.entity as NonNullable<typeof target>;
            lastTargetName = target.name || 'unknown';
            await this.bot.lookAt(inReach.point);
            await this.bot.attack(target);
            attackCount++;
            await actionDelay(this.bot, weaponEquipped.includes('axe') ? 900 : weaponEquipped.includes('sword') ? 550 : 200);
          } else {
            await actionDelay(this.bot, 100);
            const other = findTarget();
            if (other) { target = other; lastTargetName = target.name || 'unknown'; }
            else if (!target.isValid) break;
          }
          continue;
        }

        // ── 追跡: パスファインダーで安全に近づく ──
        if (distance > 3.5) {
          const tp = target.position;
          try {
            await gotoSafe(this.bot, new goals.GoalNear(tp.x, tp.y, tp.z, 3), {
              timeoutMs: Math.min(6000, Math.max(2500, distance * 250)),
              stuckAbortCount: 3,
              logStuck: false,
            });
          } catch { /* ignore */ }
          this.stopMovement();
          if (!target.isValid) continue;
        }

        // ── 攻撃 ──
        const attackDist = target.position.distanceTo(this.bot.entity.position);
        if (attackDist <= 4.5 && target.isValid) {
          await this.bot.lookAt(target.position.offset(0, target.height * 0.8, 0));
          await this.bot.attack(target);
          attackCount++;

          const cooldown = weaponEquipped.includes('axe') ? 900 : weaponEquipped.includes('sword') ? 550 : 200;
          await actionDelay(this.bot, cooldown);
        } else {
          await actionDelay(this.bot, 100);
        }

        // 最後のターゲットが死んだ場合もキルカウント
        if (!target.isValid) {
          kills++;
          killedNames.push(lastTargetName);
          log.info(`🎯 ${lastTargetName}を撃破 (${kills}体目, ${attackCount}回攻撃)`, 'green');

          const drops2 = await this.collectNearbyDrops();
          if (drops2.length > 0) {
            allCollected.push(...drops2);
            log.info(`📦 ドロップ回収: ${drops2.join(', ')}`, 'green');
          } else {
            log.warn(`📦 ドロップ未回収（${lastTargetName}のキル後）`);
          }

          if (maxKills > 0 && kills >= maxKills) break;

          target = findTarget();
          if (!target) break;
          lastTargetName = target.name || 'unknown';
          log.info(`🔄 次のターゲット: ${lastTargetName} (${Math.round(target.position.distanceTo(this.bot.entity.position))}m)`, 'cyan');
        }
      }

      this.stopMovement();
      const finalDrops = await this.collectNearbyDrops();
      if (finalDrops.length > 0) {
        allCollected.push(...finalDrops);
        log.info(`📦 最終回収: ${finalDrops.join(', ')}`, 'green');
      }

      if (attackCount === 0) {
        const near = this.holding ? Object.values(this.bot.entities).filter((entity: any) => entity?.position && entity !== this.bot.entity
          && matchesTarget(String(entity.name ?? '').toLowerCase()) && entity.position.distanceTo(this.bot.entity.position) <= maxDistance).length : 0;
        return {
          success: false,
          result: this.holding
            ? `${maxDistance}ブロック以内に${targetDesc}は${near}体いますが、その場から見えて手の届く所（目から3ブロック以内）には来ませんでした`
            : `${lastTargetName}に攻撃できませんでした`,
          failureType: 'target_not_found',
          recoverable: true,
        };
      }

      // 周囲の同種エンティティを再スキャンして残りを報告
      const remainingInfo = this.scanRemaining(matchesTarget, targetDesc, maxDistance);

      const killInfo = kills > 0
        ? `${kills}体撃破（${killedNames.join(', ')}）`
        : `${lastTargetName}を攻撃中（未撃破）`;
      const collectInfo = allCollected.length > 0
        ? `。回収: ${allCollected.join(', ')}`
        : '';
      const baseMsg = `${killInfo}、計${attackCount}回攻撃（${weaponEquipped}使用）${collectInfo}`;

      return {
        success: true,
        result: remainingInfo ? `${baseMsg}。${remainingInfo}` : baseMsg,
      };
    } catch (error: any) {
      this.stopMovement();
      return { success: false, result: `連続攻撃エラー: ${error.message}` };
    }
  }

  /** 最強の武器を装備。装備した武器名を返す */
  private async equipBestWeapon(): Promise<string> {
    const weaponPriority = [
      'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
      'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe',
    ];

    for (const weaponName of weaponPriority) {
      const item = this.bot.inventory.items().find(i => i.name === weaponName);
      if (item) {
        try {
          await this.bot.equip(item, 'hand');
          return weaponName;
        } catch { /* continue */ }
      }
    }
    return '素手';
  }

  /**
   * 周囲の対象エンティティを再スキャンし、残りの情報を返す。
   */
  private scanRemaining(
    matchFn: (name: string) => boolean,
    targetDesc: string,
    maxDistance: number,
  ): string | null {
    try {
      const nearby: Array<{ name: string; dist: number; x: number; y: number; z: number }> = [];
      for (const entity of Object.values(this.bot.entities)) {
        if (!entity || !entity.position || !entity.isValid) continue;
        if (entity === this.bot.entity) continue;
        const name = entity.name?.toLowerCase() || '';
        if (!name) continue;
        const d = entity.position.distanceTo(this.bot.entity.position);
        if (d > maxDistance) continue;
        if (!matchFn(name)) continue;

        nearby.push({
          name: entity.name || name,
          dist: Math.round(d * 10) / 10,
          x: Math.floor(entity.position.x),
          y: Math.floor(entity.position.y),
          z: Math.floor(entity.position.z),
        });
      }

      if (nearby.length === 0) {
        return `周囲${maxDistance}ブロック以内に${targetDesc}はもういません`;
      }

      nearby.sort((a, b) => a.dist - b.dist);
      const shown = nearby.slice(0, 5);
      const list = shown.map(e => `${e.name}(${e.x},${e.y},${e.z}) ${e.dist}m`).join(', ');
      const more = nearby.length > 5 ? `ほか${nearby.length - 5}匹` : '';
      return `周囲にまだ${nearby.length}匹: ${list}${more ? ', ' + more : ''}`;
    } catch {
      return null;
    }
  }

  /**
   * キル後のドロップアイテムを回収する。
   * digBlockAt と同じインベントリ検証方式:
   *   1. スナップショット比較でインベントリ増分を待つ
   *   2. 増分なし → gotoSafe でアイテムエンティティに歩いて拾う
   *   3. 拾えたか再度インベントリで確認
   */
  /** Set for the run: the body stays where it is (see the holdPosition parameter). */
  private holding = false;

  /**
   * The nearest wanted target with a point of its body that the eyes can see within a blow (three blocks, as
   * the server allows), and that point. What is behind a wall is not struck at: see utils/sightLine.
   */
  private nearestInReach(matches: (name: string) => boolean): { entity: any; point: any } | null {
    const eyes = this.bot.entity.position.offset(0, 1.62, 0);
    let best: { entity: any; point: any } | null = null, bestDistance = Infinity;
    for (const entity of Object.values(this.bot.entities) as any[]) {
      if (!entity?.position || entity === this.bot.entity || entity.isValid === false) continue;
      if (!matches(String(entity.name ?? '').toLowerCase())) continue;
      if (entity.position.distanceTo(this.bot.entity.position) > HOLD_REACH + 3) continue;
      const point = visiblePointOn(this.bot as any, entity, HOLD_REACH);
      if (!point) continue;
      const distance = point.distanceTo(eyes);
      if (distance < bestDistance) { best = { entity, point }; bestDistance = distance; }
    }
    return best;
  }

  private async collectNearbyDrops(): Promise<string[]> {
    const before = this.snapshotInventory();

    // ドロップスポーン待ち
    await actionDelay(this.bot, 450);

    // Phase 1: 自然回収を待つ（近くにいれば自動で拾う）
    await this.waitForPickup(before, 1500);
    if (this.holding) return this.inventoryDiff(before);

    // Phase 2: walk to every drop still lying there. A kill leaves several
    // items (a sheep: wool and mutton); stopping at the first one picked up
    // left the rest on the ground, and three sheep yielded two wool, one
    // short of a bed (lab probe).
    const deadline = Date.now() + DROP_COLLECT_BUDGET_MS;
    const given = new Set<number>();
    while (Date.now() < deadline && !this.shouldInterrupt()) {
      const item = this.bot.nearestEntity(
        e => e.name === 'item' && !given.has(e.id) && e.position.distanceTo(this.bot.entity.position) < DROP_COLLECT_RADIUS,
      );
      if (!item) break;
      const itemPos = item.position;
      if (itemPos.distanceTo(this.bot.entity.position) > 1) {
        try {
          await gotoSafe(this.bot, new goals.GoalNear(itemPos.x, itemPos.y, itemPos.z, 0), { timeoutMs: 4000, stuckAbortCount: 3, logStuck: false });
        } catch { /* ignore */ }
        this.stopMovement();
      }
      await actionDelay(this.bot, 400);
      // Still there after standing on it: not ours to pick up (full pack, or out of reach). Do not circle it.
      if (this.bot.entities[item.id]) given.add(item.id);
    }

    return this.inventoryDiff(before);
  }

  /** インベントリ増分をポーリングで待つ（軽量版 waitForCollection） */
  private async waitForPickup(
    before: Map<string, number>,
    timeoutMs: number,
  ): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    const POLL_MS = 150;
    const STABLE_MS = 400;
    let stableSince = Date.now();
    let prevSig = this.inventorySignature();
    let sawPickup = false;

    while (Date.now() < deadline) {
      await actionDelay(this.bot, POLL_MS);
      const diff = this.inventoryDiff(before);
      if (diff.length > 0) sawPickup = true;

      const sig = this.inventorySignature();
      if (sig !== prevSig) {
        prevSig = sig;
        stableSince = Date.now();
      } else if (sawPickup && Date.now() - stableSince >= STABLE_MS) {
        return this.inventoryDiff(before);
      }
    }
    return sawPickup ? this.inventoryDiff(before) : [];
  }

  private snapshotInventory(): Map<string, number> {
    const m = new Map<string, number>();
    for (const item of this.bot.inventory.items()) {
      m.set(item.name, (m.get(item.name) || 0) + item.count);
    }
    return m;
  }

  private inventoryDiff(before: Map<string, number>): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const item of this.bot.inventory.items()) {
      if (seen.has(item.name)) continue;
      seen.add(item.name);
      const beforeCount = before.get(item.name) || 0;
      const currentCount = this.bot.inventory.items()
        .filter(i => i.name === item.name)
        .reduce((sum, i) => sum + i.count, 0);
      if (currentCount > beforeCount) {
        result.push(`${item.name}x${currentCount - beforeCount}`);
      }
    }
    return result;
  }

  private inventorySignature(): string {
    return this.bot.inventory.items()
      .map(i => `${i.name}:${i.count}`)
      .sort()
      .join(',');
  }

  private stopMovement() {
    try {
      this.bot.setControlState('forward', false);
      this.bot.setControlState('sprint', false);
      this.bot.setControlState('jump', false);
    } catch { /* ignore */ }
  }
}

export default AttackContinuously;
