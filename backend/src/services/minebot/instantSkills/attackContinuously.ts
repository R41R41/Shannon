import pathfinder from 'mineflayer-pathfinder';
import { createLogger } from '../../../utils/logger.js';
import { CustomBot, InstantSkill } from '../types.js';
import { shouldRefuseAggressiveCombat } from '../utils/minebotToolPolicy.js';
import { reflexPromptText } from '../utils/floorConfig.js';
import { gotoSafe } from '../utils/gotoSafe.js';
import { pickupGoal } from '../execution/collectDrops.js';
import { actionDelay } from '../execution/observedWait.js';
import { visiblePointOn } from '../utils/sightLine.js';
import { WOOL_COLORS, sheepWool, woolStatusLine } from '../utils/nightGate.js';
import { creeperMeleeRefusal } from '../utils/creeperFuse.js';
import { holdsWater } from '../utils/waterBlocks.js';
import { explainUnreachable, type Unreachable } from '../utils/attackReach.js';
import type { Vec3 } from 'vec3';

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
/** Drops are also looked for this close to where the target was last seen alive. */
const DROP_NEAR_KILL = 6;

export { sheepWool };
/** From the eyes to the nearest point of a target's body within which a blow lands. */
const HOLD_REACH = 3;
/** A target in the water is let go after this long without a blow; the whole call stops after WATER_TOTAL_MS in the water. */
const WATER_TARGET_MS = 12_000;
const WATER_TOTAL_MS = 40_000;
/**
 * A target that is not a hostile (it does not come to the body) and that the chase has not got a block nearer to, nor struck, for this long is
 * given up, and the cause is looked for (utils/attackReach). Run 22: a chicken 48 m off was chased for the call's whole minute, a route search
 * of 6 s at a time that never moved the body, and the answer was only "cannot attack".
 */
const STALL_GIVE_UP_MS = 10_000;
/** With no blow struck, this many targets given up end the call (the next would be given up in the same way). */
const MAX_UNREACHABLE = 2;

class AttackContinuously extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'attack-continuously';
    this.description = '範囲内の対象を次々に追って倒す（狩り・群れ。武器は自動で持つ）。maxKillsで数を決め、holdPositionで動かずに迎え撃つ';
    this.params = [
      {
        name: 'entityName',
        type: 'string',
        description: '攻撃対象。単体名(cow)、カンマ区切り(cow,pig,chicken,sheep)、または特殊キーワード: "food_animals"(食料モブ一括), "hostile"(敵対Mob)。省略時は敵対的Mobのみ。'
          + 'ここで指定した相手は、このスキルの実行中は「近くに居る・当ててきた」だけでは緊急対応に中断されない（体力が半分以下になるか、指定していない別の種類が近づくと中断される）'
          + (process.env.MINEBOT_COMMON_FCA === 'on' ? `。今の作り（共通FCA）では緊急対応の割り込みはない（${reflexPromptText()}）ので、体力は観測で見て自分で退くこと` : ''),
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
      {
        name: 'color',
        type: 'string',
        description: '羊の毛の色で狙いを絞る（例: white。ベッドには同じ色の羊毛が3個要る）。毛を刈られた羊は狙わない。羊以外の対象には効かない',
        default: '',
      },
    ];
  }

  /** A creeper asked for by name is not chased into melee (utils/creeperFuse). */
  protected preflight(entityName: string = '', _maxAttacks?: number, _maxDistance?: number, _maxKills?: number, holdPosition?: boolean) {
    // Holding position (in a shelter, at a slit), a creeper that comes up is struck: it is the one place a blow at it is safe.
    if (holdPosition === true) return null;
    return creeperMeleeRefusal(String(entityName ?? '').split(','));
  }

  async runImpl(entityName: string = '', maxAttacks: number = 30, maxDistance: number = 24, maxKills: number = 0, holdPosition: boolean = false, color: string = '') {
    this.holding = holdPosition === true;
    this.blows = new Map();
    try {
      const woolColor = String(color ?? '').trim().toLowerCase().replace(/_wool$/, '');
      if (woolColor && !(WOOL_COLORS as readonly string[]).includes(woolColor)) {
        return { success: false, failureType: 'invalid_input', recoverable: false, result: `羊の色 ${woolColor} はありません（使える色: ${WOOL_COLORS.join(', ')}）` };
      }
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
      // A colour asked for: a sheep of another colour, or one already shorn, is not a target (other kinds are not affected).
      const matchesEntity = (entity: any): boolean => {
        const name = String(entity?.name ?? '').toLowerCase();
        if (!matchesTarget(name)) return false;
        // A group ("hostile", or none named) leaves creepers out; holding position, one that comes up to the slit is still struck.
        if (name === 'creeper' && !this.holding && !rawInput.split(',').map(s => s.trim()).includes('creeper')) return false;
        if (!woolColor || name !== 'sheep') return true;
        const wool = sheepWool(this.bot, entity);
        return !!wool && !wool.sheared && wool.color === woolColor;
      };

      const targetDesc = (targetNames.length > 0
        ? (targetNames.length <= 3 ? targetNames.join('/') : `${targetNames.slice(0, 3).join('/')}等`)
        : '敵対的Mob') + (woolColor ? `（${woolColor}の羊）` : '');

      // ── 武器を装備 ──
      let weaponEquipped = await this.equipBestWeapon();

      // Targets let go of in the water (see WATER_TARGET_MS): not picked again in this call.
      const letGo = new Set<unknown>();
      // ── 対象を検索 (広い範囲) ──
      const findTarget = () => this.bot.nearestEntity((entity) => {
        if (!entity || !entity.position || letGo.has(entity)) return false;
        const d = entity.position.distanceTo(this.bot.entity.position);
        if (d > maxDistance) return false;
        return matchesEntity(entity);
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
      /** Where the target was last seen alive: its drops lie there, wherever the body is when it is found dead. */
      let lastSeenAt = target.position.clone();
      /** The target the weapon was last chosen for: a new one gets the best weapon in hand again (a walk or a meal may have changed it). */
      let armedFor: unknown = null;
      const killedNames: string[] = [];
      const allCollected: string[] = [];
      const startTime = Date.now();
      const TIMEOUT = 60000;
      // The chase in the water, kept short (run 19: salmon in a frozen sea, four calls and about 400 s for four fish, the air reflex
      // cutting in twice): a target in the water, or the body swimming, is let go after WATER_TARGET_MS without a blow, and the whole
      // call stops after WATER_TOTAL_MS of it.
      let waterSince: number | null = null, waterTotal = 0, waterTick = Date.now(), lastWet = false;
      const wetNames: string[] = [];
      let waterStopped = false;
      // The chase of the current target: how near it has got, when it last got a block nearer or struck, and the targets given up.
      let tracked: unknown = null, trackFirst = 0, trackBest = Infinity, trackSince = 0, trackProgressAt = 0;
      const unreachable: Array<Unreachable & { name: string }> = [];

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
              ? `中断。${attackCount}回攻撃${killInfo}（${this.describeBlows()}）`
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

          const drops = await this.collectNearbyDrops(lastSeenAt);
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

        lastSeenAt = target.position.clone();
        const distance = target.position.distanceTo(this.bot.entity.position);

        // Not for a hostile: one in the water that is coming at the body is not left to it.
        if (!this.holding && this.bot.registry?.entitiesByName?.[target.name ?? '']?.type !== 'hostile') {
          const now = Date.now();
          const wet = (this.bot.entity as { isInWater?: boolean } | undefined)?.isInWater === true || this.inWater(target);
          // Counted only between two passes both in the water: a walk on land that ends at the shore is not time in it.
          if (wet) { if (lastWet) waterTotal += now - waterTick; waterSince ??= now; } else waterSince = null;
          waterTick = now; lastWet = wet;
          if (wet && (now - waterSince! > WATER_TARGET_MS || waterTotal > WATER_TOTAL_MS)) {
            this.stopMovement();
            letGo.add(target);
            wetNames.push(target.name || 'unknown');
            if (waterTotal > WATER_TOTAL_MS) { waterStopped = true; break; }
            waterSince = null;
            target = findTarget();
            if (!target) break;
            lastTargetName = target.name || 'unknown';
            continue;
          }
        }

        if (distance > maxDistance) {
          target = findTarget();
          if (!target) break;
          lastTargetName = target.name || 'unknown';
          continue;
        }

        // Holding its ground (inside a cover, at a hole in a wall): it does not go after anything. A blow is
        // struck only at what has come within a blow of the eyes, and the nearest of those is the one struck.
        if (this.holding) {
          const inReach = this.nearestInReach(matchesEntity);
          if (inReach) {
            target = inReach.entity as NonNullable<typeof target>;
            lastTargetName = target.name || 'unknown';
            if (armedFor !== target || !this.holdsWeapon(weaponEquipped)) { weaponEquipped = await this.equipBestWeapon(); armedFor = target; }
            await this.bot.lookAt(inReach.point);
            this.noteBlow();
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
        // Within a blow means a point of the target's body within three blocks of the eyes, as the server counts it. A blow
        // struck from 4.5 m (feet to feet) at a chicken missed: four chickens took nineteen blows (run 16).
        let aim = visiblePointOn(this.bot as any, target, HOLD_REACH);
        // A target that does not come to the body (not a hostile) and is not got any nearer, nor struck, is given up with its cause.
        const targetName = String(target.name ?? '').toLowerCase();
        if (!hostileMobs.some(mob => targetName.includes(mob))) {
          const now = Date.now();
          if (tracked !== target) { tracked = target; trackFirst = trackBest = distance; trackSince = trackProgressAt = now; }
          else if (distance < trackBest - 1) { trackBest = distance; trackProgressAt = now; }
          // A chase in the water has its own limits above (WATER_TARGET_MS, WATER_TOTAL_MS): it is not counted here.
          if ((this.bot.entity as { isInWater?: boolean } | undefined)?.isInWater === true || this.inWater(target)) trackProgressAt = now;
          if (!aim && now - trackProgressAt > STALL_GIVE_UP_MS) {
            this.stopMovement();
            const why = explainUnreachable(this.bot as any, target as any, Math.max(0, trackFirst - distance), (now - trackSince) / 1000);
            log.warn(`🚫 ${target.name}を諦めます: ${why.reason}`);
            unreachable.push({ ...why, name: target.name || 'unknown' });
            letGo.add(target);
            if (attackCount === 0 && unreachable.length >= MAX_UNREACHABLE) break;
            target = findTarget();
            if (!target) break;
            lastTargetName = target.name || 'unknown';
            continue;
          }
        }
        if (!aim && distance > 2.5) {
          const tp = target.position;
          try {
            await gotoSafe(this.bot, new goals.GoalNear(tp.x, tp.y, tp.z, 2), {
              // A far target gets time to be walked towards (a 6 s search from 48 m never left the spot in run 22).
              timeoutMs: Math.min(distance > 24 ? 12_000 : 6000, Math.max(2500, distance * 250)),
              stuckAbortCount: 3,
              logStuck: false,
            });
          } catch { /* ignore */ }
          this.stopMovement();
          if (!target.isValid) continue;
          lastSeenAt = target.position.clone();
          aim = visiblePointOn(this.bot as any, target, HOLD_REACH);
        }

        // ── 攻撃 ──
        // The best weapon back in hand for each new target, and whenever the hand holds something else: the walk puts blocks and
        // tools in hand, a meal puts food there, and the blows went in with them while the result said "stone_sword" (run 16).
        if (target.isValid && (armedFor !== target || !this.holdsWeapon(weaponEquipped))) {
          weaponEquipped = await this.equipBestWeapon();
          armedFor = target;
        }
        const attackDist = target.position.distanceTo(this.bot.entity.position);
        if (target.isValid && (aim || attackDist <= HOLD_REACH)) {
          await this.bot.lookAt(aim ?? target.position.offset(0, target.height * 0.8, 0));
          this.noteBlow();
          await this.bot.attack(target);
          attackCount++;
          trackProgressAt = Date.now();
          waterSince = null; // a blow struck: the chase in the water is getting somewhere

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

          const drops2 = await this.collectNearbyDrops(lastSeenAt);
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

      const waterNote = wetNames.length
        ? `水中の${[...new Set(wetNames)].join('・')}は追いきれず、${wetNames.length}匹をあきらめました（水の中で計${Math.round(waterTotal / 1000)}秒${waterStopped ? '、この呼び出しはここまで' : ''}。泳ぎながらでは攻撃が届きにくい）。陸の動物か、岸から届く相手を先に`
        : '';
      if (attackCount === 0 && waterNote) {
        return { success: false, failureType: 'target_not_found', recoverable: true, result: `${lastTargetName}に攻撃できませんでした。${waterNote}` };
      }
      // Given up early, with the cause: a different animal or place, or the cause put right, is the next move (run 22: 62 s for "cannot attack").
      const unreachableNote = unreachable.length
        ? `届かなかった相手: ${unreachable.map(entry => `${entry.name}（${entry.reason}）`).join('、')}`
        : '';
      if (attackCount === 0 && unreachable.length) {
        return { success: false, failureType: 'target_unreachable', recoverable: true,
          result: `${unreachable[0].name}に攻撃できませんでした。理由: ${unreachable.map(entry => entry.reason).join('／')}。`
            + `${unreachable.some(entry => entry.kind === 'height' || entry.kind === 'fence') ? '別の相手を探すか、場所を変えてから呼び直してください' : '近くの別の相手を探すか、少し動いてから呼び直してください'}` };
      }
      if (attackCount === 0) {
        const near = this.holding ? Object.values(this.bot.entities).filter((entity: any) => entity?.position && entity !== this.bot.entity
          && matchesEntity(entity) && entity.position.distanceTo(this.bot.entity.position) <= maxDistance).length : 0;
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
      const remainingInfo = this.scanRemaining(matchesEntity, targetDesc, maxDistance);

      const killInfo = kills > 0
        ? `${kills}体撃破（${killedNames.join(', ')}）`
        : `${lastTargetName}を攻撃中（未撃破）`;
      const collectInfo = allCollected.length > 0
        ? `。回収: ${allCollected.join(', ')}`
        : '';
      const baseMsg = `${killInfo}、計${attackCount}回攻撃（${this.describeBlows()}）${collectInfo}`;
      // After sheep: whether the wool makes a bed now, or which colour is still wanted (the owner, 2026-10-20: make the bed as soon
      // as three are in hand, and know at once when the colours do not match).
      let woolLine = '';
      try { if (killedNames.includes('sheep')) woolLine = woolStatusLine(this.bot.inventory.items()); } catch { woolLine = ''; }

      return {
        success: true,
        result: [baseMsg, remainingInfo, woolLine, waterNote, unreachableNote].filter(Boolean).join('。'),
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
    matchFn: (entity: any) => boolean,
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
        if (!matchFn(entity)) continue;

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
  private nearestInReach(matches: (entity: any) => boolean): { entity: any; point: any } | null {
    const eyes = this.bot.entity.position.offset(0, 1.62, 0);
    let best: { entity: any; point: any } | null = null, bestDistance = Infinity;
    for (const entity of Object.values(this.bot.entities) as any[]) {
      if (!entity?.position || entity === this.bot.entity || entity.isValid === false) continue;
      if (!matches(entity)) continue;
      if (entity.position.distanceTo(this.bot.entity.position) > HOLD_REACH + 3) continue;
      const point = visiblePointOn(this.bot as any, entity, HOLD_REACH);
      if (!point) continue;
      const distance = point.distanceTo(eyes);
      if (distance < bestDistance) { best = { entity, point }; bestDistance = distance; }
    }
    return best;
  }

  /**
   * `at`: where the target was last seen alive. Its drops are looked for round there as well as round the body, and when none is
   * seen, the body walks there once: three kills of run 16 left their drops lying (two of them a chicken's, one a sheep's wool),
   * the search having looked only round the spot the body stood on when it struck.
   */
  private async collectNearbyDrops(at?: Vec3): Promise<string[]> {
    const before = this.snapshotInventory();

    // ドロップスポーン待ち
    await actionDelay(this.bot, 450);

    // Phase 1: 自然回収を待つ（近くにいれば自動で拾う）. Only for a drop at the feet: one lying a few blocks off is not picked up by
    // waiting, and the wait cost each such kill a second and a half before the walk to it began (run 19: the rabbits at 226 s and 1,085 s).
    const isDrop = (e: any) => e?.name === 'item' || String(e?.displayName) === 'Item';
    const atFeet = this.bot.nearestEntity(e => isDrop(e) && e.position.distanceTo(this.bot.entity.position) < 1.6);
    await this.waitForPickup(before, atFeet ? 1500 : 0);
    if (this.holding) return this.inventoryDiff(before);

    // Phase 2: walk to every drop still lying there. A kill leaves several
    // items (a sheep: wool and mutton); stopping at the first one picked up
    // left the rest on the ground, and three sheep yielded two wool, one
    // short of a bed (lab probe).
    const deadline = Date.now() + DROP_COLLECT_BUDGET_MS;
    const given = new Set<number>();
    let wentToKill = false;
    const isItem = (e: any) => e?.name === 'item' || String(e?.displayName) === 'Item';
    while (Date.now() < deadline && !this.shouldInterrupt()) {
      const item = this.bot.nearestEntity(
        e => isItem(e) && !given.has(e.id) && (e.position.distanceTo(this.bot.entity.position) < DROP_COLLECT_RADIUS
          || (!!at && e.position.distanceTo(at) < DROP_NEAR_KILL)),
      );
      if (!item) {
        // Nothing seen from here: the drop may lie where the target fell, out of sight of where the body stood. One walk there.
        if (at && !wentToKill && at.distanceTo(this.bot.entity.position) > 1.5) {
          wentToKill = true;
          try { await gotoSafe(this.bot, new goals.GoalNear(at.x, at.y, at.z, 1), { timeoutMs: 4000, stuckAbortCount: 3, logStuck: false }); } catch { /* ignore */ }
          this.stopMovement();
          await actionDelay(this.bot, 300);
          continue;
        }
        break;
      }
      const itemPos = item.position;
      if (itemPos.distanceTo(this.bot.entity.position) > 1) {
        try {
          // A cell from which the drop is within pickup reach (collectDrops' own goal, judged against the item's real position): "within a
          // block" of its cell let the walk stop up to 1.4 m off, out of reach, and the drop was given up (run 19: 6 of 9 kills left theirs).
          // Where that cell has no route (a slope, an edge), within a block of it as before.
          let goal: ReturnType<typeof pickupGoal> | null = null;
          try { goal = pickupGoal(this.bot, itemPos); } catch { goal = null; }
          const near = goal ? await gotoSafe(this.bot, goal as any, { timeoutMs: 4000, stuckAbortCount: 3, logStuck: false }) : { success: false };
          if (!near.success && this.bot.entities[item.id]) {
            await gotoSafe(this.bot, new goals.GoalNear(itemPos.x, itemPos.y, itemPos.z, 1), { timeoutMs: 3000, stuckAbortCount: 3, logStuck: false });
          }
        } catch { /* ignore */ }
        this.stopMovement();
      }
      await actionDelay(this.bot, 400);
      // Still there after standing on it: not ours to pick up (full pack, or out of reach). Do not circle it.
      if (this.bot.entities[item.id]) given.add(item.id);
    }

    return this.inventoryDiff(before);
  }

  /** What each blow was struck with, by the hand at the time: blows by what was really held, not by the weapon first chosen. */
  private blows = new Map<string, number>();
  private noteBlow(): void {
    const held = this.bot.heldItem?.name ?? '素手';
    this.blows.set(held, (this.blows.get(held) ?? 0) + 1);
  }
  private describeBlows(): string {
    const used = [...this.blows.entries()].sort((a, b) => b[1] - a[1]);
    if (!used.length) return `${this.bot.heldItem?.name ?? '素手'}を手に`;
    return used.length === 1 ? `${used[0][0]}使用` : `${used.map(([name, count]) => `${name}×${count}`).join('・')}で攻撃`;
  }
  /** The hand holds the weapon chosen (with no weapon carried there is nothing to put back in hand). */
  private holdsWeapon(weapon: string): boolean {
    return weapon === '素手' || this.bot.heldItem?.name === weapon;
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

  /** Whether the entity is in the water (its feet or its middle in a water cell). */
  private inWater(entity: { position?: Vec3; height?: number } | null | undefined): boolean {
    try {
      const at = entity?.position;
      if (!at) return false;
      return holdsWater(this.bot.blockAt(at.floored())) || holdsWater(this.bot.blockAt(at.offset(0, (entity!.height ?? 0.5) / 2, 0).floored()));
    } catch { return false; }
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
