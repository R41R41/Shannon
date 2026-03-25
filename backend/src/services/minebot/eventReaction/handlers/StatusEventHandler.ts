/**
 * StatusEventHandler
 * インベントリ変化・アイテム取得イベントの検知とメッセージ構築
 */

import { CustomBot } from '../../types.js';
import { EventData, ItemEventData } from '../types.js';

export class StatusEventHandler {
    private bot: CustomBot;
    lastInventory: Map<string, number> = new Map();

    constructor(bot: CustomBot) {
        this.bot = bot;
    }

    /** インベントリのスナップショットを更新 */
    updateInventorySnapshot(): void {
        this.lastInventory.clear();
        this.bot.inventory.items().forEach(item => {
            const current = this.lastInventory.get(item.name) || 0;
            this.lastInventory.set(item.name, current + item.count);
        });
    }

    /** インベントリ変化をチェック（増加したアイテムのイベントデータを返す） */
    checkInventoryChange(): ItemEventData[] {
        const newInventory = new Map<string, number>();
        this.bot.inventory.items().forEach(item => {
            const current = newInventory.get(item.name) || 0;
            newInventory.set(item.name, current + item.count);
        });

        const events: ItemEventData[] = [];

        for (const [itemName, newCount] of newInventory) {
            const oldCount = this.lastInventory.get(itemName) || 0;
            if (newCount > oldCount) {
                const gained = newCount - oldCount;

                const nearbyPlayers: string[] = [];
                const nearbyEntities: string[] = [];

                Object.values(this.bot.entities).forEach(entity => {
                    const distance = this.bot.entity.position.distanceTo(entity.position);
                    if (distance <= 10 && entity.id !== this.bot.entity.id) {
                        if (entity.type === 'player') {
                            nearbyPlayers.push(entity.username || 'unknown');
                        } else {
                            const entityName = (entity as any).name || entity.type || 'unknown';
                            nearbyEntities.push(String(entityName));
                        }
                    }
                });

                events.push({
                    timestamp: Date.now(),
                    eventType: 'item_obtained',
                    itemName,
                    count: gained,
                    source: 'unknown',
                    nearbyPlayers,
                    nearbyEntities,
                });
            }
        }

        this.lastInventory = newInventory;
        return events;
    }

    // ── メッセージ構築 ──

    static buildTaskMessage(eventData: EventData): string | null {
        if (eventData.eventType !== 'item_obtained') return null;

        const io = eventData as ItemEventData;
        if (io.nearbyPlayers && io.nearbyPlayers.length > 0) {
            const giver = io.nearbyPlayers[0];
            return `${giver}から${io.itemName}を${io.count}個もらった。お礼を言って、何に使えばいいか聞いて。ただし食べ物でお腹が空いていたら食べていい`;
        }
        return `${io.itemName}を${io.count}個入手した`;
    }
}
