import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { CustomBot, InstantSkill } from '../types.js';

class MineBlock extends InstantSkill {
  private mcData: any;

  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'mine-block';
    this.description = '指定した種類のブロックを近くから探し、必要数だけ採掘します。ブロック名はMinecraftの正式ID（例: coal_ore, iron_ore, diamond_ore, oak_log）を使用してください。';
    this.mcData = minecraftData(this.bot.version);
    this.params = [
      {
        name: 'blockName',
        type: 'string',
        description: '採掘するブロック名（Minecraft正式ID: coal_ore, iron_ore, deepslate_iron_ore, diamond_ore, oak_log, stone 等。coalやironではなく_ore付きの正式名を使うこと）',
        required: true,
      },
      {
        name: 'count',
        type: 'number',
        description: '採掘する個数（デフォルト: 1）',
        default: 1,
      },
      {
        name: 'searchRadius',
        type: 'number',
        description: '検索半径（デフォルト: 32）',
        default: 32,
      },
    ];
  }

  async runImpl(blockName: string, count: number = 1, searchRadius: number = 32) {
    const blockType = this.mcData.blocksByName[blockName];
    if (!blockType) {
      const allBlocks = Object.keys(this.mcData.blocksByName);
      const suggestions = allBlocks
        .filter((name: string) => name.includes(blockName.replace('_ore', '').replace('_log', '')))
        .slice(0, 5);
      return {
        success: false,
        result: `ブロック${blockName}が見つかりません${suggestions.length > 0 ? `。正しい名前: ${suggestions.join(', ')}` : ''}。鉱石は coal_ore, iron_ore 等の _ore 付きの名前を使ってください`,
        failureType: 'invalid_block',
        recoverable: false,
      };
    }

    const moveTo = this.bot.instantSkills.getSkill('move-to');
    const digBlockAt = this.bot.instantSkills.getSkill('dig-block-at');
    if (!moveTo || !digBlockAt) {
      return {
        success: false,
        result: '採掘に必要なスキル(move-to / dig-block-at)が見つかりません',
        failureType: 'missing_dependency',
        recoverable: false,
      };
    }

    const targets = this.bot.findBlocks({
      matching: blockType.id,
      maxDistance: searchRadius,
      count: Math.max(1, count),
    });

    if (targets.length === 0) {
      return {
        success: false,
        result: `${searchRadius}ブロック以内に${blockName}が見つかりません`,
        failureType: 'target_not_found',
        recoverable: true,
      };
    }

    // ツルハシの有無を事前チェック（石系ブロック掘削の効率警告）
    const needsPickaxe = ['stone', 'ore', 'cobble', 'deepslate', 'brick', 'obsidian', 'concrete', 'terracotta', 'basalt', 'netherrack']
      .some(keyword => blockName.includes(keyword));
    const hasPickaxe = this.bot.inventory.items().some(item => item.name.includes('pickaxe'));
    let toolWarning = '';
    if (needsPickaxe && !hasPickaxe) {
      toolWarning = ' ⚠️ ツルハシを所持していません。石系ブロックの採掘は非常に遅くなります。先にツルハシをクラフトすることを強く推奨します';
    }

    // 採掘前のインベントリをスナップショット（ドロップアイテム検出用）
    const beforeInventory = new Map<string, number>();
    for (const item of this.bot.inventory.items()) {
      beforeInventory.set(item.name, (beforeInventory.get(item.name) ?? 0) + item.count);
    }

    let mined = 0;
    const failures: string[] = [];
    let lastFailureType: string | undefined;
    let lastRecoverable = false;

    for (const pos of targets) {
      if (mined >= count) break;
      if (this.shouldInterrupt()) break;

      const target = new Vec3(pos.x, pos.y, pos.z);
      const block = this.bot.blockAt(target);
      if (!block || block.name !== blockName) {
        continue;
      }

      const distance = this.bot.entity.position.distanceTo(target);
      if (distance > 4.5) {
        const moveResult = await moveTo.run(target.x, target.y, target.z, 1, 'near');
        if (!moveResult.success) {
          lastFailureType = moveResult.failureType ?? 'movement_failed';
          lastRecoverable = moveResult.recoverable ?? true;
          failures.push(
            `移動失敗(${target.x},${target.y},${target.z}): ${moveResult.failureType ?? moveResult.result}`,
          );
          continue;
        }
      }

      const digResult = await digBlockAt.run(target.x, target.y, target.z, true);
      if (digResult.success) {
        mined += 1;
      } else {
        lastFailureType = digResult.failureType ?? 'dig_failed';
        lastRecoverable = digResult.recoverable ?? true;
        failures.push(
          `採掘失敗(${target.x},${target.y},${target.z}): ${digResult.failureType ?? digResult.result}`,
        );
      }
    }

    if (mined === 0) {
      return {
        success: false,
        result: `${blockName}を採掘できませんでした${failures.length > 0 ? `: ${failures.join(', ')}` : ''}`,
        failureType: lastFailureType ?? 'mine_failed',
        recoverable: lastRecoverable || failures.length === 0,
      };
    }

    // 採掘後のインベントリ差分からドロップアイテムを検出
    const drops = this.detectDrops(beforeInventory);
    const totalDropCount = drops.reduce((sum, d) => sum + d.count, 0);

    // ドロップが0の場合、dig成功でもアイテム未回収 → 失敗として報告
    if (totalDropCount === 0) {
      return {
        success: false,
        result: `${blockName}を${mined}個掘削しましたが、アイテムを回収できませんでした。ドロップが消失した可能性があります（溶岩、高所落下等）${toolWarning}`,
        failureType: 'drops_lost',
        recoverable: true,
      };
    }

    const dropsText = `（ドロップ回収: ${drops.map(d => `${d.item} x${d.count}`).join(', ')}）`;

    // ドロップアイテムの現在所持数を付記（LLMが過剰採掘しないようにする）
    const totalsText = this.formatDropTotals(drops);

    const isPartial = mined < count;
    return {
      success: !isPartial,
      result: isPartial
        ? `${blockName}を${count}個中${mined}個のみ採掘しました${dropsText}${totalsText}。残り${count - mined}個が不足しています。再度 mine-block を実行してください${failures.length > 0 ? `（失敗詳細: ${failures.join(', ')}）` : ''}${toolWarning}`
        : `${blockName}を${mined}個採掘しました${dropsText}${totalsText}${failures.length > 0 ? `（一部失敗: ${failures.join(', ')}）` : ''}${toolWarning}`,
      ...(isPartial && { failureType: 'partial_completion', recoverable: true }),
    };
  }

  /**
   * ドロップアイテムの現在インベントリ所持数をフォーマットする。
   */
  private formatDropTotals(drops: Array<{ item: string; count: number }>): string {
    if (drops.length === 0) return '';
    const currentInventory = new Map<string, number>();
    for (const item of this.bot.inventory.items()) {
      currentInventory.set(item.name, (currentInventory.get(item.name) ?? 0) + item.count);
    }
    const totals = drops
      .map(d => `${d.item}=${currentInventory.get(d.item) ?? 0}個`)
      .join(', ');
    return `（現在の所持数: ${totals}）`;
  }

  /**
   * 採掘前後のインベントリ差分からドロップアイテムを検出する。
   */
  private detectDrops(beforeInventory: Map<string, number>): Array<{ item: string; count: number }> {
    const afterInventory = new Map<string, number>();
    for (const item of this.bot.inventory.items()) {
      afterInventory.set(item.name, (afterInventory.get(item.name) ?? 0) + item.count);
    }

    const drops: Array<{ item: string; count: number }> = [];
    for (const [name, afterCount] of afterInventory) {
      const beforeCount = beforeInventory.get(name) ?? 0;
      if (afterCount > beforeCount) {
        drops.push({ item: name, count: afterCount - beforeCount });
      }
    }
    return drops;
  }
}

export default MineBlock;
