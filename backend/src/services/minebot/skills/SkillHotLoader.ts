/**
 * SkillHotLoader — ランタイムスキル登録
 *
 * コンパイル済み .js ファイルを動的にインポートし、
 * InstantSkills/ConstantSkills コレクション・EventBus・LLM ツールに登録する。
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { createLogger } from '../../../utils/logger.js';
import { SkillRegistrar } from './SkillRegistrar.js';
import type { CustomBot, InstantSkill, ConstantSkill } from '../types.js';

const log = createLogger('Minebot:SkillHotLoader');

export interface GeneratedSkillManifestEntry {
    name: string;
    type: 'instant' | 'constant';
    sourceFile: string;
    compiledFile: string;
    createdAt: number;
    creationReason: string;
    enabled: boolean;
    usageCount: number;
    lastUsedAt: number | null;
}

interface GeneratedSkillManifest {
    version: number;
    skills: GeneratedSkillManifestEntry[];
}

const MANIFEST_PATH = 'backend/saves/minecraft/generated_skills_manifest.json';
const MAX_GENERATED_SKILLS = 20;

export class SkillHotLoader {
    private registrar: SkillRegistrar;

    constructor(registrar: SkillRegistrar) {
        this.registrar = registrar;
    }

    /**
     * InstantSkill をホットロードして登録する。
     */
    async loadAndRegisterInstantSkill(
        jsPath: string,
        bot: CustomBot,
        reason: string,
    ): Promise<{ success: boolean; skillName: string | null; error?: string }> {
        try {
            // 生成スキル上限チェック
            const manifest = await this.loadManifest();
            const activeCount = manifest.skills.filter(s => s.enabled).length;
            if (activeCount >= MAX_GENERATED_SKILLS) {
                return {
                    success: false,
                    skillName: null,
                    error: `生成スキル上限 (${MAX_GENERATED_SKILLS}) に到達しています`,
                };
            }

            // 動的インポート（キャッシュバスティング）
            const { default: SkillClass } = await import(jsPath + '?v=' + Date.now());
            const skill = new SkillClass(bot) as InstantSkill;

            // 重複チェック
            if (bot.instantSkills.hasSkill(skill.skillName)) {
                return {
                    success: false,
                    skillName: skill.skillName,
                    error: `スキル "${skill.skillName}" は既に存在します`,
                };
            }

            // コレクションに追加
            bot.instantSkills.addSkill(skill);

            // EventBus に登録
            this.registrar.registerSingleInstantSkill(skill);

            // LLM ツールに登録
            try {
                const { LLMService } = await import('../../llm/client.js');
                const { config } = await import('../../../config/env.js');
                const llmService = LLMService.getInstance(config.isDev);
                await llmService.registerSingleMinebotTool(skill, bot);
            } catch (err) {
                log.warn(`⚠️ LLM ツール登録スキップ: ${(err as Error).message}`);
            }

            // マニフェスト更新
            await this.addToManifest({
                name: skill.skillName,
                type: 'instant',
                sourceFile: jsPath.replace(/\.js.*$/, '.ts'),
                compiledFile: jsPath,
                createdAt: Date.now(),
                creationReason: reason,
                enabled: true,
                usageCount: 0,
                lastUsedAt: null,
            });

            log.info(`✅ InstantSkill ホットロード完了: ${skill.skillName}`);
            return { success: true, skillName: skill.skillName };
        } catch (err) {
            log.error('❌ InstantSkill ホットロード失敗', err);
            return {
                success: false,
                skillName: null,
                error: (err as Error).message,
            };
        }
    }

    /**
     * ConstantSkill をホットロードして登録する。
     */
    async loadAndRegisterConstantSkill(
        jsPath: string,
        bot: CustomBot,
        reason: string,
    ): Promise<{ success: boolean; skillName: string | null; error?: string }> {
        try {
            const manifest = await this.loadManifest();
            const activeCount = manifest.skills.filter(s => s.enabled).length;
            if (activeCount >= MAX_GENERATED_SKILLS) {
                return {
                    success: false,
                    skillName: null,
                    error: `生成スキル上限 (${MAX_GENERATED_SKILLS}) に到達しています`,
                };
            }

            const { default: SkillClass } = await import(jsPath + '?v=' + Date.now());
            const skill = new SkillClass(bot) as ConstantSkill;

            if (bot.constantSkills.hasSkill(skill.skillName)) {
                return {
                    success: false,
                    skillName: skill.skillName,
                    error: `スキル "${skill.skillName}" は既に存在します`,
                };
            }

            bot.constantSkills.addSkill(skill);
            this.registrar.registerSingleConstantSkill(bot, bot.constantSkills, skill);

            await this.addToManifest({
                name: skill.skillName,
                type: 'constant',
                sourceFile: jsPath.replace(/\.js.*$/, '.ts'),
                compiledFile: jsPath,
                createdAt: Date.now(),
                creationReason: reason,
                enabled: true,
                usageCount: 0,
                lastUsedAt: null,
            });

            log.info(`✅ ConstantSkill ホットロード完了: ${skill.skillName}`);
            return { success: true, skillName: skill.skillName };
        } catch (err) {
            log.error('❌ ConstantSkill ホットロード失敗', err);
            return {
                success: false,
                skillName: null,
                error: (err as Error).message,
            };
        }
    }

    /**
     * 生成スキルを無効化する。
     */
    async disableSkill(skillName: string, bot: CustomBot): Promise<boolean> {
        // InstantSkill から削除
        if (bot.instantSkills.hasSkill(skillName)) {
            bot.instantSkills.removeSkill(skillName);
        }
        if (bot.constantSkills.hasSkill(skillName)) {
            this.registrar.detachConstantSkillInterval(bot, skillName);
            bot.constantSkills.removeSkill(skillName);
        }

        // マニフェスト更新
        const manifest = await this.loadManifest();
        const entry = manifest.skills.find(s => s.name === skillName);
        if (entry) {
            entry.enabled = false;
            await this.saveManifest(manifest);
            log.info(`🔒 スキル無効化: ${skillName}`);
            return true;
        }
        return false;
    }

    /**
     * 既存の InstantSkill をランタイムで差し替える（SelfTest 用）。
     */
    async replaceInstantSkill(
        jsPath: string,
        bot: CustomBot,
        skillName: string,
        reason: string,
    ): Promise<{ success: boolean; error?: string }> {
        try {
            // 1. 動的インポート（キャッシュ無効化）
            const mod = await import(jsPath + '?v=' + Date.now());
            const SkillClass = mod.default;
            if (!SkillClass) {
                return { success: false, error: 'default export が見つかりません' };
            }

            const newSkill = new SkillClass(bot) as InstantSkill;

            // 2. スキル名一致チェック
            if (newSkill.skillName !== skillName) {
                return {
                    success: false,
                    error: `スキル名不一致: expected=${skillName}, got=${newSkill.skillName}`,
                };
            }

            // 3. 旧スキルを削除して新スキルを登録
            bot.instantSkills.removeSkill(skillName);
            bot.instantSkills.addSkill(newSkill);

            // 4. EventBus 再登録
            this.registrar.registerSingleInstantSkill(newSkill);

            // 5. LLM ツール再登録（非致命的）
            try {
                const { LLMService } = await import('../../llm/client.js');
                const { config } = await import('../../../config/env.js');
                const llmService = LLMService.getInstance(config.isDev);
                await llmService.registerSingleMinebotTool(newSkill, bot);
            } catch {
                log.warn(`LLM ツール再登録スキップ: ${skillName}`);
            }

            log.info(`🔄 スキル差し替え完了: ${skillName} (${reason})`);
            return { success: true };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    /**
     * 既存の ConstantSkill をコンパイル済み JS で差し替え（SelfTest --fix 用）。
     * SkillRegistrar が古い taskPer リスナを remove してから再登録する。
     */
    async replaceConstantSkill(
        jsPath: string,
        bot: CustomBot,
        skillName: string,
        reason: string,
    ): Promise<{ success: boolean; error?: string }> {
        try {
            const mod = await import(jsPath + '?v=' + Date.now());
            const SkillClass = mod.default;
            if (!SkillClass) {
                return { success: false, error: 'default export が見つかりません' };
            }

            const newSkill = new SkillClass(bot) as ConstantSkill;
            if (newSkill.skillName !== skillName) {
                return {
                    success: false,
                    error: `スキル名不一致: expected=${skillName}, got=${newSkill.skillName}`,
                };
            }

            bot.constantSkills.removeSkill(skillName);
            bot.constantSkills.addSkill(newSkill);
            this.registrar.attachConstantSkillInterval(
                bot,
                bot.constantSkills,
                newSkill.skillName,
                newSkill.interval,
            );

            log.info(`🔄 ConstantSkill 差し替え完了: ${skillName} (${reason})`);
            return { success: true };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    /**
     * スキル使用回数を記録する。
     */
    async recordUsage(skillName: string): Promise<void> {
        try {
            const manifest = await this.loadManifest();
            const entry = manifest.skills.find(s => s.name === skillName);
            if (entry) {
                entry.usageCount++;
                entry.lastUsedAt = Date.now();
                await this.saveManifest(manifest);
            }
        } catch { /* non-critical */ }
    }

    // ── マニフェスト I/O ──

    async loadManifest(): Promise<GeneratedSkillManifest> {
        try {
            const filePath = resolve(process.cwd(), MANIFEST_PATH);
            const content = await readFile(filePath, 'utf-8');
            return JSON.parse(content);
        } catch {
            return { version: 1, skills: [] };
        }
    }

    private async saveManifest(manifest: GeneratedSkillManifest): Promise<void> {
        const filePath = resolve(process.cwd(), MANIFEST_PATH);
        await writeFile(filePath, JSON.stringify(manifest, null, 2), 'utf-8');
    }

    private async addToManifest(entry: GeneratedSkillManifestEntry): Promise<void> {
        const manifest = await this.loadManifest();
        // 既存エントリがあれば更新
        const existingIdx = manifest.skills.findIndex(s => s.name === entry.name);
        if (existingIdx >= 0) {
            manifest.skills[existingIdx] = entry;
        } else {
            manifest.skills.push(entry);
        }
        await this.saveManifest(manifest);
    }
}
