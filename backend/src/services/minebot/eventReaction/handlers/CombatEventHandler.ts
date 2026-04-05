/**
 * CombatEventHandler
 * 敵対Mob接近・ダメージ・窒息イベントの検知とメッセージ構築
 */

import { CustomBot } from '../../types.js';
import { normalizeHostileDetection } from '../eventReactionSettingsStore.js';
import {
    DamageEventData,
    EventData,
    HostileDetectionConfig,
    HostileEntry,
    HostileEventData,
    SuffocationEventData,
    ThreatLevel,
} from '../types.js';
import { isLikelyHostileMobName } from '../../utils/hostileMobHints.js';

export class CombatEventHandler {
    private bot: CustomBot;
    trackedHostiles: Set<number> = new Set();

    /** 近接危険距離・検知範囲など（eventReactionSettings.json で永続化） */
    private detection: HostileDetectionConfig = normalizeHostileDetection(undefined);

    constructor(bot: CustomBot) {
        this.bot = bot;
    }

    getHostileDetection(): HostileDetectionConfig {
        return { ...this.detection };
    }

    applyHostileDetection(partial?: Partial<HostileDetectionConfig>): void {
        this.detection = normalizeHostileDetection(
            partial ? { ...this.detection, ...partial } : undefined
        );
    }

    /** 敵対Mob接近をチェック */
    checkHostileApproach(): HostileEventData | null {
        const nearbyHostiles: { entity: any; distance: number }[] = [];

        Object.values(this.bot.entities).forEach(entity => {
            if (entity.id === this.bot.entity.id) return;

            const mobName = String((entity as any).name || '').toLowerCase();
            if (!isLikelyHostileMobName(mobName)) return;

            const distance = this.bot.entity.position.distanceTo(entity.position);
            if (distance <= this.detection.detectionDistance) {
                nearbyHostiles.push({ entity, distance });
            }
        });

        const newHostiles = nearbyHostiles.filter(h => !this.trackedHostiles.has(h.entity.id));

        let result: HostileEventData | null = null;

        if (newHostiles.length > 0) {
            // 距離昇順ソート
            nearbyHostiles.sort((a, b) => a.distance - b.distance);
            const nearest = nearbyHostiles[0];

            const allHostiles: HostileEntry[] = nearbyHostiles.map(h => ({
                mobType: String((h.entity as any).name || 'unknown'),
                position: {
                    x: Math.floor(h.entity.position.x),
                    y: Math.floor(h.entity.position.y),
                    z: Math.floor(h.entity.position.z),
                },
                distance: Math.round(h.distance * 10) / 10,
            }));

            const threatLevel = this.assessThreatLevel(nearbyHostiles);

            result = {
                timestamp: Date.now(),
                eventType: 'hostile_approach',
                threatLevel,
                mobType: String((nearest.entity as any).name || 'unknown'),
                mobPosition: {
                    x: nearest.entity.position.x,
                    y: nearest.entity.position.y,
                    z: nearest.entity.position.z,
                },
                distance: nearest.distance,
                mobCount: nearbyHostiles.length,
                allHostiles,
            };
        }

        // トラッキングを更新
        this.trackedHostiles.clear();
        nearbyHostiles.forEach(h => this.trackedHostiles.add(h.entity.id));

        return result;
    }

    /**
     * 脅威レベルを算出する。
     *   critical: 8ブロック以内に1体以上 or 16ブロック以内に2体以上
     *   warning : 8-16ブロックに1体
     *   notice  : それ以外（現状の検知範囲では到達しないがフォールバック用）
     */
    private assessThreatLevel(hostiles: { entity: any; distance: number }[]): ThreatLevel {
        const closeCount = hostiles.filter(h => h.distance <= this.detection.criticalDistance).length;

        if (closeCount >= 1) return 'critical';
        if (hostiles.length >= this.detection.multiMobCriticalCount) return 'critical';
        if (hostiles.length >= 1) return 'warning';
        return 'notice';
    }

    /**
     * 現在の全敵対 Mob の位置を返す（逃走方向の再計算用）。
     * EventReactionSystem の継続逃走から呼ばれる。
     */
    scanCurrentHostiles(): HostileEntry[] {
        const result: HostileEntry[] = [];
        if (!this.bot.entity) return result;

        for (const entity of Object.values(this.bot.entities)) {
            if (entity.id === this.bot.entity.id) continue;
            const mobName = String((entity as any).name || '').toLowerCase();
            if (!isLikelyHostileMobName(mobName)) continue;

            const distance = this.bot.entity.position.distanceTo(entity.position);
            if (distance <= this.detection.detectionDistance) {
                result.push({
                    mobType: mobName,
                    position: {
                        x: Math.floor(entity.position.x),
                        y: Math.floor(entity.position.y),
                        z: Math.floor(entity.position.z),
                    },
                    distance: Math.round(distance * 10) / 10,
                });
            }
        }
        return result.sort((a, b) => a.distance - b.distance);
    }

    // ── メッセージ構築 ──

    static buildEmergencyMessage(eventData: EventData): string | null {
        switch (eventData.eventType) {
            case 'damage': {
                const dmg = eventData as DamageEventData;
                const hpInfo = `ダメージ（-${dmg.damage.toFixed(1)}HP、残り${dmg.currentHealth.toFixed(1)}/20）`;
                const hasAttacker = dmg.possibleSource && dmg.possibleSource !== 'unknown';
                if (hasAttacker) {
                    // 敵による攻撃 → 逃走最優先、行動制限厳格
                    return `緊急: ${hpInfo}。攻撃元: ${dmg.possibleSource}。【制約】即時生存行動のみ: (1)食料があれば食べる (2)敵から全力で逃走する (3)安全な場所で待機。クラフト・採掘・建築・農業は禁止。`;
                }
                // 落下・溺水・環境ダメージ → 制約を緩和し、食料確保を許可
                return `緊急: ${hpInfo}。環境ダメージ（落下・溺水等）。【行動指針】(1)食料があれば食べる (2)食料がなければプレイヤーに「食料がないので助けてください」とチャットで伝える (3)周囲に動物がいれば狩って食料を確保する (4)安全な場所で待機する。大規模なクラフト・採掘・建築は禁止。`;
            }
            case 'suffocation': {
                const suff = eventData as SuffocationEventData;
                return `窒息中（酸素:${suff.oxygen}/300）。すぐに脱出して`;
            }
            default:
                return null;
        }
    }

    static buildTaskMessage(eventData: EventData): string | null {
        switch (eventData.eventType) {
            case 'hostile_approach': {
                const ha = eventData as HostileEventData;
                const mobSummary = ha.allHostiles.length > 1
                    ? ha.allHostiles.map(h => `${h.mobType}(${h.distance}m)`).join(', ')
                    : `${ha.mobType}(${ha.distance.toFixed(1)}m)`;
                return `敵対Mob接近: ${mobSummary}。距離を取って警戒（攻撃・迎撃は不要。flee-from や移動で様子見）`;
            }
            case 'damage': {
                const dmg = eventData as DamageEventData;
                return `ダメージを受けた（-${dmg.damage.toFixed(1)}HP）。状況を確認して`;
            }
            default:
                return null;
        }
    }
}
