import minecraftData from 'minecraft-data';
import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';
import { gotoSafe } from '../utils/gotoSafe.js';
import { ensureLineOfSight } from '../utils/blockLineOfSight.js';
import { BED_EXPLODES, bedExplodesHere, isBedName } from '../utils/bedRules.js';
import { actionDelay } from '../execution/observedWait.js';
const { goals } = pathfinder;

class ActivateBlock extends InstantSkill {
  private mcData: any;
  constructor(bot: CustomBot) {
    super(bot);
    this.mcData = minecraftData(this.bot.version);
    this.skillName = 'activate-block';
    this.description =
      '指定したブロックを右クリック（activate）します。クラフトテーブルを使う、ケーキを食べる、レバーやボタンを押すなどの用途に使用します。'
      + 'bed（色は問わない）を右クリックすると、昼でもリスポーン地点がそのベッドに決まります（ネザー・エンドでは爆発するので拒みます）。';
    this.params = [
      {
        name: 'blockName',
        description: '対象ブロック名（例: crafting_table, cake など）。座標を指定しない場合は最も近いものを探します',
        type: 'string',
        required: true,
      },
      {
        name: 'x',
        description: 'X座標（省略可能）',
        type: 'number',
        required: false,
        default: null,
      },
      {
        name: 'y',
        description: 'Y座標（省略可能）',
        type: 'number',
        required: false,
        default: null,
      },
      {
        name: 'z',
        description: 'Z座標（省略可能）',
        type: 'number',
        required: false,
        default: null,
      },
    ];
  }

  async runImpl(blockName: string, x: number | null = null, y: number | null = null, z: number | null = null) {
    // 座標が指定されている場合はVec3に変換
    const blockPosition = (x !== null && y !== null && z !== null) ? new Vec3(x, y, z) : null;
    let targetBlock: ReturnType<CustomBot['blockAt']> | null = null;
    // Any bed answers for a bed, whatever its colour (`bed`, `red_bed`, ...).
    const bed = isBedName(blockName);
    if (bed && bedExplodesHere(this.bot)) return { success: false, result: BED_EXPLODES, failureType: 'bed_explodes', recoverable: true };
    try {
      if (blockPosition) {
        targetBlock = this.bot.blockAt(blockPosition);
        if (!targetBlock || (bed ? !isBedName(targetBlock.name) : targetBlock.name !== blockName)) {
          return {
            success: false,
            result: `指定座標に${blockName}はありません。`,
          };
        }
      } else {
        // 周囲で最も近いblockNameのブロックを探す
        const blockId = this.mcData.blocksByName[blockName]?.id;
        if (!blockId && !bed) {
          return {
            success: false,
            result: `ブロック名 ${blockName} が無効です。`,
          };
        }
        targetBlock = this.bot.findBlock({
          matching: bed ? (block: any) => isBedName(block?.name) : blockId,
          maxDistance: 32,
        });
        if (!targetBlock) {
          return {
            success: false,
            result: `周囲に${blockName}が見つかりません。`,
          };
        }
      }
      // 近づく
      await gotoSafe(this.bot, new goals.GoalNear(
        targetBlock.position.x,
        targetBlock.position.y,
        targetBlock.position.z,
        1,
      ), { timeoutMs: 15_000 });

      if (bed) return await this.useBed(targetBlock);
      await this.bot.activateBlock(targetBlock);
      return { success: true, result: `${blockName}を右クリックしました。` };
    } catch (error: any) {
      if (targetBlock) {
        const los = await ensureLineOfSight(this.bot, targetBlock.position);
        if (!los.clear) {
          const failType = los.dugBlocks?.length ? 'obstruction_cleared' : 'line_of_sight_blocked';
          return { success: false, result: los.message!, failureType: failType, recoverable: true };
        }
      }
      return {
        success: false,
        result: `activateBlock中にエラー: ${error.message}`,
      };
    }
  }

  /**
   * A bed sets the respawn point when it is used, by day too: the server sets the point before it looks at the time,
   * and only then answers that sleep must wait for the night (or for monsters to go). What it says back is read, so the
   * answer is the server's: "Respawn point set" only comes when the point moved, so a bed already holding it says nothing.
   */
  private async useBed(block: NonNullable<ReturnType<CustomBot['blockAt']>>) {
    const heard: string[] = [];
    const onMessage = (message: any) => { const key = String(message?.translate ?? ''); if (key) heard.push(key); };
    this.bot.on('message', onMessage);
    try {
      await this.bot.activateBlock(block);
      for (const deadline = Date.now() + 1500; Date.now() < deadline && !heard.some((key) => key.startsWith('block.minecraft.bed.'));) {
        await actionDelay(this.bot, 100);
      }
    } finally { this.bot.removeListener('message', onMessage); }
    const where = `${block.name}(${block.position.x}, ${block.position.y}, ${block.position.z})`;
    const set = heard.includes('block.minecraft.set_spawn');
    const said = heard.includes('block.minecraft.bed.no_sleep') ? '夜でないので眠りはしません'
      : heard.includes('block.minecraft.bed.not_safe') ? '近くに敵がいて眠れません'
      : heard.includes('block.minecraft.bed.obstructed') ? 'ベッドがふさがっています'
      : heard.includes('block.minecraft.bed.occupied') ? 'ベッドは使用中です'
      : heard.includes('block.minecraft.bed.too_far_away') ? 'ベッドが遠すぎます' : '';
    if ((this.bot as any).isSleeping) return { success: true, result: `${where}で眠りました${set ? '。リスポーン地点もここに決まりました' : ''}（起きるには sleep-in-bed の wakeUp=true）` };
    if (set) return { success: true, result: `リスポーン地点を${where}に決めました${said ? `（${said}）` : ''}` };
    if (heard.includes('block.minecraft.bed.obstructed') || heard.includes('block.minecraft.bed.too_far_away') || heard.includes('block.minecraft.bed.occupied')) {
      return { success: false, result: `${where}を使えませんでした: ${said}`, recoverable: true };
    }
    return { success: true, result: `${where}を右クリックしました${said ? `（${said}）` : ''}。「リスポーン地点を設定しました」の知らせは来ませんでした（すでにこのベッドが地点なら知らせは出ません）` };
  }
}

export default ActivateBlock;
