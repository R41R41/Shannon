import pathfinder from 'mineflayer-pathfinder';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { gotoSafe } from '../utils/gotoSafe.js';

const { goals } = pathfinder;
const log = createLogger('Minebot:Skill:tradeWithVillager');

/**
 * エンティティのカスタム名を取得するヘルパー
 * metadata[2] にOptional<Text Component>が入っている
 */
function getCustomName(entity: any): string | null {
  try {
    const meta = entity.metadata;
    if (!meta) return null;
    const customName = meta[2];
    if (!customName) return null;

    // JSON Text Component の場合
    if (typeof customName === 'object') {
      // { text: "...", extra: [...] } 形式
      if (customName.text) return customName.text;
      // { translate: "..." } 形式
      if (customName.translate) return customName.translate;
      // toString で取得
      return JSON.stringify(customName);
    }
    // 文字列の場合
    if (typeof customName === 'string') {
      // JSON文字列の可能性
      try {
        const parsed = JSON.parse(customName);
        if (parsed.text) return parsed.text;
        if (parsed.extra) {
          return parsed.extra
            .map((e: any) => (typeof e === 'string' ? e : e.text || ''))
            .join('');
        }
        return customName;
      } catch {
        return customName;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 原子的スキル: 村人と取引する
 * Mysterious Traderなどのカスタム名付き村人にも対応
 */
class TradeWithVillager extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'trade-with-villager';
    this.description =
      '指定された村人を探して条件に合う取引を行います。villagerNameで名前検索、listOnly=trueで取引一覧表示も可能。';
    this.params = [
      {
        name: 'inputItemName',
        description:
          '取引で渡すアイテム名（listOnly=trueの場合は省略可）',
        type: 'string',
        required: false,
      },
      {
        name: 'inputItemCount',
        description:
          '取引で渡すアイテムの個数（省略時はもらうアイテムの個数優先）',
        type: 'number',
        required: false,
      },
      {
        name: 'outputItemName',
        description:
          '取引でもらうアイテム名（listOnly=trueの場合は省略可）',
        type: 'string',
        required: false,
      },
      {
        name: 'outputItemCount',
        description: 'もらうアイテムの個数（省略時は渡すアイテムの個数優先）',
        type: 'number',
        required: false,
      },
      {
        name: 'profession',
        description:
          '村人の職業（例: farmer, weaponsmith, nitwit など）。villagerNameやvillagerIdを指定する場合は省略可',
        type: 'string',
        required: false,
      },
      {
        name: 'villagerId',
        description:
          '村人のエンティティID（list-nearby-entitiesで取得可能）。指定すると他の検索条件よりも優先',
        type: 'number',
        required: false,
      },
      {
        name: 'villagerName',
        description:
          '村人のカスタム名で検索（例: "Mysterious Trader"）。部分一致で検索',
        type: 'string',
        required: false,
      },
      {
        name: 'listOnly',
        description:
          'trueにすると取引を実行せず、利用可能な取引一覧だけを表示する',
        type: 'boolean',
        required: false,
      },
    ];
  }

  async runImpl(
    inputItemName: string | undefined,
    inputItemCount: number | undefined,
    outputItemName: string | undefined,
    outputItemCount: number | undefined,
    profession: string | undefined,
    villagerId: number | undefined,
    villagerName: string | undefined,
    listOnly: boolean | undefined
  ) {
    try {
      const isListOnly = listOnly === true;

      // バリデーション（取引実行時のみ）
      if (!isListOnly) {
        if (!inputItemName || !outputItemName) {
          return {
            success: false,
            result:
              'inputItemNameとoutputItemNameを指定してください。取引一覧を見るにはlistOnly=trueを使ってください。',
          };
        }
        if (
          (inputItemCount === undefined || inputItemCount === null) &&
          (outputItemCount === undefined || outputItemCount === null)
        ) {
          return {
            success: false,
            result:
              '渡すアイテムの個数またはもらうアイテムの個数のいずれかを指定してください。',
          };
        }
      }

      // 検索条件チェック
      if (!profession && villagerId === undefined && !villagerName) {
        return {
          success: false,
          result:
            'profession, villagerId, villagerName のいずれかを指定してください。',
        };
      }

      const myPos = this.bot.entity.position;
      let villagers: any[] = [];

      // villagerIdが指定されている場合は直接その村人を使用
      if (villagerId !== undefined) {
        const villager = this.bot.entities[villagerId];
        if (!villager) {
          return {
            success: false,
            result: `ID:${villagerId}のエンティティが見つかりません。`,
          };
        }
        if (villager.name !== 'villager') {
          return {
            success: false,
            result: `ID:${villagerId}は村人ではありません（${villager.name}）。`,
          };
        }
        villagers = [villager];
      } else if (villagerName) {
        // カスタム名で検索
        const searchName = villagerName.toLowerCase();
        villagers = Object.values(this.bot.entities).filter((e: any) => {
          if (e.name !== 'villager') return false;
          if (myPos.distanceTo(e.position) > 64) return false;
          const customName = getCustomName(e);
          if (!customName) return false;
          return customName.toLowerCase().includes(searchName);
        });

        if (villagers.length === 0) {
          return {
            success: false,
            result: `「${villagerName}」という名前の村人が周囲64ブロック以内にいません。Mysterious Traderは一定時間で消えるため、いない場合は出現を待つ必要があります。`,
          };
        }

        // 近い順にソート
        villagers.sort(
          (a: any, b: any) =>
            myPos.distanceTo(a.position) - myPos.distanceTo(b.position)
        );
      } else {
        // professionで検索
        const professionMap = [
          'none',
          'armorer',
          'butcher',
          'cartographer',
          'cleric',
          'farmer',
          'fisherman',
          'fletcher',
          'leatherworker',
          'librarian',
          'mason',
          'nitwit',
          'shepherd',
          'toolsmith',
          'weaponsmith',
        ];

        villagers = Object.values(this.bot.entities).filter((e: any) => {
          if (e.name !== 'villager') return false;
          if (myPos.distanceTo(e.position) > 64) return false;
          const professionId = e.metadata?.[18]?.villagerProfession ?? 0;
          const professionName = professionMap[professionId] || 'none';
          return professionName === profession;
        });

        if (villagers.length === 0) {
          return {
            success: false,
            result: `指定職業（${profession}）の村人が周囲64ブロック以内にいません。`,
          };
        }

        // 近い順にソート
        villagers.sort(
          (a: any, b: any) =>
            myPos.distanceTo(a.position) - myPos.distanceTo(b.position)
        );
      }

      for (const villager of villagers) {
        try {
          // 近づく
          const distance = myPos.distanceTo(villager.position);
          if (distance > 3) {
            const goal = new goals.GoalNear(
              villager.position.x,
              villager.position.y,
              villager.position.z,
              2
            );
            await gotoSafe(this.bot, goal, { timeoutMs: 10_000 });
          }

          // 取引UIを開く
          const window = (await this.bot.openVillager(villager)) as any;
          if (!window || !window.trades) {
            window?.close && window.close();
            continue;
          }

          const vName = getCustomName(villager) || 'villager';

          // 取引一覧表示モード
          if (isListOnly) {
            const tradeList = window.trades.map((trade: any, idx: number) => {
              const input1 = `${trade.inputItem1.name} x${trade.inputItem1.count}`;
              const input2 = trade.inputItem2
                ? ` + ${trade.inputItem2.name} x${trade.inputItem2.count}`
                : '';
              const output = `${trade.outputItem.name} x${trade.outputItem.count}`;
              const disabled = trade.disabled ? ' [売切]' : '';
              return `  ${idx + 1}. ${input1}${input2} → ${output}${disabled}`;
            });

            window.close && window.close();
            return {
              success: true,
              result: `${vName} の取引一覧（${window.trades.length}件）:\n${tradeList.join('\n')}`,
            };
          }

          // 取引条件に合うスロットを探す
          for (let i = 0; i < window.trades.length; i++) {
            const trade = window.trades[i];
            if (trade.disabled) continue;

            if (
              trade.outputItem &&
              trade.outputItem.name.includes(outputItemName!) &&
              trade.inputItem1 &&
              trade.inputItem1.name.includes(inputItemName!)
            ) {
              // 取引レート取得
              const rateInput1 = trade.inputItem1.count;
              const rateInput2 = trade.inputItem2
                ? trade.inputItem2.count
                : 0;
              const rateOutput = trade.outputItem.count;

              // インベントリ所持数
              const invCount1 = this.bot.inventory
                .items()
                .filter((item) => item.name === trade.inputItem1.name)
                .reduce((acc, item) => acc + item.count, 0);
              const invCount2 = trade.inputItem2
                ? this.bot.inventory
                    .items()
                    .filter((item) => item.name === trade.inputItem2.name)
                    .reduce((acc, item) => acc + item.count, 0)
                : 0;

              // 取引回数計算
              let maxByInput = Infinity;
              let maxByOutput = Infinity;

              if (inputItemCount !== undefined && inputItemCount !== null) {
                maxByInput = Math.floor(inputItemCount / rateInput1);
              } else {
                maxByInput = Math.floor(invCount1 / rateInput1);
              }
              if (outputItemCount !== undefined && outputItemCount !== null) {
                maxByOutput = Math.floor(outputItemCount / rateOutput);
              }

              let tradeTimes = Math.min(maxByInput, maxByOutput);
              if (
                inputItemCount !== undefined &&
                outputItemCount === undefined
              )
                tradeTimes = maxByInput;
              if (
                outputItemCount !== undefined &&
                inputItemCount === undefined
              )
                tradeTimes = maxByOutput;

              // インベントリ実際所持数で制限
              tradeTimes = Math.min(
                tradeTimes,
                Math.floor(invCount1 / rateInput1)
              );
              if (trade.inputItem2) {
                tradeTimes = Math.min(
                  tradeTimes,
                  Math.floor(invCount2 / rateInput2)
                );
              }

              if (tradeTimes <= 0) {
                window.close && window.close();
                return {
                  success: false,
                  result: `取引に必要なアイテムが足りません。必要: ${trade.inputItem1.name} x${rateInput1}（所持: ${invCount1}個）`,
                };
              }

              // 取引実行
              for (let t = 0; t < tradeTimes; t++) {
                if (this.shouldInterrupt()) {
                  window.close && window.close();
                  return {
                    success: t > 0,
                    result: t > 0
                      ? `中断: ${trade.outputItem.name} x${t * rateOutput}を入手（${t}/${tradeTimes}回取引）`
                      : '取引中に中断されました',
                  };
                }
                await window.trade(i, 1);
                await this.bot.waitForTicks(10);
              }

              window.close && window.close();
              return {
                success: true,
                result: `${vName}との取引成功: ${trade.outputItem.name} x${tradeTimes * rateOutput}を入手（${trade.inputItem1.name} x${tradeTimes * rateInput1}を消費）`,
              };
            }
          }

          window.close && window.close();
        } catch (e: any) {
          log.error(`村人との取引エラー: ${e.message}`, e);
        }
      }

      return {
        success: false,
        result: `条件に合う取引が見つかりませんでした（${inputItemName} → ${outputItemName}）。listOnly=trueで取引一覧を確認してください。`,
      };
    } catch (error: any) {
      return { success: false, result: `取引中にエラー: ${error.message}` };
    }
  }
}

export default TradeWithVillager;
