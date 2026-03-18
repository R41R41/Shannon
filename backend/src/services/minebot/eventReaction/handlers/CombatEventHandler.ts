/**
 * CombatEventHandler
 * 敵対Mob接近・ダメージ・窒息イベントの検知とメッセージ構築
 */

import { CustomBot } from '../../types.js';
import {
    DamageEventData,
    EventData,
    HostileEventData,
    SuffocationEventData,
} from '../types.js';

const HOSTILE_MOBS = [
    'zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch',
    'phantom', 'drowned', 'husk', 'stray', 'blaze', 'ghast',
    'magma_cube', 'slime', 'pillager', 'vindicator', 'evoker',
    'warden', 'piglin_brute', 'hoglin', 'zoglin',
];

export class CombatEventHandler {
    private bot: CustomBot;
    trackedHostiles: Set<number> = new Set();

    constructor(bot: CustomBot) {
        this.bot = bot;
    }

    /** 敵対Mob接近をチェック */
    checkHostileApproach(): HostileEventData | null {
        const nearbyHostiles: { entity: any; distance: number }[] = [];

        Object.values(this.bot.entities).forEach(entity => {
            if (entity.id === this.bot.entity.id) return;

            const mobName = String((entity as any).name || '').toLowerCase();
            if (!HOSTILE_MOBS.some(h => mobName.includes(h))) return;

            const distance = this.bot.entity.position.distanceTo(entity.position);
            if (distance <= 16) {
                nearbyHostiles.push({ entity, distance });
            }
        });

        const newHostiles = nearbyHostiles.filter(h => !this.trackedHostiles.has(h.entity.id));

        let result: HostileEventData | null = null;

        if (newHostiles.length > 0) {
            const nearest = newHostiles.reduce((a, b) => a.distance < b.distance ? a : b);

            result = {
                timestamp: Date.now(),
                eventType: 'hostile_approach',
                mobType: String((nearest.entity as any).name || 'unknown'),
                mobPosition: {
                    x: nearest.entity.position.x,
                    y: nearest.entity.position.y,
                    z: nearest.entity.position.z,
                },
                distance: nearest.distance,
                mobCount: nearbyHostiles.length,
            };
        }

        // トラッキングを更新
        this.trackedHostiles.clear();
        nearbyHostiles.forEach(h => this.trackedHostiles.add(h.entity.id));

        return result;
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
                return `${ha.mobType}が${ha.distance.toFixed(1)}ブロック先にいる。${ha.mobCount > 1 ? `（合計${ha.mobCount}体）` : ''}対処して`;
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
