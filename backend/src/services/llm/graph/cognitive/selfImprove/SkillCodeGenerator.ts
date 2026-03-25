/**
 * SkillCodeGenerator — LLM によるスキル TypeScript コード生成
 *
 * SkillIdeation を受け取り、完全な InstantSkill / ConstantSkill の
 * TypeScript ソースコードを生成する。
 */

import { z } from 'zod';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { createTracedModel } from '../../../utils/langfuse.js';
import { createLogger } from '../../../../../utils/logger.js';
import type { SkillIdeation } from './types.js';

const log = createLogger('SelfImprove:CodeGen');

// ── Zod Schema ──

const GeneratedCodeSchema = z.object({
    code: z.string().describe('完全な TypeScript ソースコード'),
    explanation: z.string().describe('コードの説明（日本語、1-2文）'),
});

// ── テンプレート ──

const INSTANT_SKILL_TEMPLATE = `\`\`\`typescript
import { CustomBot, InstantSkill } from '../../types.js';

class ExampleSkill extends InstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'example-skill';
    this.description = 'スキルの説明';
    this.params = [
      { name: 'param1', type: 'string', description: '説明', required: true },
    ];
  }

  async runImpl(param1: string) {
    try {
      // 他のスキルを呼び出す例:
      // const moveTo = this.bot.instantSkills.getSkill('move-to');
      // const result = await moveTo!.run(x, y, z);

      return { success: true, result: '完了' };
    } catch (error: any) {
      return {
        success: false,
        result: error.message,
        failureType: 'skill_error',
        recoverable: true,
      };
    }
  }
}

export default ExampleSkill;
\`\`\``;

const CONSTANT_SKILL_TEMPLATE = `\`\`\`typescript
import { ConstantSkill, CustomBot } from '../../types.js';

class ExampleConstantSkill extends ConstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'example-constant-skill';
    this.description = 'バックグラウンドで定期実行するスキル';
    this.interval = 1000;  // 実行間隔 (ms)
    this.priority = 5;     // 優先度
    this.status = true;    // デフォルト有効
    this.containMovement = false;
  }

  async runImpl() {
    // 定期的に実行されるロジック
    // this.bot.entity.position で位置を取得
    // this.bot.inventory.items() でインベントリを取得
  }
}

export default ExampleConstantSkill;
\`\`\``;

const SYSTEM_PROMPT = `あなたは Minecraft ボット「シャノン」のスキルコードを書くTypeScriptエキスパートです。

スキル仕様を受け取り、完全に動作する TypeScript コードを生成してください。

## 重要ルール
1. import は以下のみ使用可能:
   - \`import { CustomBot, InstantSkill } from '../../types.js';\` (InstantSkill の場合)
   - \`import { ConstantSkill, CustomBot } from '../../types.js';\` (ConstantSkill の場合)
   - \`import minecraftData from 'minecraft-data';\` (Minecraft データが必要な場合)
   - \`import { Vec3 } from 'vec3';\` (座標操作が必要な場合)
2. \`export default ClassName;\` で終わること
3. エラーハンドリングを含めること
4. 他のスキルを呼び出す場合は \`this.bot.instantSkills.getSkill('skill-name')\` を使う
5. 200行以内に収めること
6. eval, child_process, fs, process.env は使用禁止

## InstantSkill テンプレート
${INSTANT_SKILL_TEMPLATE}

## ConstantSkill テンプレート
${CONSTANT_SKILL_TEMPLATE}

## 利用可能な bot API
- \`this.bot.entity.position\` — ボットの座標 (Vec3)
- \`this.bot.inventory.items()\` — インベントリ内アイテム一覧
- \`this.bot.heldItem\` — 手持ちアイテム
- \`this.bot.blockAt(pos)\` — 指定座標のブロック
- \`this.bot.findBlocks({matching, maxDistance, count})\` — ブロック検索
- \`this.bot.equip(item, 'hand')\` — アイテム装備
- \`this.bot.dig(block)\` — ブロック掘削
- \`this.bot.placeBlock(referenceBlock, faceVector)\` — ブロック設置
- \`this.bot.instantSkills.getSkill(name)\` — 他のスキル取得
- \`this.bot.selfState\` — ボット状態 (health, food 等)
- \`Object.values(this.bot.entities)\` — 周辺エンティティ`;

export class SkillCodeGenerator {
    /**
     * SkillIdeation からスキルコードを生成する。
     */
    async generate(ideation: SkillIdeation): Promise<{ code: string; type: 'instant' | 'constant' } | null> {
        try {
            const model = createTracedModel({
                modelName: 'gpt-4.1-mini',
                temperature: 0.2,
            });

            const structuredLLM = model.withStructuredOutput(GeneratedCodeSchema, {
                name: 'SkillCodeGeneration',
            });

            const prompt = this.buildPrompt(ideation);

            const response = await structuredLLM.invoke([
                new SystemMessage(SYSTEM_PROMPT),
                new HumanMessage(prompt),
            ]);

            // コードブロックから TypeScript を抽出
            let code = response.code;
            const tsMatch = code.match(/```typescript\n([\s\S]*?)```/);
            if (tsMatch) {
                code = tsMatch[1];
            }
            // 先頭/末尾の余分なバッククォートを除去
            code = code.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();

            log.info(`💡 コード生成完了: ${ideation.name} (${code.split('\n').length}行)`);

            return {
                code,
                type: ideation.type,
            };
        } catch (err) {
            log.error('コード生成エラー', err);
            return null;
        }
    }

    private buildPrompt(ideation: SkillIdeation): string {
        const lines: string[] = [
            `## スキル仕様\n`,
            `- 種別: ${ideation.type === 'instant' ? 'InstantSkill' : 'ConstantSkill'}`,
            `- 名前: ${ideation.name}`,
            `- 説明: ${ideation.description}`,
            `- 理由: ${ideation.rationale}`,
        ];

        if (ideation.params && ideation.params.length > 0) {
            lines.push(`\n### パラメータ`);
            for (const p of ideation.params) {
                lines.push(`- ${p.name} (${p.type}${p.required ? ', 必須' : ''}): ${p.description}`);
            }
        }

        if (ideation.abstractedSequence) {
            lines.push(`\n### 抽象化元のツール列`);
            lines.push(ideation.abstractedSequence.join(' → '));
        }

        if (ideation.type === 'constant') {
            if (ideation.suggestedInterval) {
                lines.push(`- interval: ${ideation.suggestedInterval}ms`);
            }
            if (ideation.suggestedPriority) {
                lines.push(`- priority: ${ideation.suggestedPriority}`);
            }
            if (ideation.triggerCondition) {
                lines.push(`- 発動条件: ${ideation.triggerCondition}`);
            }
        }

        lines.push(`\n上記の仕様に基づいて、完全に動作する TypeScript コードを生成してください。`);

        return lines.join('\n');
    }
}
