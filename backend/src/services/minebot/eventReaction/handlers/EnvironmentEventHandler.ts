/**
 * EnvironmentEventHandler
 * 環境変化（時間・天気・バイオーム・テレポート）の検知とメッセージ構築
 */

import { CustomBot } from '../../types.js';
import prismarineBiome from 'prismarine-biome';
import * as prismarineRegistry from 'prismarine-registry';
import { BIOME_NAMES_JA, RARE_BIOMES, COMMON_BIOMES } from '../data/biomeNames.js';
import {
    BiomeEventData,
    EventData,
    TeleportEventData,
    TimeEventData,
    WeatherEventData,
} from '../types.js';

export type TimeOfDay = 'day' | 'noon' | 'evening' | 'night';
export type Weather = 'clear' | 'rain' | 'thunder';

export class EnvironmentEventHandler {
    private bot: CustomBot;

    // 状態追跡
    lastTime: TimeOfDay = 'day';
    lastWeather: Weather = 'clear';
    lastBiome: string = '';
    lastPosition: { x: number; y: number; z: number } | null = null;

    constructor(bot: CustomBot) {
        this.bot = bot;
    }

    /** 初期状態を記録 */
    updateInitialState(): void {
        if (!this.bot.entity) return;

        this.lastTime = this.getCurrentTimeOfDay();
        this.lastWeather = this.getCurrentWeather();

        try {
            const rawBiome = (this.bot as any).world?.getBiome?.(this.bot.entity.position);
            this.lastBiome = this.resolveBiomeName(rawBiome);
        } catch {
            this.lastBiome = '';
        }

        const pos = this.bot.entity.position;
        this.lastPosition = { x: pos.x, y: pos.y, z: pos.z };
    }

    /** 現在の時間帯を取得 */
    getCurrentTimeOfDay(): TimeOfDay {
        const time = this.bot.time.timeOfDay;
        if (time >= 0 && time < 6000) return 'day';
        if (time >= 6000 && time < 12000) return 'noon';
        if (time >= 12000 && time < 13000) return 'evening';
        return 'night';
    }

    /** 現在の天気を取得 */
    getCurrentWeather(): Weather {
        const bot = this.bot as any;
        if (bot.thunderState > 0) return 'thunder';
        if (bot.rainState > 0 || bot.isRaining) return 'rain';
        return 'clear';
    }

    /** バイオーム名を解決 */
    resolveBiomeName(rawBiome: any): string {
        if (typeof rawBiome === 'object' && rawBiome?.name) {
            return String(rawBiome.name);
        }
        const biomeId = Number(rawBiome);
        if (!isNaN(biomeId)) {
            try {
                const registry = prismarineRegistry.default(this.bot.version);
                const Biome = prismarineBiome(registry);
                const biome = new Biome(biomeId);
                if (biome.name) return biome.name;
            } catch { /* fallback */ }
        }
        return String(rawBiome || '');
    }

    /** バイオームの日本語名を取得 */
    getBiomeJaName(englishName: string): string {
        const key = englishName.replace(/^minecraft:/, '').toLowerCase();
        return BIOME_NAMES_JA[key] || key.replace(/_/g, ' ');
    }

    // ── チェック関数（EventData を返す。変化がなければ null） ──

    checkTimeChange(): TimeEventData | null {
        const currentTime = this.getCurrentTimeOfDay();
        if (currentTime !== this.lastTime) {
            const eventData: TimeEventData = {
                timestamp: Date.now(),
                eventType: 'time_change',
                previousTime: this.lastTime,
                currentTime,
                tickTime: this.bot.time.timeOfDay,
            };
            this.lastTime = currentTime;
            return eventData;
        }
        return null;
    }

    checkWeatherChange(): WeatherEventData | null {
        const currentWeather = this.getCurrentWeather();
        if (currentWeather !== this.lastWeather) {
            const eventData: WeatherEventData = {
                timestamp: Date.now(),
                eventType: 'weather_change',
                previousWeather: this.lastWeather,
                currentWeather,
            };
            this.lastWeather = currentWeather;
            return eventData;
        }
        return null;
    }

    checkBiomeChange(): BiomeEventData | null {
        let rawBiome: any;
        try {
            rawBiome = (this.bot as any).world?.getBiome?.(this.bot.entity.position);
        } catch {
            return null;
        }
        const biomeName = this.resolveBiomeName(rawBiome);
        if (!biomeName) return null;

        if (biomeName !== this.lastBiome) {
            const previousBiome = this.lastBiome;
            this.lastBiome = biomeName;

            if (COMMON_BIOMES.has(biomeName.toLowerCase())) {
                return null;
            }

            const jaName = this.getBiomeJaName(biomeName);
            return {
                timestamp: Date.now(),
                eventType: 'biome_change',
                previousBiome: this.getBiomeJaName(previousBiome),
                currentBiome: jaName,
                isRare: RARE_BIOMES.has(biomeName.toLowerCase()),
            };
        }
        return null;
    }

    checkTeleport(): TeleportEventData | null {
        const pos = this.bot.entity.position;
        const current = { x: pos.x, y: pos.y, z: pos.z };

        if (this.lastPosition) {
            const dx = current.x - this.lastPosition.x;
            const dy = current.y - this.lastPosition.y;
            const dz = current.z - this.lastPosition.z;
            const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

            if (distance > 50) {
                const eventData: TeleportEventData = {
                    timestamp: Date.now(),
                    eventType: 'teleported',
                    previousPosition: this.lastPosition,
                    currentPosition: current,
                    distance,
                };
                this.lastPosition = current;
                return eventData;
            }
        }

        this.lastPosition = current;
        return null;
    }

    // ── メッセージ構築 ──

    static buildTaskMessage(eventData: EventData): string | null {
        switch (eventData.eventType) {
            case 'time_change': {
                const tc = eventData as TimeEventData;
                const timeNames = { day: '朝', noon: '昼', evening: '夕方', night: '夜' };
                return `${timeNames[tc.currentTime]}になった`;
            }
            case 'weather_change': {
                const wc = eventData as WeatherEventData;
                const weatherNames = { clear: '晴れ', rain: '雨', thunder: '雷雨' };
                return `天気が${weatherNames[wc.currentWeather]}に変わった`;
            }
            case 'biome_change': {
                const bc = eventData as BiomeEventData;
                if (bc.isRare) {
                    return `「${bc.currentBiome}」に入った！珍しい場所だ。周りを見回して、何か面白いものがあれば感想を言って`;
                }
                return `「${bc.currentBiome}」に入った。周りを見回して、何か印象的なものがあれば一言感想を言って`;
            }
            case 'teleported': {
                const tp = eventData as TeleportEventData;
                return `テレポートされた（${tp.distance.toFixed(0)}ブロック移動）。周囲を確認して`;
            }
            default:
                return null;
        }
    }
}
