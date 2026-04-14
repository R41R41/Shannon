import {
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { createTracedModel } from '../../llm/utils/langfuse.js';
import { CONFIG } from '../config/MinebotConfig.js';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { SkillParam } from '../types/skillParams.js';
const log = createLogger('Minebot:Skill:investigateTerrain');

/**
 * スキル②: LLMを使って周囲の地形を調査する
 * get-blocks-in-areaスキルを駆使して、コンテクストに応じた調査を行う
 */
class InvestigateTerrain extends InstantSkill {
  skillName = 'investigate-terrain';
  description =
    '周囲の地形をLLMで総合的に調査します。建築・地形分析向け。' +
    '⚠️ 特定ブロックの位置を探すだけなら find-blocks を使うこと（water, chest, furnace 等）。';
  params: SkillParam[] = [
    {
      name: 'context',
      type: 'string' as const,
      description:
        '調査の目的やコンテクスト（例: "家を建てるのに適した平地を探す", "近くに鉱石があるか確認", "この建物の構造を分析", "自分の足場を分析"）',
      required: true,
    },
    {
      name: 'searchRadius',
      type: 'number' as const,
      description: '調査範囲の半径（ブロック数、デフォルト: 10）',
      default: 10,
    },
  ];
  isToolForLLM = false;

  private llm: ChatOpenAI;

  constructor(bot: CustomBot) {
    super(bot);
    // LLMインスタンスを作成
    this.llm = createTracedModel({
      modelName: CONFIG.EXECUTION_MODEL,
      temperature: 0.1,
      apiKey: CONFIG.OPENAI_API_KEY,
    });
  }

  async runImpl(context: string, searchRadius: number = 10) {
    try {
      const botPos = this.bot.entity.position.floor();

      log.info(`🔍 地形調査開始: "${context}" (範囲: ${searchRadius}ブロック)`);

      // LLMに使わせるツールを定義
      const tools = this.createTools(botPos, searchRadius);

      // LLMにツールをバインド
      const llmWithTools = this.llm.bindTools(tools);

      // システムプロンプトを構築
      const systemPrompt = this.buildSystemPrompt(botPos, searchRadius);

      // 会話履歴
      const messages = [
        new SystemMessage(systemPrompt),
        new HumanMessage(context),
      ];

      // LLMとの対話ループ（最大5回のツール呼び出し）
      const maxIterations = 5;
      let iteration = 0;
      let finalResult = '';

      while (iteration < maxIterations) {
        iteration++;

        const response = await llmWithTools.invoke(messages);
        messages.push(response);

        // ツール呼び出しがある場合
        if (response.tool_calls && response.tool_calls.length > 0) {
          // 各ツール呼び出しを実行
          for (const toolCall of response.tool_calls) {
            const toolResult = await this.executeToolCall(
              toolCall.name,
              toolCall.args
            );

            // ツール実行結果をメッセージに追加
            messages.push(
              new ToolMessage({
                content: JSON.stringify(toolResult),
                tool_call_id: toolCall.id || 'unknown',
              })
            );
          }
        } else {
          // ツール呼び出しがない = 最終回答
          finalResult = response.content.toString();
          log.success(`✅ 調査完了 (${iteration}回のLLM呼び出し)`);
          break;
        }
      }

      if (iteration >= maxIterations) {
        finalResult = 'タイムアウト: 調査に時間がかかりすぎました。';
      }

      return {
        success: true,
        result: finalResult,
      };
    } catch (error: any) {
      log.error('地形調査エラー', error);
      return {
        success: false,
        result: `調査エラー: ${error.message}`,
      };
    }
  }

  /**
   * LLMが使えるツールを定義
   */
  private createTools(botPos: any, searchRadius: number) {
    const minX = botPos.x - searchRadius;
    const maxX = botPos.x + searchRadius;
    const minY = Math.max(botPos.y - searchRadius, -64);
    const maxY = Math.min(botPos.y + searchRadius, 320);
    const minZ = botPos.z - searchRadius;
    const maxZ = botPos.z + searchRadius;

    return [
      {
        type: 'function' as const,
        function: {
          name: 'get_blocks_in_area',
          description:
            '指定した座標範囲内のブロック情報を取得します。建築物の分析、地形調査、資源探索などに使用します。',
          parameters: {
            type: 'object',
            properties: {
              x1: {
                type: 'number',
                description: `始点X座標（調査可能範囲: ${minX}～${maxX}）`,
              },
              y1: {
                type: 'number',
                description: `始点Y座標（調査可能範囲: ${minY}～${maxY}）`,
              },
              z1: {
                type: 'number',
                description: `始点Z座標（調査可能範囲: ${minZ}～${maxZ}）`,
              },
              x2: {
                type: 'number',
                description: `終点X座標（調査可能範囲: ${minX}～${maxX}）`,
              },
              y2: {
                type: 'number',
                description: `終点Y座標（調査可能範囲: ${minY}～${maxY}）`,
              },
              z2: {
                type: 'number',
                description: `終点Z座標（調査可能範囲: ${minZ}～${maxZ}）`,
              },
              format: {
                type: 'string',
                enum: ['layers', 'stats', 'list'],
                description:
                  '出力形式: layers=レイヤー別2D配列（建築分析向き）, stats=統計（資源探索向き）, list=座標リスト（詳細確認向き）',
              },
              includeAir: {
                type: 'boolean',
                description: '空気ブロックを含めるか（通常はfalse推奨）',
              },
            },
            required: ['x1', 'y1', 'z1', 'x2', 'y2', 'z2'],
          },
        },
      },
      {
        type: 'function' as const,
        function: {
          name: 'get_bot_position',
          description: 'ボットの現在位置を取得します',
          parameters: {
            type: 'object',
            properties: {},
          },
        },
      },
      {
        type: 'function' as const,
        function: {
          name: 'find_blocks',
          description: '指定したブロックタイプを周囲から検索します',
          parameters: {
            type: 'object',
            properties: {
              blockName: {
                type: 'string',
                description:
                  '検索するブロック名（例: stone, diamond_ore, oak_log）',
              },
              maxDistance: {
                type: 'number',
                description: '検索範囲（ブロック数）',
              },
              count: {
                type: 'number',
                description: '検索する最大数',
              },
            },
            required: ['blockName'],
          },
        },
      },
    ];
  }

  /**
   * システムプロンプトを構築
   */
  private buildSystemPrompt(botPos: any, searchRadius: number): string {
    return `あなたはMinecraftの地形調査AIです。ボットの周囲の地形を調査して、ユーザーの質問に答えてください。

**現在の状況:**
- ボット位置: (${botPos.x}, ${botPos.y}, ${botPos.z})
- 調査範囲: 半径${searchRadius}ブロック
- 調査可能な座標範囲:
  X: ${botPos.x - searchRadius} ～ ${botPos.x + searchRadius}
  Y: ${Math.max(botPos.y - searchRadius, -64)} ～ ${Math.min(
      botPos.y + searchRadius,
      320
    )}
  Z: ${botPos.z - searchRadius} ～ ${botPos.z + searchRadius}

**利用可能なツール:**
1. get_blocks_in_area: 指定範囲のブロック情報を取得
   - layers形式: 建築物の構造分析、平坦度チェックに最適
   - stats形式: 資源の種類と数を調べるのに最適
   - list形式: 特定ブロックの正確な座標が必要な時に使用

2. get_bot_position: ボットの現在位置を確認

3. find_blocks: 特定のブロックタイプを検索

**調査の進め方:**
1. まず、調査目的に応じて適切な範囲とフォーマットでget_blocks_in_areaを呼び出す
2. 必要に応じて範囲を分割して複数回調査（例: 地面、中層、上層を別々に調査）
3. 得られたデータを分析し、ユーザーの質問に具体的に答える
4. 座標、ブロック数、構造の特徴など、具体的な数値を含めて回答する

**重要な注意事項:**
- 一度に取得する範囲は10x10x10程度に抑える（データ量削減のため）
- 空気ブロックはincludeAir=falseで省略するのが基本
- 建築分析ではlayers形式、資源探索ではstats形式を使う
- 最終回答は日本語で、具体的かつ簡潔に

それでは、ユーザーの調査依頼に応えてください。`;
  }

  /**
   * ツール呼び出しを実行
   */
  private async executeToolCall(toolName: string, args: any): Promise<any> {
    try {
      switch (toolName) {
        case 'get_blocks_in_area': {
          const skill = this.bot.instantSkills.getSkill('get-blocks-in-area');
          if (!skill) {
            return {
              success: false,
              result: 'get-blocks-in-areaスキルが見つかりません',
            };
          }

          const result = await skill.run(
            args.x1,
            args.y1,
            args.z1,
            args.x2,
            args.y2,
            args.z2,
            args.format || 'layers',
            args.includeAir || false
          );

          return result;
        }

        case 'get_bot_position': {
          const pos = this.bot.entity.position;
          return {
            success: true,
            result: {
              x: Math.floor(pos.x),
              y: Math.floor(pos.y),
              z: Math.floor(pos.z),
            },
          };
        }

        case 'find_blocks': {
          const skill = this.bot.instantSkills.getSkill('find-blocks');
          if (!skill) {
            return {
              success: false,
              result: 'find-blocksスキルが見つかりません',
            };
          }

          const result = await skill.run(
            args.blockName,
            args.maxDistance || 64,
            args.count || 10
          );

          return result;
        }

        default:
          return { success: false, result: `不明なツール: ${toolName}` };
      }
    } catch (error: any) {
      return { success: false, result: `ツール実行エラー: ${error.message}` };
    }
  }
}

export default InvestigateTerrain;
