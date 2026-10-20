import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { ensureLineOfSight } from '../utils/blockLineOfSight.js';
import { getWaterLevel } from '../utils/waterLevel.js';
import { createLogger } from '../../../utils/logger.js';
import { activateItemFacing } from '../utils/activateItemFacing.js';
import { actionDelay } from '../execution/observedWait.js';
import pathfinder from 'mineflayer-pathfinder';
import { gotoSafe } from '../utils/gotoSafe.js';
import { liquidAim, liquidAimPoints } from '../utils/liquidAim.js';
import { facePoints, rayFace } from '../utils/rayFace.js';
import { dropBurnsIn } from '../utils/dropFate.js';
import { tidyPlan } from '../utils/inventoryTidy.js';
/** Rock dug on the way that a full pack can spare, for the obsidian (see roomForDrops). */
const SPARE_ROCK = ['cobbled_deepslate', 'tuff', 'diorite', 'andesite', 'granite', 'dirt', 'gravel', 'calcite', 'netherrack', 'cobblestone'];

const { goals } = pathfinder;

const log = createLogger('Minebot:Skill:useItemOnBlock');
/** How far from the lava asked for another source of the same pool is poured on instead, when none of its own faces can be seen. */
const POOL_REACH = 6;

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
      + 'スキル側が自動的にマグマ隣の固体ブロックに水を設置し、水流でマグマを黒曜石に変換します。';
    this.params = [
      {
        name: 'x',
        type: 'number',
        description: 'X座標',
        required: true,
      },
      {
        name: 'y',
        type: 'number',
        description: 'Y座標',
        required: true,
      },
      {
        name: 'z',
        type: 'number',
        description: 'Z座標',
        required: true,
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
        description: 'water_bucket で溶岩を指した時だけ：集める黒曜石の数。2以上なら、その溶岩の溜まりで「水をかける→固まった黒曜石を掘る→水を回収→次の溶岩」を体の中で繰り返し、指定数まで集める（溶岩まで自分で歩く。diamond_pickaxe が要る）。省略時は1か所に水をかけるだけ',
        default: 1,
      },
    ];
    // Ten obsidian made and mined in one call: about twelve pours and ten digs of nine seconds (a ladder probe, 2026-10-20: 216 s).
    this.maxDurationMs = 300_000;
  }

  private liquidAim(pos: Vec3): { point?: Vec3; reason?: string } { return liquidAim(this.bot, pos); }

  async runImpl(x: number, y: number, z: number, itemName?: string, count: number = 1) {
    try {
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        return {
          success: false,
          result: '座標は有効な数値である必要があります',
        };
      }
      const wanted = Math.floor(Number(count) || 1);
      if (wanted >= 2 && (itemName ?? this.bot.heldItem?.name) === 'water_bucket') return await this.makeObsidian(new Vec3(x, y, z), wanted);

      if (itemName) {
        const wanted = this.bot.inventory.items().find(item => item.name === itemName);
        if (!wanted && this.bot.heldItem?.name !== itemName) {
          return { success: false, result: `${itemName}を持っていません`, failureType: 'material_missing', recoverable: true };
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
            try { await gotoSafe(this.bot, new goals.GoalNear(pos.x, pos.y, pos.z, 2), { timeoutMs: 8000 }); } catch { /* judged by the aim below */ }
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
        try { await gotoSafe(this.bot, new goals.GoalBlock(stand.x, stand.y, stand.z), { timeoutMs: 8000 }); } catch { /* judged below */ }
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

    // Strategy 3: マグマ直下の固体ブロックの上面に水設置
    const below = this.bot.blockAt(lavaPos.offset(0, -1, 0));
    if (below && below.boundingBox === 'block' && below.name !== 'lava') out.push({ refBlock: below, faceVec: new Vec3(0, 1, 0) });
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
   * Obsidian made from a lava pool and mined, `count` of it, in one call (count ≥ 2): water poured on the pool's top sources, the
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
    let pours = 0, digFailures = 0;
    let why = '', roomNote = '';
    while (held('obsidian') < want && !this.shouldInterrupt()) {
      if (timeLeft() < 15_000) { why = '1回の行動の時間を使い切る前に区切りました'; break; }
      if (!held('water_bucket')) {
        const water = held('bucket') ? [...this.waterSourcesNear(6).values()].sort((a, b) => a.distanceTo(this.bot.entity.position) - b.distanceTo(this.bot.entity.position))[0] : undefined;
        if (water) {
          const bucket = items().find(item => item.name === 'bucket');
          if (bucket) await this.bot.equip(bucket, 'hand');
          await this.scoop(water);
        }
        if (!held('water_bucket')) { why = '水をバケツに汲み直せませんでした（近くの水源を空バケツで汲んでください）'; break; }
      }
      const needed = want - held('obsidian');
      const takeable = this.takeableObsidian(centre, skippedObsidian);
      const lava = takeable.length >= needed ? null : this.pourableLava(centre, refusedLava);
      if (lava) {
        if (lava.distanceTo(this.bot.entity.position) > 4) {
          try { await gotoSafe(this.bot, new goals.GoalNear(lava.x, lava.y + 1, lava.z, 3), { timeoutMs: 15_000 }); } catch (error) { if (this.shouldInterrupt()) throw error; }
        }
        const poured = lava.distanceTo(this.bot.entity.position) <= 5 ? await this.placeWaterNearLava(lava) : { success: false };
        pours++;
        if (poured.success) centre = lava; else refusedLava.set(key(lava), (refusedLava.get(key(lava)) ?? 0) + 1);
        continue;
      }
      const target = takeable[0];
      if (!target) { why = '近くに水をかけられる溶岩も、すぐ掘れる黒曜石も、もうありません'; break; }
      if (target.offset(0.5, 0.5, 0.5).distanceTo(this.bot.entity.position.offset(0, 1.62, 0)) > 4.2) {
        try { await gotoSafe(this.bot, new goals.GoalNear(target.x, target.y + 1, target.z, 2), { timeoutMs: 12_000 }); } catch (error) { if (this.shouldInterrupt()) throw error; }
      }
      // A full pack leaves the obsidian on the floor (ladder probe: five dug, none taken, the call given up).
      roomNote += await this.roomForDrops();
      const got = held('obsidian');
      let dug: { success?: boolean; result?: unknown } = { success: false };
      try { dug = await this.callSkill('dig-block-at', target.x, target.y, target.z, true, 'target'); } catch (error) { if (this.shouldInterrupt()) throw error; }
      if (held('obsidian') <= got && dug.success) {
        try { await this.callSkill('pickup-nearest-item', 'obsidian', 8); } catch (error) { if (this.shouldInterrupt()) throw error; }
      }
      if (held('obsidian') > got) { digFailures = 0; continue; }
      skippedObsidian.add(key(target));
      if (++digFailures >= 4) { why = `黒曜石の採掘が4回続けて失敗しました（最後: ${String(dug.result ?? '').slice(0, 80)}）`; break; }
    }
    // The bucket is left full: the water last poured is taken back if it was not.
    if (!held('water_bucket') && held('bucket')) {
      const water = [...this.waterSourcesNear(6).values()][0];
      const bucket = items().find(item => item.name === 'bucket');
      if (water && bucket) { await this.bot.equip(bucket, 'hand'); await this.scoop(water); }
    }
    const got = held('obsidian') - before;
    const bucketNote = held('water_bucket') ? '水はwater_bucketへ回収済み' : '⚠️ water_bucketに水が戻っていません（近くの水源を空バケツで汲んでください）';
    const summary = `黒曜石を${got}個作って掘りました（溶岩${pours}か所に水をかけ、所持 obsidian=${held('obsidian')}個）。${bucketNote}。${roomNote}`;
    if (got >= count) return { success: true, result: summary };
    return {
      success: false, failureType: got > 0 ? 'partial_completion' : 'target_not_found', recoverable: true,
      result: `${summary}${count}個のうち残り${count - got}個: ${why || '中断されました'}。`
        + (why.startsWith('近くに') ? '別の溶岩の溜まりを find-blocks lava で探して、そこで続けてください' : `同じ溜まりで続けるなら use-item-on-block を count=${count - got} でもう一度呼んでください`),
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

  /** Obsidian within 10 blocks of `centre` whose drop does not burn, the nearest to the body first; not the block it stands on. */
  takeableObsidian(centre: Vec3, skipped: Set<string>): Vec3[] {
    const feet = this.bot.entity.position.floored().offset(0, -1, 0);
    const found: Vec3[] = this.bot.findBlocks?.({ matching: (block: any) => block?.name === 'obsidian', point: centre, maxDistance: 10, count: 64 }) ?? [];
    const here = this.bot.entity.position;
    return found.filter(at => this.bot.blockAt(at)?.name === 'obsidian' && !at.equals(feet) && !skipped.has(`${at.x},${at.y},${at.z}`)
      && !dropBurnsIn(this.bot as any, at))
      .sort((a, b) => a.distanceTo(here) - b.distanceTo(here));
  }

  /** A lava source within 12 blocks of `centre` with nothing solid over it (the top of the pool), not refused twice, nearest first. */
  pourableLava(centre: Vec3, refused: Map<string, number>): Vec3 | null {
    const found: Vec3[] = this.bot.findBlocks?.({ matching: (block: any) => block?.name === 'lava', point: centre, maxDistance: 12, count: 256 }) ?? [];
    const here = this.bot.entity.position;
    return found.filter(at => {
      const block = this.bot.blockAt(at), over = this.bot.blockAt(at.offset(0, 1, 0));
      return block?.name === 'lava' && getWaterLevel(block) === 0 && over?.boundingBox === 'empty' && !['lava', 'water'].includes(over?.name ?? '')
        && (refused.get(`${at.x},${at.y},${at.z}`) ?? 0) < 2;
    }).sort((a, b) => a.distanceTo(here) - b.distanceTo(here))[0] ?? null;
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
