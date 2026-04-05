/**
 * イベント反応設定のディスク永続化（saves/minecraft/eventReactionSettings.json）
 */

import fs from 'fs';
import { createLogger } from '../../../utils/logger.js';
import { CONFIG } from '../config/MinebotConfig.js';
import {
    DEFAULT_HOSTILE_DETECTION,
    DEFAULT_REACTION_CONFIGS,
    EventReactionConfig,
    EventReactionSettingsFile,
    EventType,
    HostileDetectionConfig,
    ReactionType,
} from './types.js';

const log = createLogger('Minebot:EventReactionSettings');

const REACTION_TYPES = new Set<ReactionType>(['immediate', 'task', 'emergency', 'info']);

function clampProbability(n: unknown, fallback: number): number {
    if (typeof n !== 'number' || Number.isNaN(n)) return fallback;
    return Math.max(0, Math.min(100, Math.round(n)));
}

function mergeReactionRow(base: EventReactionConfig, raw: unknown): EventReactionConfig {
    if (!raw || typeof raw !== 'object') return { ...base };
    const s = raw as Record<string, unknown>;
    if (s.eventType !== base.eventType) return { ...base };
    const reactionType =
        typeof s.reactionType === 'string' && REACTION_TYPES.has(s.reactionType as ReactionType)
            ? (s.reactionType as ReactionType)
            : base.reactionType;
    return {
        eventType: base.eventType,
        enabled: typeof s.enabled === 'boolean' ? s.enabled : base.enabled,
        probability: clampProbability(s.probability, base.probability),
        idleOnly: typeof s.idleOnly === 'boolean' ? s.idleOnly : base.idleOnly,
        reactionType,
    };
}

export function normalizeHostileDetection(
    partial: Partial<HostileDetectionConfig> | undefined
): HostileDetectionConfig {
    const d = { ...DEFAULT_HOSTILE_DETECTION };
    if (!partial) return d;

    const crit =
        typeof partial.criticalDistance === 'number' && partial.criticalDistance > 0
            ? Math.min(64, partial.criticalDistance)
            : d.criticalDistance;
    let det =
        typeof partial.detectionDistance === 'number' && partial.detectionDistance > 0
            ? Math.min(128, partial.detectionDistance)
            : d.detectionDistance;
    if (det < crit) det = crit;

    const multi =
        typeof partial.multiMobCriticalCount === 'number' && partial.multiMobCriticalCount >= 1
            ? Math.min(20, Math.floor(partial.multiMobCriticalCount))
            : d.multiMobCriticalCount;

    return {
        criticalDistance: crit,
        detectionDistance: det,
        multiMobCriticalCount: multi,
    };
}

/**
 * ファイルから読み込み。無効・欠損時はデフォルトにフォールバック。
 */
export function loadEventReactionSettingsFile(): {
    reactions: EventReactionConfig[];
    hostileDetection: HostileDetectionConfig;
} {
    const path = CONFIG.EVENT_REACTION_SETTINGS_JSON;
    const defaults = DEFAULT_REACTION_CONFIGS.map(c => ({ ...c }));

    try {
        if (!fs.existsSync(path)) {
            return {
                reactions: defaults,
                hostileDetection: { ...DEFAULT_HOSTILE_DETECTION },
            };
        }
        const raw = JSON.parse(fs.readFileSync(path, 'utf-8')) as EventReactionSettingsFile | unknown;
        const reactionsIn =
            raw && typeof raw === 'object' && Array.isArray((raw as EventReactionSettingsFile).reactions)
                ? (raw as EventReactionSettingsFile).reactions
                : null;

        const byType = new Map<EventType, EventReactionConfig>();
        for (const base of defaults) {
            const savedRow = reactionsIn?.find(
                (r: { eventType?: string }) =>
                    r && typeof r === 'object' && r.eventType === base.eventType
            );
            byType.set(base.eventType, mergeReactionRow(base, savedRow));
        }

        const mergedList = DEFAULT_REACTION_CONFIGS.map(c => byType.get(c.eventType) ?? { ...c });

        const hostileRaw =
            raw && typeof raw === 'object' && (raw as EventReactionSettingsFile).hostileDetection;
        const hostileDetection = normalizeHostileDetection(
            hostileRaw && typeof hostileRaw === 'object'
                ? (hostileRaw as Partial<HostileDetectionConfig>)
                : undefined
        );

        log.success(`✅ Loaded event reaction settings from ${path}`);
        return { reactions: mergedList, hostileDetection };
    } catch (error) {
        log.error('❌ eventReactionSettings.json 読み込み失敗 — デフォルトを使用', error);
        return {
            reactions: defaults,
            hostileDetection: { ...DEFAULT_HOSTILE_DETECTION },
        };
    }
}

export function saveEventReactionSettingsFile(
    reactions: EventReactionConfig[],
    hostileDetection: HostileDetectionConfig
): void {
    const path = CONFIG.EVENT_REACTION_SETTINGS_JSON;
    const payload: EventReactionSettingsFile = {
        version: 1,
        reactions: reactions.map(r => ({ ...r })),
        hostileDetection: normalizeHostileDetection(hostileDetection),
    };
    try {
        fs.writeFileSync(path, JSON.stringify(payload, null, 2));
        log.success(`✅ Saved event reaction settings to ${path}`);
    } catch (error) {
        log.error('❌ eventReactionSettings.json 保存失敗', error);
    }
}
