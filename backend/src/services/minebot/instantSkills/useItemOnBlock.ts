import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import type { Goal } from '../types/CustomBot.js';
import { ensureLineOfSight } from '../utils/blockLineOfSight.js';
import { getWaterLevel } from '../utils/waterLevel.js';
import { createLogger } from '../../../utils/logger.js';
import { activateItemFacing } from '../utils/activateItemFacing.js';
import { actionDelay } from '../execution/observedWait.js';
import pathfinder from 'mineflayer-pathfinder';
import { gotoSafe } from '../utils/gotoSafe.js';
import { goalTarget } from '../utils/farLegs.js';
import { holdClutterTidy, tidyIfCluttered } from '../utils/inventoryRoom.js';
import { PARTIAL_FAILURE, progressTrailer } from '../utils/partialProgress.js';
import { hostileNear } from './craftOne.js';
import { liquidAim, liquidAimPoints } from '../utils/liquidAim.js';
import { facePoints, rayFace } from '../utils/rayFace.js';
import { dropBurnsIn, lavaAroundCount, lavaBelowDrop } from '../utils/dropFate.js';
import { lavaSourceInfo, rankLavaSources, type LavaSourceInfo } from '../utils/lavaPools.js';
import { tidyPlan } from '../utils/inventoryTidy.js';
import { scoopWater } from '../utils/scoopWater.js';
/** Rock dug on the way that a full pack can spare, for the obsidian (see roomForDrops). */
const SPARE_ROCK = ['cobbled_deepslate', 'tuff', 'diorite', 'andesite', 'granite', 'dirt', 'gravel', 'calcite', 'netherrack', 'cobblestone'];

const { goals } = pathfinder;

const log = createLogger('Minebot:Skill:useItemOnBlock');
/** A walk of this skill through rock is given this long a metre (a straight tunnel cut at the pickaxe's time), at most WALK_MAX_MS. */
const WALK_MS_PER_M = 2_500;
const WALK_MAX_MS = 75_000;
/** How far from the lava asked for another source of the same pool is poured on instead, when none of its own faces can be seen. */
const POOL_REACH = 6;
/** The words the mind reads to drop a pool from its list ("this one has no lava to pour on, no obsidian to take"). */
const NO_MORE_LAVA = '近くに水をかけられる溶岩も、すぐ掘れる黒曜石も、もうありません';
/** Pours made ahead of a dig while some obsidian can be taken: past it the digging comes first (the pours make nothing to take, run 24: 55 for 9). */
const POUR_AHEAD = 4;
/** Pours in a row that make no obsidian: past it the call stops and says so, instead of going on for minutes. */
const MAX_WASTED_POURS = 6;
/** Obsidian with at most this many lava cells over or beside it is dug (the lava put out first) rather than left. */
const MAX_CRUSHED = 2;

/**
 * 原子的スキル: 指定座標のブロックにアイテムを使用（右クリック）
 *
 * water_bucket + lava → マグマ隣の固体ブロックに水を設置し水流で黒曜石を生成。
 */
class UseItemOnBlock extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'use-item-on-block';
    this.description =
      '手に持っているアイテムを指定ブロックに対して使用します（右クリック）。'
      + '⚠️ 黒曜石を作るには water_bucket を持って lava ブロックの座標を指定してください。'
      + 'スキル側が自動的にマグマ隣の固体ブロックに水を設置し、水流でマグマを黒曜石に変換します。'
      + '💧 水を汲むには itemName=bucket（空のバケツ）で呼びます。座標（x,y,z）は省略でき、省くと体が近く（既定48m以内、地上・開けた水面を優先）の水源を探して歩いて汲みます（記憶の水の場所も試す）。'
      + '座標を付けた時は、その水（水流や水面の1つ上/下の座標でも、近くの水源）を汲みます。汲んだ水入りのバケツ(water_bucket)は地下へ持って下りてください（地下で水を探さない）。';
    this.params = [
      {
        name: 'x',
        type: 'number',
        description: 'X座標（itemName=bucket で水を汲む時だけ省略できる）',
        required: false,
      },
      {
        name: 'y',
        type: 'number',
        description: 'Y座標（itemName=bucket で水を汲む時だけ省略できる）',
        required: false,
      },
      {
        name: 'z',
        type: 'number',
        description: 'Z座標（itemName=bucket で水を汲む時だけ省略できる）',
        required: false,
      },
      {
        name: 'itemName',
        type: 'string',
        description: '使うアイテムの正確なID（例: bucket, water_bucket, flint_and_steel）。指定すると使用直前にメインハンドへ装備する。省略時は現在の手持ち',
        required: false,
      },
      {
        name: 'count',
        type: 'number',
        description: 'water_bucket で溶岩を指した時だけ：集める黒曜石の数。1以上なら、その溶岩の溜まりで「水をかける→固まった黒曜石を掘る→水を回収→次の溶岩」を体の中で繰り返し、指定数まで集める（溶岩まで自分で歩く。diamond_pickaxe が要る）。省略か0なら1か所に水をかけるだけ',
        default: 0,
      },
      {
        name: 'maxDistance',
        type: 'number',
        description: 'itemName=bucket で座標を省いた時だけ：水源を探す範囲（m）。既定48。見つからなければ記憶の水の場所へも向かう',
        default: 48,
      },
    ];
    // Ten obsidian made and mined in one call: about twelve pours and ten digs of nine seconds (a ladder probe, 2026-10-20: 216 s).
    this.maxDurationMs = 300_000;
  }

  private liquidAim(pos: Vec3): { point?: Vec3; reason?: string } { return liquidAim(this.bot, pos); }

  /**
   * A walk of this skill's own to a pool, a shore or a block to dig. Through rock it is cut as a tunnel of straight runs (the walk of
   * move-to, utils/rockTravel), not left to the route search: run 23's 30 m to a second pool took 186 s (the old legs "in the rock" six
   * times, six digs undone by the server), and the walk to a shore of 15 m 41 s. The time is in proportion to the way, bounded by the
   * time the call has left (`capMs`).
   */
  private async walk(goal: Goal, baseMs: number, capMs: number = Infinity): Promise<void> {
    const handDigging = !this.bot.inventory.items().some(item => item.name.includes('pickaxe'));
    const target = goalTarget(goal);
    const here = this.bot.entity.position;
    const distance = target ? Math.hypot(target.x - here.x, (target.y ?? here.y) - here.y, target.z - here.z) : 0;
    const timeoutMs = Math.max(2_000, Math.min(Math.max(baseMs, Math.min(WALK_MAX_MS, distance * WALK_MS_PER_M)), capMs));
    const startedAt = Date.now();
    await gotoSafe(this.bot, goal, {
      timeoutMs, rockTravel: !handDigging,
      tunnelTidy: async () => {
        await tidyIfCluttered(this.bot as any, (skill, ...args) => this.callSkill(skill, ...args), {
          timeLeftMs: timeoutMs - (Date.now() - startedAt), interrupted: () => this.shouldInterrupt(),
          blocked: () => hostileNear(this.bot as any, 16) || String((this.bot as any).minebotControlState ?? '').startsWith('emergency'),
        });
      },
      tunnelPillar: (height: number) => this.callSkill('tower-up', height),
    });
  }

  async runImpl(x?: number | null, y?: number | null, z?: number | null, itemName?: string | null, count: number = 0, maxDistance: number = 48) {
    try {
      itemName = itemName ?? undefined;
      const absent = [x, y, z].filter(value => value === undefined || value === null).length;
      // An empty bucket needs no coordinates: the body finds the water itself (see utils/scoopWater).
      if (absent === 3) {
        if ((itemName ?? this.bot.heldItem?.name) === 'bucket') {
          return await scoopWater(this.bot, { maxDistance: Number(maxDistance) || 48, shouldStop: () => this.shouldInterrupt() });
        }
        return { success: false, failureType: 'invalid_input', recoverable: true,
          result: '座標（x, y, z）が必要です。座標を省けるのは itemName=bucket で水を汲む時だけです' };
      }
      if (absent > 0 || !Number.isFinite(Number(x)) || !Number.isFinite(Number(y)) || !Number.isFinite(Number(z))) {
        return {
          success: false,
          result: '座標は有効な数値である必要があります',
        };
      }
      x = Number(x); y = Number(y); z = Number(z);
      // An empty bucket at a named cell: that water, or the nearest source (a flowing cell, or one a block above or below the surface),
      // walked to if it is not at hand. Lava and powder snow keep the plain use below.
      if ((itemName ?? this.bot.heldItem?.name) === 'bucket') {
        const target = this.bot.blockAt(new Vec3(x, y, z));
        if (target?.name !== 'lava' && target?.name !== 'powder_snow') {
          return await scoopWater(this.bot, { near: new Vec3(x, y, z), maxDistance: Number(maxDistance) || 48, shouldStop: () => this.shouldInterrupt() });
        }
      }
      // Any count asked for collects (the last one of ten as well: a count of 1 meaning "pour once" left a probe at nine).
      const wanted = Math.floor(Number(count) || 0);
      if (wanted >= 1 && (itemName ?? this.bot.heldItem?.name) === 'water_bucket') {
        // The pack is not tidied while the obsidian is made: run 23 threw 176 cobbled deepslate away beside the lava after every obsidian
        // dug (4-6 s each, the heap fetched back and thrown again). Room is made when under two slots are free (roomForDrops), not before.
        const release = holdClutterTidy(this.bot);
        try { return await this.makeObsidian(new Vec3(x, y, z), wanted); } finally { release(); }
      }

      if (itemName) {
        const wanted = this.bot.inventory.items().find(item => item.name === itemName);
        if (!wanted && this.bot.heldItem?.name !== itemName) {
          return { success: false, failureType: 'material_missing', recoverable: true,
            result: itemName === 'bucket' ? 'バケツを持っていません（鉄 3 個で craft-one bucket）' : `${itemName}を持っていません` };
        }
        if (wanted && this.bot.heldItem?.name !== itemName) await this.bot.equip(wanted, 'hand');
      }
      const heldItem = this.bot.heldItem;
      if (!heldItem) {
        return {
          success: false,
          result: '手に何も持っていません',
        };
      }

      const pos = new Vec3(x, y, z);
      const block = this.bot.blockAt(pos);

      if (!block) {
        return {
          success: false,
          result: `座標(${x}, ${y}, ${z})にブロックが見つかりません`,
        };
      }

      const distance = this.bot.entity.position.distanceTo(pos);
      if (distance > 5) {
        return {
          success: false,
          result: `ブロックが遠すぎます（距離: ${distance.toFixed(1)}m、5m以内に近づいてください）`,
        };
      }

      // ── water_bucket × lava → 自動リダイレクトで黒曜石生成 ──
      if (heldItem.name === 'water_bucket' && block.name === 'lava') {
        // Rock over the source (run 24: 0 obsidian twice at a pool the search had called one to scoop): the cover is dug from beside it first.
        const info = lavaSourceInfo(this.bot as any, pos);
        if (info?.top === 'covered' && !(await this.openCover(info, () => this.maxDurationMs || 60_000))) {
          return { success: false, failureType: 'line_of_sight_blocked', recoverable: true,
            result: `マグマ(${pos.x},${pos.y},${pos.z})の上は岩で覆われていて、横の立ち位置(${info.stand!.x},${info.stand!.y},${info.stand!.z})から覆い(${info.cap!.x},${info.cap!.y},${info.cap!.z})を掘って開けられませんでした。別の溶岩を find-blocks lava で探してください` };
        }
        return await this.placeWaterNearLava(pos);
      }

      // ── bucket × liquid: 水源/溶岩源 level=0 チェック ──
      if (heldItem.name === 'bucket') {
        if (block.name === 'water' || block.name === 'lava') {
          const level = getWaterLevel(block);
          if (level > 0) {
            const typeName = block.name === 'water' ? '水流' : '溶岩流';
            return {
              success: false,
              result: `このブロックは${typeName}です（level=${level}）。バケツで汲めるのは水源/溶岩源（level=0）のみです。find-blocksで水源ブロックを探してください`,
            };
          }
        }
      }

      const itemBefore = heldItem.name;

      try {
        if (!(itemBefore === 'bucket' && (block.name === 'water' || block.name === 'lava'))) await this.bot.lookAt(pos.offset(0.5, 0.5, 0.5), true);
        // 液体は衝突判定のないブロックなので activateBlock() のレイキャスト
        // 対象にならない。空バケツは視線方向へ use_item を送り、Minecraft
        // サーバー自身に水源/溶岩源をレイキャストさせる。
        if (itemBefore === 'bucket' && (block.name === 'water' || block.name === 'lava')) {
          // The server takes the liquid its own ray from the eyes finds, within reach. Aimed at the middle of the
          // source from wherever the body stood, the ray met a bank or fell short, and the answer was only "could
          // not scoop: far, a bad angle or something in the way": a planner with a bucket spent seven calls
          // and two pillars on one pool (paid run L74). A point on the source the eyes can see is looked for;
          // with none, the body steps up to the source once.
          let aim = this.liquidAim(pos);
          if (!aim.point) {
            try { await this.walk(new goals.GoalNear(pos.x, pos.y, pos.z, 2), 8000); } catch { /* judged by the aim below */ }
            aim = this.liquidAim(pos);
          }
          if (!aim.point) {
            return { success: false, failureType: 'line_of_sight_blocked', recoverable: true,
              result: `${block.name}(${pos.x},${pos.y},${pos.z})にバケツが届きません: ${aim.reason}。その水源の真横か真上に立ってからやり直してください` };
          }
          await activateItemFacing(this.bot, aim.point);
        } else {
          await this.bot.activateBlock(block);
        }
      } catch (actionError: any) {
        // 失敗 → LOS遮蔽が原因かを診断
        const los = await ensureLineOfSight(this.bot, pos);
        if (!los.clear) {
          const failType = los.dugBlocks?.length ? 'obstruction_cleared' : 'line_of_sight_blocked';
          return { success: false, result: los.message!, failureType: failType, recoverable: true };
        }
        return { success: false, result: `使用エラー: ${actionError.message}` };
      }

      // バケツで液体/粉雪を汲む操作の検証: 手持ちが実際に変化したか確認
      if (itemBefore === 'bucket' && (block.name === 'water' || block.name === 'lava' || block.name === 'powder_snow')) {
        const expected = block.name === 'water' ? 'water_bucket'
          : block.name === 'lava' ? 'lava_bucket'
          : 'powder_snow_bucket';
        // The held-item update can arrive after several ticks.
        const heldDeadline = Date.now() + 1500;
        while (Date.now() < heldDeadline && this.bot.heldItem?.name !== expected) await actionDelay(this.bot, 100);
        const itemAfter = this.bot.heldItem?.name;
        if (itemAfter !== expected) {
          const blockAfter = this.bot.blockAt(pos);
          const stillThere = blockAfter && blockAfter.name === block.name;
          return {
            success: false,
            result: `${block.name}にバケツを使いましたが汲めませんでした（手持ち: ${itemAfter ?? 'なし'}）。`
              + (stillThere ? `${block.name}はまだ存在しています。` : '')
              + `原因: 距離が遠い・角度が悪い・遮蔽物がある可能性。move-toで近づいてから再試行してください。`,
          };
        }
        return {
          success: true,
          result: `${expected}を入手しました（${block.name}を(${x},${y},${z})から回収）`,
        };
      }

      return {
        success: true,
        result: `${itemBefore}を${block.name}に使用しました`,
      };
    } catch (error: any) {
      return {
        success: false,
        result: `使用エラー: ${error.message}`,
      };
    }
  }

  /**
   * マグマ隣の固体ブロックに水を設置して水流で黒曜石を生成する。
   * マグマに直接水バケツを使うのではなく、水流がマグマに当たるように設置する。
   */
  private async placeWaterNearLava(lavaPos: Vec3) {
    if (!this.findWaterPlacementsForLava(lavaPos).length) {
      return {
        success: false,
        result: `マグマ(${lavaPos.x},${lavaPos.y},${lavaPos.z})の隣に水を設置できる固体ブロックがありません。`
          + `マグマの端（固体ブロックが隣接する場所）に近づいてから再試行してください。`,
      };
    }
    // The face the server's ray will hit from here, of every way to pour (see rayFace); from nowhere here, from a stand a few blocks
    // off, once. Aimed at a face whose line another block crosses, the water lands in front of that other block instead. Any source of
    // the same pool will do (within POOL_REACH of the one asked for): a lake under a low roof has sources no face of which can be seen
    // and others at its shore that can (lab probe 2026-10-20: twenty refusals at one source of such a lake).
    // Water does not stay in the Nether: the bucket would only be emptied.
    if (String(this.bot.game?.dimension ?? '').includes('nether')) {
      return { success: false, failureType: 'invalid_input', recoverable: false, result: 'ネザーでは水が蒸発するため、溶岩に水を流して黒曜石を作ることはできません' };
    }
    const pool = this.poolSources(lavaPos);
    const pick = (eyes?: Vec3) => { for (const source of pool) { const found = this.visibleWaterPlacement(source, eyes); if (found) return { ...found, lava: source }; } return null; };
    let chosen = pick();
    if (!chosen) {
      // Stands from which a pour would be seen, judged before walking there (eyes at the stand), nearest first.
      const here = this.bot.entity.position;
      const stands = pool.slice(0, 6).flatMap(source => this.waterStands(source)).filter((stand, index, all) => all.findIndex(other => other.equals(stand)) === index)
        .sort((a, b) => a.distanceTo(here) - b.distanceTo(here)).slice(0, 40)
        .filter(stand => pick(stand.offset(0.5, 1.62, 0.5)) !== null);
      for (const stand of stands.slice(0, 3)) {
        try { await this.walk(new goals.GoalBlock(stand.x, stand.y, stand.z), 8000); } catch { /* judged below */ }
        chosen = pick();
        if (chosen) break;
      }
    }
    if (chosen && !chosen.lava.equals(lavaPos)) {
      log.info(`💧 指定のマグマ(${lavaPos.x},${lavaPos.y},${lavaPos.z})には面が見えないため、同じ溜まりの(${chosen.lava.x},${chosen.lava.y},${chosen.lava.z})へ流す`);
      lavaPos = chosen.lava;
    }
    if (!chosen) {
      return { success: false, failureType: 'line_of_sight_blocked', recoverable: true,
        result: `マグマ(${lavaPos.x},${lavaPos.y},${lavaPos.z})に水を流せる面が、ここからも近くの立ち位置からも見えません（ほかのブロックが視線を遮る）。`
          + 'マグマの縁の固い床の上（マグマと同じか1つ上の高さ）に立ってから、もう一度呼んでください' };
    }

    const { refBlock, faceVec, aim } = chosen;
    const waterPos = refBlock.position.plus(faceVec);
    const losTarget = refBlock.position;

    log.info(`💧 マグマ(${lavaPos.x},${lavaPos.y},${lavaPos.z})に対し ${refBlock.name}(${losTarget.x},${losTarget.y},${losTarget.z}) の面(${faceVec.x},${faceVec.y},${faceVec.z})に水を設置`);

    try {
      // A bucket is an item use resolved by the server's own ray cast, not a
      // block placement: placeBlock sends only use_item_on and never pours.
      const sourcesBefore = this.waterSourcesNear(5);
      // The walk to a stand places blocks from the hand: the bucket is taken up again (ladder probe: "手持ち: dirt", 10 s lost each).
      if (this.bot.heldItem?.name !== 'water_bucket') {
        const bucket = this.bot.inventory.items().find(item => item.name === 'water_bucket');
        if (bucket) await this.bot.equip(bucket, 'hand');
      }
      await activateItemFacing(this.bot, aim);
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline && this.bot.blockAt(waterPos)?.name !== 'water') await actionDelay(this.bot, 100);
      if (this.bot.blockAt(waterPos)?.name !== 'water') {
        // Poured somewhere else after all: that water is taken back, so the bucket is not lost to the floor.
        const stray = this.waterSourcesNear(5).find(at => !sourcesBefore.has(`${at.x},${at.y},${at.z}`));
        let back = false;
        if (stray && this.bot.heldItem?.name === 'bucket') back = await this.scoop(stray);
        return {
          success: false,
          result: `水バケツを(${waterPos.x},${waterPos.y},${waterPos.z})へ使いましたが水が置かれていません（手持ち: ${this.bot.heldItem?.name ?? 'なし'}）。`
            + (stray ? `水は(${stray.x},${stray.y},${stray.z})に置かれ、${back ? 'バケツに汲み直しました' : '汲み直せませんでした（空バケツで回収してください）'}。` : '')
            + '設置面が見える位置へ近づき、別の縁から再試行してください。',
          failureType: 'placement_unconfirmed',
          recoverable: true,
        };
      }
    } catch (placeError: any) {
      // Cancellation is not a line-of-sight failure: never dig obstructions after it.
      if (this.shouldInterrupt()) throw placeError;
      const los = await ensureLineOfSight(this.bot, losTarget);
      if (!los.clear) {
        const failType = los.dugBlocks?.length ? 'obstruction_cleared' : 'line_of_sight_blocked';
        return { success: false, result: los.message!, failureType: failType, recoverable: true };
      }
      return { success: false, result: `水の設置エラー: ${placeError.message}` };
    }

    // 水流がマグマに到達するまで待つ（流水は数tickずつ広がる）。長く待つと
    // Bot自身が流されて水源に届かなくなるため、1.5秒で打ち切る。
    const convertDeadline = Date.now() + 1500;
    while (Date.now() < convertDeadline && this.bot.blockAt(lavaPos)?.name !== 'obsidian') await actionDelay(this.bot, 100);
    // Scoop the source back at once, as a player does: a flooded pit slows
    // obsidian mining about fivefold and pushes the bot out of reach.
    let recovered = false;
    if (this.bot.heldItem?.name === 'bucket' && this.bot.blockAt(waterPos)?.name === 'water') {
      // Read afresh each tick: the held item changes from a server packet.
      const heldName = (): string | undefined => this.bot.heldItem?.name;
      // Each point of the source the eyes can see, in turn: the centre can lie behind the edge of a block
      // the line to it clips (paid run L77 left its water standing and lost it).
      const visible = liquidAimPoints(this.bot, waterPos).points;
      for (const point of visible.length ? visible.slice(0, 4) : [waterPos.offset(0.5, 0.5, 0.5)]) {
        try {
          await activateItemFacing(this.bot, point);
          const scoopDeadline = Date.now() + 800;
          while (Date.now() < scoopDeadline && heldName() !== 'water_bucket') await actionDelay(this.bot, 100);
        } catch { /* reported below */ }
        if (heldName() === 'water_bucket') { recovered = true; break; }
      }
    }

    const afterBlock = this.bot.blockAt(lavaPos);
    const converted = afterBlock && afterBlock.name === 'obsidian';
    const obsidianAt: Vec3[] = this.bot.findBlocks?.({ matching: (candidate: any) => candidate?.name === 'obsidian',
      point: lavaPos, maxDistance: 8, count: 64 }) ?? [];
    // Obsidian over the rest of the pool burns its drop: how many can be mined straight away decides whether to pour on more (a ladder
    // probe, 2026-10-20, poured ten, found eight it could take, and spent 500 s on the last two over lava).
    const clean = obsidianAt.filter(at => !dropBurnsIn(this.bot as any, at)).length;
    const obsidianNearby = `${obsidianAt.length}個、うち下と隣に溶岩が無くすぐ掘れるもの${clean}個`;

    return {
      success: true,
      // For makeObsidian: whether the lava poured on became obsidian, and which source it was (the pool's other source when this one had no face to see).
      converted: !!converted,
      pouredAt: lavaPos,
      result: converted
        ? `✅ マグマ(${lavaPos.x},${lavaPos.y},${lavaPos.z})が黒曜石に変換されました（周囲8m内の黒曜石${obsidianNearby}）。`
          + (recovered ? '水はwater_bucketへ回収済み。残りの溶岩には別の縁から同様に水を流せます。diamond_pickaxeで黒曜石を採掘できます。'
            : `水源(${waterPos.x},${waterPos.y},${waterPos.z})が残っています。近づいて空バケツで回収してから、diamond_pickaxeで黒曜石を採掘してください（水中の採掘は遅い）。`)
        : `💧 水を(${waterPos.x},${waterPos.y},${waterPos.z})に設置しました。指定したマグマはまだ変換されていません（周囲8m内の黒曜石${obsidianNearby}）。`
          + (recovered ? '水はwater_bucketへ回収済み。' : '水源が残っています。空バケツで回収してください。')
          + `水流の届かない溶岩源は、隣の縁から別に水を流してください。`
          + `水源を空バケツで回収してから、diamond_pickaxeでobsidianを採掘してください。`,
    };
  }

  /**
   * マグマの隣の固体ブロックを探し、水を設置するのに最適な面を返す。
   *
   * 優先順位:
   *  1. マグマと同じY、隣の固体ブロックの上にairがある → 上面に水設置（水が横に流れてマグマへ）
   *  2. マグマの上にairがある → その空間の隣の固体ブロックの面に水設置（水が下に流れてマグマへ）
   *  3. マグマの下の固体ブロック → 上面に水設置（水がマグマ位置に出現）
   */
  private findWaterPlacementsForLava(lavaPos: Vec3): Array<{ refBlock: any; faceVec: Vec3 }> {
    const horizontals = [
      new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
      new Vec3(0, 0, 1), new Vec3(0, 0, -1),
    ];
    const out: Array<{ refBlock: any; faceVec: Vec3 }> = [];
    const air = (block: any) => block && (block.name === 'air' || block.name === 'cave_air');

    // Strategy 1: 同じY高さの隣接固体ブロック（上がair）の上面に水設置
    for (const off of horizontals) {
      const edgePos = lavaPos.plus(off);
      const edge = this.bot.blockAt(edgePos);
      if (!edge || edge.boundingBox !== 'block' || edge.name === 'lava') continue;
      if (air(this.bot.blockAt(edgePos.offset(0, 1, 0)))) out.push({ refBlock: edge, faceVec: new Vec3(0, 1, 0) });
    }

    // Strategy 2: マグマの上がair → そのairの隣の固体ブロックの面に水設置
    if (air(this.bot.blockAt(lavaPos.offset(0, 1, 0)))) {
      for (const off of horizontals) {
        const adj = this.bot.blockAt(lavaPos.offset(off.x, 1, off.z));
        if (adj && adj.boundingBox === 'block') out.push({ refBlock: adj, faceVec: new Vec3(-off.x, 0, -off.z) });
      }
    }

    // No pour onto the block under the lava: the water would go into the lava's own cell, replace it (no obsidian there) and stay as
    // a source in the middle of the pool, out of the bucket's reach (a ladder probe, 2026-10-20: the bucket's water lost on the first pour).
    return out;
  }

  /** The first way to pour (in the order above) whose face the server's ray will hit from the eyes as they are now, with the point to aim at. */
  private visibleWaterPlacement(lavaPos: Vec3, from?: Vec3): { refBlock: any; faceVec: Vec3; aim: Vec3 } | null {
    const eyes = from ?? this.bot.entity.position.offset(0, 1.62, 0);
    for (const placement of this.findWaterPlacementsForLava(lavaPos)) {
      for (const aim of facePoints(placement.refBlock.position, placement.faceVec)) {
        // A little inside the 4.5 the server allows: the eyes move as the body settles.
        if (eyes.distanceTo(aim) > 4.3) continue;
        const hit = rayFace(position => this.bot.blockAt(position), eyes, aim);
        if (hit && hit.cell.equals(placement.refBlock.position) && hit.face.equals(placement.faceVec)) return { ...placement, aim };
      }
    }
    return null;
  }

  /**
   * Cells to stand in from which a pour could be seen: solid floor, room for the body, no lava in or beside the feet, within three
   * blocks of where the water would go, at its height or one above; nearest to the body first.
   */
  private waterStands(lavaPos: Vec3): Vec3[] {
    const spots: Vec3[] = [];
    const lava = (at: Vec3) => this.bot.blockAt(at)?.name === 'lava';
    const air = (at: Vec3) => this.bot.blockAt(at)?.boundingBox === 'empty' && !lava(at) && this.bot.blockAt(at)?.name !== 'water';
    for (const placement of this.findWaterPlacementsForLava(lavaPos)) {
      const water = placement.refBlock.position.plus(placement.faceVec);
      for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (const dy of [0, 1]) {
        const feet = water.offset(dx, dy, dz);
        if (feet.equals(water) || !air(feet) || !air(feet.offset(0, 1, 0)) || this.bot.blockAt(feet.offset(0, -1, 0))?.boundingBox !== 'block') continue;
        // On the shore, lava below and beside the floor is the pool itself; only lava at the feet' own height is kept away from.
        if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([x, z]) => lava(feet.offset(x, 0, z)))) continue;
        if (!spots.some(spot => spot.equals(feet))) spots.push(feet);
      }
    }
    const at = this.bot.entity.position;
    return spots.sort((a, b) => a.distanceTo(at) - b.distanceTo(at));
  }

  /** The lava source asked for, then the other sources with air over them within POOL_REACH of it (the same pool, most likely), nearest first. */
  /**
   * Obsidian made from a lava pool and mined, `count` of it, in one call (count ≥ 1): water poured on the pool's top sources, the
   * obsidian that can be taken at once (no lava under or beside it) dug with dig-block-at, the water back in the bucket, the next
   * source. Pours come first while fewer can be taken than are still wanted: they are a second each, the digs nine. A planner asked
   * for each of these steps itself, some twenty decisions for ten obsidian (mb-arch's estimate for run 19: 150 s of them).
   * Ends with the water back in the bucket; stopped short (time, nothing left to pour on, the bucket's water lost), it says how
   * far it got and why.
   */
  private async makeObsidian(start: Vec3, count: number) {
    const items = () => this.bot.inventory.items();
    const held = (name: string) => items().filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
    if (String(this.bot.game?.dimension ?? '').includes('nether')) {
      return { success: false, failureType: 'invalid_input', recoverable: false, result: 'ネザーでは水が蒸発するため、溶岩に水を流して黒曜石を作ることはできません' };
    }
    if (!items().some(item => ['diamond_pickaxe', 'netherite_pickaxe'].includes(item.name))) {
      return { success: false, failureType: 'missing_tool', recoverable: true, result: '黒曜石を掘るには diamond_pickaxe（か netherite_pickaxe）が要ります。先に craft-one diamond_pickaxe を作ってください' };
    }
    if (!held('water_bucket')) return { success: false, failureType: 'material_missing', recoverable: true, result: 'water_bucketを持っていません' };
    const dig = this.bot.instantSkills.getSkill('dig-block-at');
    if (!dig) return { success: false, failureType: 'missing_dependency', recoverable: false, result: 'dig-block-at が見つかりません' };

    const startedAt = Date.now();
    const timeLeft = () => (this.maxDurationMs || 300_000) - 12_000 - (Date.now() - startedAt);
    const before = held('obsidian');
    const want = before + count;
    const key = (at: Vec3) => `${at.x},${at.y},${at.z}`;
    const refusedLava = new Map<string, number>();
    const skippedObsidian = new Set<string>();
    let centre = start.clone();
    // pours: poured on; converted: of those, turned to obsidian; wasted: in a row, not; sincePour: pours since the last dig.
    let pours = 0, converted = 0, wasted = 0, sincePour = 0, digFailures = 0, overLavaDigs = 0, covers = 0;
    let why = '', roomNote = '';
    while (held('obsidian') < want && !this.shouldInterrupt()) {
      if (timeLeft() < 15_000) { why = '1回の行動の時間を使い切る前に区切りました'; break; }
      if (!held('water_bucket')) {
        const water = held('bucket') ? [...this.waterSourcesNear(6).values()].sort((a, b) => a.distanceTo(this.bot.entity.position) - b.distanceTo(this.bot.entity.position))[0] : undefined;
        if (water) {
          const bucket = items().find(item => item.name === 'bucket');
          if (bucket) await this.bot.equip(bucket, 'hand');
          // From where the body is, else from beside the water.
          if (!(await this.scoop(water))) {
            try { await this.walk(new goals.GoalNear(water.x, water.y + 1, water.z, 2), 10_000, timeLeft()); } catch (error) { if (this.shouldInterrupt()) throw error; }
            if (this.bot.heldItem?.name !== 'bucket') { const again = items().find(item => item.name === 'bucket'); if (again) await this.bot.equip(again, 'hand'); }
            await this.scoop(water);
          }
        }
        if (!held('water_bucket')) { why = '水をバケツに汲み直せませんでした（近くの水源を空バケツで汲んでください）'; break; }
      }
      const needed = want - held('obsidian');
      const takeable = this.takeableObsidian(centre, skippedObsidian);
      // Obsidian with a lava cell or two beside it: dig-block-at puts that lava out (a block in its cell) before it breaks it, a second or two
      // each. Taken in place of pouring on when the pours stop making obsidian that can be taken (run 24: 55 pours for 9 obsidian).
      const crushable = takeable.length ? [] : this.takeableObsidian(centre, skippedObsidian, false, true);
      // Pouring ahead of the digging has a limit: a pour is three seconds, a dig nine, but a pool whose pours leave obsidian with lava beside
      // it makes nothing to dig however many are poured.
      const dueToDig = takeable.length >= 1 && sincePour >= POUR_AHEAD;
      const stalled = wasted >= 2 && crushable.length > 0;
      const choice = takeable.length >= needed || dueToDig || stalled ? null : this.pourableLava(centre, refusedLava, needed);
      if (choice) {
        const lava = choice.at;
        if (choice.top === 'covered') {
          // Rock over the source: the cover is dug from beside it, then the water is poured into the opening.
          covers++;
          if (!(await this.openCover(choice, timeLeft))) {
            refusedLava.set(key(lava), (refusedLava.get(key(lava)) ?? 0) + 2);
            if (++wasted >= MAX_WASTED_POURS) { why = `${NO_MORE_LAVA}（覆われた溶岩を掘って開けられませんでした）`; break; }
            continue;
          }
        } else if (lava.distanceTo(this.bot.entity.position) > 4) {
          try { await this.walk(new goals.GoalNear(lava.x, lava.y + 1, lava.z, 3), 15_000, timeLeft()); } catch (error) { if (this.shouldInterrupt()) throw error; }
        }
        const poured: { success?: boolean; converted?: boolean; pouredAt?: Vec3 } = lava.distanceTo(this.bot.entity.position) <= 5 ? await this.placeWaterNearLava(lava) : { success: false };
        pours++; sincePour++;
        if (poured.success) {
          centre = lava;
          // Turned to obsidian: the pour says so; a pour that does not say is judged by the cell.
          const poured_at = poured.pouredAt ?? lava;
          if (poured.converted ?? this.bot.blockAt(poured_at)?.name !== 'lava') { converted++; wasted = 0; } else {
            // Water went on and the lava did not turn: not this source again (the same pour is the same water, 3 s).
            wasted++;
            refusedLava.set(key(poured_at), 2);
          }
        } else { wasted++; refusedLava.set(key(lava), (refusedLava.get(key(lava)) ?? 0) + 1); }
        if (wasted >= MAX_WASTED_POURS) { why = `${NO_MORE_LAVA}（水を${wasted}回続けてかけても黒曜石になりません。水源でない溶岩・流れる溶岩・水が届かない面とみられます）`; break; }
        continue;
      }
      // A pool deeper than one: every piece of its crust lies over lava. dig-block-at keeps such a drop by putting water on the block
      // first (it falls into the opening and turns the lava under it, the next layer, to obsidian too); slow, so three at most.
      // A ladder probe (2026-10-20) poured on five sources of such a pool and came away with none.
      const overLava = !takeable.length && !crushable.length && overLavaDigs < 3 ? this.takeableObsidian(centre, skippedObsidian, true) : [];
      if (overLava.length) overLavaDigs++;
      const target = takeable[0] ?? crushable[0] ?? overLava[0];
      if (!target) { why = NO_MORE_LAVA; break; }
      if (target.offset(0.5, 0.5, 0.5).distanceTo(this.bot.entity.position.offset(0, 1.62, 0)) > 4.2) {
        try { await this.walk(new goals.GoalNear(target.x, target.y + 1, target.z, 2), 12_000, timeLeft()); } catch (error) { if (this.shouldInterrupt()) throw error; }
      }
      // A full pack leaves the obsidian on the floor (ladder probe: five dug, none taken, the call given up).
      roomNote += await this.roomForDrops();
      const got = held('obsidian');
      let dug: { success?: boolean; result?: unknown } = { success: false };
      try { dug = await this.callSkill('dig-block-at', target.x, target.y, target.z, true, 'target'); } catch (error) { if (this.shouldInterrupt()) throw error; }
      if (held('obsidian') <= got && dug.success) {
        try { await this.callSkill('pickup-nearest-item', 'obsidian', 8); } catch (error) { if (this.shouldInterrupt()) throw error; }
      }
      sincePour = 0;
      if (held('obsidian') > got) { digFailures = 0; continue; }
      skippedObsidian.add(key(target));
      if (++digFailures >= 4) { why = `黒曜石の採掘が4回続けて失敗しました（最後: ${String(dug.result ?? '').slice(0, 80)}）`; break; }
    }
    // The bucket is left full: the water last poured is taken back if it was not.
    if (!held('water_bucket') && held('bucket')) {
      const water = [...this.waterSourcesNear(6).values()][0];
      const bucket = items().find(item => item.name === 'bucket');
      if (water && bucket) {
        await this.bot.equip(bucket, 'hand');
        if (!(await this.scoop(water))) {
          try { await this.walk(new goals.GoalNear(water.x, water.y + 1, water.z, 2), 10_000); } catch (error) { if (this.shouldInterrupt()) throw error; }
          const again = items().find(item => item.name === 'bucket');
          if (again) { await this.bot.equip(again, 'hand'); await this.scoop(water); }
        }
      }
    }
    const got = held('obsidian') - before;
    const bucketNote = held('water_bucket') ? '水はwater_bucketへ回収済み' : '⚠️ water_bucketに水が戻っていません（近くの水源を空バケツで汲んでください）';
    const poolNote = `${covers ? `岩の覆いを${covers}か所掘って開けた。` : ''}${pours > converted ? `水をかけて固まったのは${converted}か所。` : ''}`;
    const summary = `黒曜石を${got}個作って掘りました（溶岩${pours}か所に水をかけ、所持 obsidian=${held('obsidian')}個）。${bucketNote}。${poolNote}${roomNote}`;
    if (got >= count) return { success: true, result: summary };
    // Some made: a partial (utils/partialProgress), told with the count; nothing made is a failure of its own kind.
    return {
      success: false, failureType: got > 0 ? PARTIAL_FAILURE : 'target_not_found', recoverable: true,
      result: `${summary}${count}個のうち残り${count - got}個: ${why || '中断されました'}。`
        + (why.startsWith(NO_MORE_LAVA) ? '別の溶岩の溜まりを find-blocks lava で探して、そこで続けてください' : `同じ溜まりで続けるなら use-item-on-block を count=${count - got} でもう一度呼んでください`)
        + (got > 0 ? ` ${progressTrailer('obsidian', got, count)}` : ''),
    };
  }

  /**
   * Two free slots at least before a dig: what tidyPlan names (spare stone, dirt and the like) is thrown away; with nothing it names,
   * the largest stack of plain rock (32 cobblestone kept for walls). Says what went; empty when nothing had to.
   */
  async roomForDrops(): Promise<string> {
    const items = () => this.bot.inventory.items();
    const free = () => typeof (this.bot.inventory as any).emptySlotCount === 'function' ? (this.bot.inventory as any).emptySlotCount() : 36 - items().length;
    if (free() >= 2) return '';
    let plan = tidyPlan(items() as any);
    if (!plan.length) {
      const totals = new Map<string, number>();
      for (const item of items()) if (SPARE_ROCK.includes(item.name)) totals.set(item.name, (totals.get(item.name) ?? 0) + item.count);
      const [name, count] = [...totals].sort((a, b) => b[1] - a[1])[0] ?? [];
      if (name) plan = [{ name, count: name === 'cobblestone' ? count! - 32 : count! }];
    }
    const gone: string[] = [];
    for (const { name, count } of plan.slice(0, 2)) {
      if (count <= 0) continue;
      try {
        const dropped = await this.callSkill('drop-item', name, count);
        if (dropped?.success) gone.push(`${name}×${count}`);
      } catch (error) { if (this.shouldInterrupt()) throw error; }
    }
    return gone.length ? `持ち物の空きを作るため${gone.join('・')}を捨てました。` : '';
  }

  /**
   * Obsidian within 10 blocks of `centre` whose drop does not burn, the nearest to the body first; not the block it stands on. With
   * `overLava`, instead those whose only lava is straight under them (what dig-block-at can keep with water on top).
   */
  takeableObsidian(centre: Vec3, skipped: Set<string>, overLava = false, crushable = false): Vec3[] {
    const feet = this.bot.entity.position.floored().offset(0, -1, 0);
    const found: Vec3[] = this.bot.findBlocks?.({ matching: (block: any) => block?.name === 'obsidian', point: centre, maxDistance: 10, count: 64 }) ?? [];
    const here = this.bot.entity.position;
    return found.filter(at => {
      if (this.bot.blockAt(at)?.name !== 'obsidian' || at.equals(feet) || skipped.has(`${at.x},${at.y},${at.z}`)) return false;
      // With lava over it or beside it (one cell or two), and none in the fall under it: dig-block-at puts that lava out first.
      if (crushable) {
        const around = lavaAroundCount(this.bot as any, at);
        return around >= 1 && around <= MAX_CRUSHED && !lavaBelowDrop(this.bot as any, at);
      }
      const burn = dropBurnsIn(this.bot as any, at);
      return overLava ? !!burn && burn.x === at.x && burn.z === at.z && burn.y === at.y - 1 && this.bot.blockAt(at.offset(0, 1, 0))?.boundingBox === 'empty' : !burn;
    }).sort((a, b) => a.distanceTo(here) - b.distanceTo(here));
  }

  /**
   * The lava source to pour on next, within 12 blocks of `centre` (utils/lavaPools): one with air over it, or with rock over it that can
   * be dug from beside (a source under lava or water, or under a cover no side reaches, is not poured on). The pool as big as `count`
   * needs and the least work to open come first; a source not refused twice.
   */
  pourableLava(centre: Vec3, refused: Map<string, number>, count = 1): LavaSourceInfo | null {
    const found: Vec3[] = this.bot.findBlocks?.({ matching: (block: any) => block?.name === 'lava', point: centre, maxDistance: 12, count: 256 }) ?? [];
    const pools = new Map<string, number>();
    const infos = found.map(at => lavaSourceInfo(this.bot as any, at, pools)).filter((info): info is LavaSourceInfo => info !== null);
    return rankLavaSources(infos, this.bot.entity.position, count, refused)[0] ?? null;
  }

  /**
   * Opens the rock over a lava source: walks to the cell beside it (a tunnel through rock when that is the way), digs the one cell over
   * the source from there, and says whether the source is open now. The dig is held to the rules of every dig (dig-block-at, the lava
   * guard); the cell is chosen so that no lava lies over or beside it (utils/lavaPools).
   */
  private async openCover(info: LavaSourceInfo, timeLeft: () => number): Promise<boolean> {
    const { cap, stand } = info;
    if (!cap || !stand) return false;
    const atStand = () => {
      const p = this.bot.entity.position;
      return Math.abs(p.x - (stand.x + 0.5)) <= 1.2 && Math.abs(p.z - (stand.z + 0.5)) <= 1.2 && Math.abs(p.y - stand.y) < 1.5;
    };
    const capOpen = () => this.bot.blockAt(cap)?.boundingBox === 'empty';
    if (!atStand() && !capOpen()) {
      try { await this.walk(new goals.GoalBlock(stand.x, stand.y, stand.z), 15_000, timeLeft()); } catch (error) { if (this.shouldInterrupt()) throw error; }
    }
    if (capOpen()) return this.bot.blockAt(info.at)?.name === 'lava';
    if (!atStand()) return false;
    // Gravel over the cover comes down into the opening: dug again (twice at most).
    for (let tries = 0; tries < 3 && !this.shouldInterrupt(); tries++) {
      let dug: { success?: boolean } = { success: false };
      try { dug = await this.callSkill('dig-block-at', cap.x, cap.y, cap.z, false); } catch (error) { if (this.shouldInterrupt()) throw error; }
      if (capOpen()) { log.info(`⛏️ 溶岩(${info.at.x},${info.at.y},${info.at.z})の上の岩(${cap.x},${cap.y},${cap.z})を掘って開けた`); return this.bot.blockAt(info.at)?.name === 'lava'; }
      if (!dug.success) return false;
    }
    return false;
  }

  private poolSources(lavaPos: Vec3): Vec3[] {
    // The pool itself: lava cells reached from the one asked for through lava, within POOL_REACH (an unrelated pool nearby is not it).
    const key = (at: Vec3) => `${at.x},${at.y},${at.z}`;
    const seen = new Set<string>([key(lavaPos)]);
    const queue = [lavaPos];
    const out: Vec3[] = [];
    for (let head = 0; head < queue.length && seen.size < 600; head++) {
      const at = queue[head];
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const next = at.offset(dx, dy, dz);
        if (seen.has(key(next)) || Math.abs(next.x - lavaPos.x) > POOL_REACH || Math.abs(next.z - lavaPos.z) > POOL_REACH || Math.abs(next.y - lavaPos.y) > 2) continue;
        seen.add(key(next));
        if (this.bot.blockAt(next)?.name === 'lava') queue.push(next);
      }
      if (at.equals(lavaPos)) continue;
      const block = this.bot.blockAt(at);
      const above = this.bot.blockAt(at.offset(0, 1, 0));
      if (getWaterLevel(block) === 0 && (above?.name === 'air' || above?.name === 'cave_air')) out.push(at);
    }
    // The nearest two dozen are enough to find the shore, and keep the look (rays and stands) to a fraction of a second.
    return [lavaPos, ...out.sort((a, b) => a.distanceTo(lavaPos) - b.distanceTo(lavaPos)).slice(0, 23)];
  }

  /** Water sources (level 0) within `range` of the body, by place. */
  private waterSourcesNear(range: number): Map<string, Vec3> & { find(test: (at: Vec3) => boolean): Vec3 | undefined } {
    const found = new Map<string, Vec3>();
    const centre = this.bot.entity.position.floored();
    for (let dx = -range; dx <= range; dx++) for (let dy = -range; dy <= range; dy++) for (let dz = -range; dz <= range; dz++) {
      const at = centre.offset(dx, dy, dz);
      const block = this.bot.blockAt(at);
      if (block?.name === 'water' && getWaterLevel(block) === 0) found.set(`${at.x},${at.y},${at.z}`, at);
    }
    return Object.assign(found, { find: (test: (at: Vec3) => boolean) => [...found.values()].find(test) });
  }

  /** A water source scooped back into the empty bucket in hand. */
  private async scoop(at: Vec3): Promise<boolean> {
    for (const point of liquidAimPoints(this.bot, at).points.slice(0, 4)) {
      try {
        await activateItemFacing(this.bot, point);
        const deadline = Date.now() + 800;
        while (Date.now() < deadline && this.bot.heldItem?.name !== 'water_bucket') await actionDelay(this.bot, 100);
      } catch { /* the next point */ }
      if (this.bot.heldItem?.name === 'water_bucket') return true;
    }
    return false;
  }
}

export default UseItemOnBlock;
