/**
 * PlayerEventHandler
 * プレイヤー接近・発言イベントの検知とメッセージ構築
 */

import { CustomBot } from '../../types.js';
import { EventData, PlayerEventData } from '../types.js';

export class PlayerEventHandler {
    private bot: CustomBot;

    constructor(bot: CustomBot) {
        this.bot = bot;
    }

    /** プレイヤーがボットの方を向いているかチェック */
    checkPlayerFacing(playerEntity: any): boolean {
        if (!playerEntity || !playerEntity.yaw) return false;

        const botPos = this.bot.entity.position;
        const playerPos = playerEntity.position;

        const dx = botPos.x - playerPos.x;
        const dz = botPos.z - playerPos.z;
        const targetYaw = Math.atan2(-dx, dz);

        const yawDiff = Math.abs(playerEntity.yaw - targetYaw);
        const normalizedDiff = Math.min(yawDiff, 2 * Math.PI - yawDiff);

        // 45度以内ならボットの方を向いている
        return normalizedDiff < Math.PI / 4;
    }

    /** プレイヤー接近イベントデータを作成 */
    buildPlayerFacingEvent(playerEntity: any): PlayerEventData | null {
        if (!playerEntity) return null;

        const distance = this.bot.entity.position.distanceTo(playerEntity.position);
        if (distance > 3) return null; // 3ブロック以内のみ

        if (!this.checkPlayerFacing(playerEntity)) return null;

        return {
            timestamp: Date.now(),
            eventType: 'player_facing',
            playerName: playerEntity.username || 'unknown',
            playerPosition: {
                x: playerEntity.position.x,
                y: playerEntity.position.y,
                z: playerEntity.position.z,
            },
            distance,
            isFacingBot: true,
        };
    }

    /** プレイヤー発言イベントデータを作成 */
    buildPlayerSpeakEvent(playerName: string, message: string, playerEntity?: any): PlayerEventData {
        const position = playerEntity?.position || this.bot.entity.position;
        const distance = playerEntity
            ? this.bot.entity.position.distanceTo(playerEntity.position)
            : 0;

        return {
            timestamp: Date.now(),
            eventType: 'player_speak',
            playerName,
            playerPosition: {
                x: position.x,
                y: position.y,
                z: position.z,
            },
            distance,
            message,
        };
    }

    // ── メッセージ構築 ──

    static buildTaskMessage(eventData: EventData): string | null {
        switch (eventData.eventType) {
            case 'player_facing': {
                const pf = eventData as PlayerEventData;
                return `${pf.playerName}が近くに来た。挨拶して`;
            }
            case 'player_speak': {
                const ps = eventData as PlayerEventData;
                return `${ps.playerName}「${ps.message}」`;
            }
            default:
                return null;
        }
    }
}
