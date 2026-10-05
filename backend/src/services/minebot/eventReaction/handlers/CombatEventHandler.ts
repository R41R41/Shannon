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
import { isHostileEntity } from '../../utils/hostileMobHints.js';
import { isExposedTo, threatExposure, type Exposure } from '../../utils/threatExposure.js';
import { engagedWith } from '../../utils/engagement.js';
import { answeredByReflex } from '../../utils/reflexAnswers.js';
import { approachSpeed, secondsToContact, sustainedApproachSpeed } from '../../utils/threatTracker.js';

/**
 * Attackers that already hurt the bot outside the melee critical radius. A
 * witch throws poison/harming potions from about 10 blocks, so waiting for
 * 8m lets the first splash land. Skeleton-family reach (15m) is not listed:
 * it sits against the 16m clearance radius and needs line-of-sight handling.
 */
const RANGED_ATTACK_REACH: Record<string, number> = { witch: 10 };

/**
 * How long the body needs to be safe from something coming at it: a planner's reply (about three seconds),
 * a shelter dug and closed (about four), and a little over. A hostile that will be on the body sooner than
 * this is an emergency now, however far off it still is.
 *
 * The emergency used to begin at a distance: eight blocks for one mob. A zombie covers that in three
 * seconds, which is the planner's reply and nothing else: shelters asked for in an emergency were refused
 * as "too late, it arrives in 0 seconds" (paid runs L70, L72), and what was left was to run. The body sees
 * mobs eighty blocks off and measures how fast each one closes; the time is there to be used.
 */
export const SAFE_LEAD_SECONDS = 9;
/** As far as approach is measured (the threat tracker's range). */
const LEAD_RANGE = 48;
/**
 * A hostile that will be on the body sooner than this is an emergency on the short window's word: there is no
 * time to see whether it keeps coming (a planner's reply is about three seconds). Further off, the approach has to
 * be one the mob has kept up (see sustainedApproachSpeed): a few quick steps and a stop is a mob wandering.
 */
const URGENT_LEAD_SECONDS = 5;
/**
 * A hostile the last emergency ended with in sight is the same threat until it comes this much closer than it
 * was then (or the body is hurt). In paid run L109 the planner settled "nothing within 16 blocks" with zombies at
 * 16.1 to 17.2 m, and the same zombies, still loitering there, raised the next emergency two to twenty seconds
 * after the main task resumed: five emergencies in two minutes (22:24:54 to 22:26:51), every one at full health.
 */
const SETTLED_MARGIN = 3;
/** At half health or less the body does not wait for an approach to prove itself: every hostile counts as before. */
const CANNOT_WAIT_HEALTH = 10;

interface NearbyHostile { entity: any; distance: number; arrivesIn?: number; exposure?: Exposure; unchanged?: boolean }

/**
 * What an emergency over hostile mobs asks for: the end (out of reach of their attacks), and the means there
 * are, chosen by what the attacker does. It used to name one means ("first flee"), and a planner that had
 * learned eleven times over to break the line of sight to a skeleton ran from one in the open until it died
 * (paid run L69): the order outranked the lesson.
 */
export const EMERGENCY_HOSTILE_GUIDANCE_JA = '【目的】相手の攻撃が届かない状態にする。手段は相手で選ぶ: 近づいて殴る相手からは距離を取る（複数なら flee-from の target は hostile）。'
  + '離れても当ててくる相手や、走っても距離が開かない相手には、視線を切る（build-around-self の slit_shelter でその場に囲いを建てる（約2秒、ハーフブロック4個が要る）、dig-shelter で地面に入る、手元のブロックで遮る）。'
  + '安全を確保し、HP・空腹度から必要で安全に食べられる時だけ食べる。長時間のクラフト・資源採掘・建築は禁止。'
  + '攻撃は、下の【実測・戦う場合】で「倒す方が早い」と出ている相手に限る（何も出ていなければ攻撃しない）。'
  + 'その場から動かずに届く相手だけを殴る attack-continuously（holdPosition=true）は別で、囲いの中からでも、追いつかれた時でも使える。'
  + '自分で建てた囲いのそば（観測の builtAround）なら、追いかけて外へ出ず、欠けていれば中央のマスで build-around-self を呼んで塞ぐ。'
  // Sealed in, planners waited for the hostiles outside to leave, 110 seconds at a time: nine to twenty minutes of a
  // 75-minute run (paid runs L101, L102, "the shaft is sealed and my health is full, so I will keep waiting").
  + '囲いや縦穴で相手の視線と通り道を断てたら、それで目的は達成。外に敵が残っていても、敵がいなくなるのを wait-time で待たない（待つ間は何も進まない）。完了を報告して元の作業へ戻る（採掘なら、その場から地下で掘り進められる）。';

export class CombatEventHandler {
    private bot: CustomBot;
    trackedHostiles: Set<number> = new Set();
    private lastThreatLevel: ThreatLevel | null = null;

    /** 近接危険距離・検知範囲など（eventReactionSettings.json で永続化） */
    private detection: HostileDetectionConfig = normalizeHostileDetection(undefined);

    constructor(bot: CustomBot) {
        this.bot = bot;
    }

    /** How far a kind of mob has been measured to hit from (0 for kinds that hit in contact); set by the emergency layer. */
    private reachOf: (mobName: string) => number = () => 0;
    setReachProvider(provider: (mobName: string) => number): void { this.reachOf = provider; }

    /** Hostiles the last emergency ended with in sight: how far each was then, and the body's health then. */
    private settled = new Map<number, { distance: number; health: number }>();

    /** Whether the body is too hurt to wait for a threat to prove itself. */
    private cannotWait(): boolean {
        return (this.bot.health ?? 20) <= CANNOT_WAIT_HEALTH;
    }

    /** Seconds until this hostile is on the body at the rate it has been seen to come; null when it is not coming. */
    private arrivalSeconds(entity: any, distance: number): number | null {
        // By the hostile's own approach, not the body's: walking toward a mob that stands still is not the mob coming.
        try {
            const quick = secondsToContact(distance, approachSpeed(this.bot, entity?.id));
            if (quick === null || quick <= URGENT_LEAD_SECONDS || this.cannotWait()) return quick;
            // With time in hand, the rate it has kept up: a stroll toward the body is as fast as a chase for a few
            // seconds, and then it stops (paid run L109: 9 of 15 emergencies, raised at 12 to 18 m, "6 to 9 seconds").
            return secondsToContact(distance, sustainedApproachSpeed(this.bot, entity?.id));
        } catch { return null; }
    }

    /**
     * An emergency over hostiles has ended with the body safe: the hostiles still in sight are recorded as they
     * are now. Until one of them comes closer by SETTLED_MARGIN, or the body loses health, it is the threat
     * that was just settled, and being there again is not a new one. Within the critical distance (or within
     * the reach of a ranged kind that sees the body) it is an emergency as ever.
     */
    noteThreatsSettled(): void {
        this.settled.clear();
        if (!this.bot.entity) return;
        for (const entity of Object.values(this.bot.entities ?? {})) {
            if (!entity?.position || entity.id === this.bot.entity.id || !isHostileEntity(entity as any, this.bot as any)) continue;
            const distance = this.bot.entity.position.distanceTo(entity.position);
            if (distance > LEAD_RANGE || !isExposedTo(this.bot as any, entity as any)) continue;
            this.settled.set(entity.id, { distance, health: this.bot.health ?? 20 });
        }
    }

    /** Whether this hostile is still the one the last emergency settled: not closer by the margin, the body not hurt since. */
    private unchangedSinceSettled(entity: any, distance: number): boolean {
        const mark = this.settled.get(entity?.id);
        if (!mark) return false;
        if ((this.bot.health ?? 20) < mark.health) return false;
        return distance >= mark.distance - SETTLED_MARGIN;
    }

    /** Exposed hostiles beyond `radius` that will be on the body within the lead it needs, with how far off they are. */
    arrivingBeyond(radius: number): Array<{ mobType: string; distance: number; arrivesIn: number }> {
        if (!this.bot.entity) return [];
        const result: Array<{ mobType: string; distance: number; arrivesIn: number }> = [];
        for (const entity of Object.values(this.bot.entities)) {
            if (!entity || entity.id === this.bot.entity.id || !entity.position) continue;
            const mobType = String((entity as any).name || '').toLowerCase();
            if (!isHostileEntity(entity as any, this.bot as any)) continue;
            const distance = this.bot.entity.position.distanceTo(entity.position);
            if (distance <= radius || distance > LEAD_RANGE) continue;
            const arrivesIn = this.arrivalSeconds(entity, distance);
            if (arrivesIn === null || arrivesIn > SAFE_LEAD_SECONDS || !isExposedTo(this.bot as any, entity as any)) continue;
            result.push({ mobType, distance, arrivesIn });
        }
        return result;
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
        const nearbyHostiles: NearbyHostile[] = [];
        // A settled hostile that is gone (or out of the tracker's range) is forgotten: if it comes back, it is new.
        for (const [id, mark] of this.settled) {
            const entity = (this.bot.entities as any)?.[id];
            if (!entity?.position || !this.bot.entity || this.bot.entity.position.distanceTo(entity.position) > Math.max(LEAD_RANGE, mark.distance)) this.settled.delete(id);
        }

        Object.values(this.bot.entities).forEach(entity => {
            if (entity.id === this.bot.entity.id) return;

            const mobName = String((entity as any).name || '').toLowerCase();
            if (!isHostileEntity(entity as any, this.bot as any)) return;
            // One the planner has gone to fight is not an emergency for being near (see engagement).
            if (engagedWith(this.bot, mobName)) return;

            const distance = this.bot.entity.position.distanceTo(entity.position);
            // Near, or farther off and coming fast enough to be here before the body can be safe.
            const arrivesIn = this.arrivalSeconds(entity, distance);
            // Watched out to where its kind has hit the body from: a ghast shoots from thirty blocks, and one
            // watched only to sixteen was never an emergency until the body was nearly dead (paid runs L77c, L77e).
            // Not for a kind whose attack a reflex answers (a ghast's fireball is struck back): being in its
            // range is then not an emergency, and one for every ghast in sight held the body in place.
            const answered = answeredByReflex(this.bot, mobName);
            const watched = Math.max(this.detection.detectionDistance, answered ? 0 : this.reachOf(mobName));
            if (distance > watched && !(distance <= LEAD_RANGE && arrivesIn !== null && arrivesIn <= SAFE_LEAD_SECONDS)) return;
            // Near is not enough: it has to be able to see the body or get to it. A mob in the
            // next cave, behind rock all round, is heard and left alone (see threatExposure).
            const exposure = threatExposure(this.bot as any, entity as any);
            if (exposure !== 'sealed') {
                nearbyHostiles.push({ entity, distance, exposure,
                    unchanged: this.unchangedSinceSettled(entity, distance), ...(arrivesIn !== null ? { arrivesIn } : {}) });
            }
        });

        const newHostiles = nearbyHostiles.filter(h => !this.trackedHostiles.has(h.entity.id));

        let result: HostileEventData | null = null;

        if (nearbyHostiles.length > 0) {
            // 距離昇順ソート
            nearbyHostiles.sort((a, b) => a.distance - b.distance);
            const nearest = nearbyHostiles[0];

            const threatLevel = this.assessThreatLevel(nearbyHostiles);
            // An already tracked mob may move from warning to critical. Emitting
            // only for new entity IDs loses the emergency transition entirely.
            const escalated = threatLevel === 'critical' && this.lastThreatLevel !== 'critical';
            this.lastThreatLevel = threatLevel;

            // A warning for hostiles that are all the ones the last emergency settled is not news: they are tracked
            // and left alone (a warning task for one was queued in the moment the main task was about to resume, L109).
            const settledOnly = threatLevel !== 'critical' && !this.cannotWait() && nearbyHostiles.every(h => h.unchanged);
            if ((newHostiles.length > 0 || escalated) && !settledOnly) {
                const allHostiles: HostileEntry[] = nearbyHostiles.map(h => ({
                    mobType: String((h.entity as any).name || 'unknown'),
                    position: {
                        x: Math.floor(h.entity.position.x),
                        y: Math.floor(h.entity.position.y),
                        z: Math.floor(h.entity.position.z),
                    },
                    distance: Math.round(h.distance * 10) / 10,
                    ...(h.arrivesIn !== undefined && h.arrivesIn <= SAFE_LEAD_SECONDS ? { arrivesInSeconds: Math.round(h.arrivesIn) } : {}),
                }));

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
        } else {
            this.lastThreatLevel = null;
        }

        // トラッキングを更新
        this.trackedHostiles.clear();
        nearbyHostiles.forEach(h => this.trackedHostiles.add(h.entity.id));

        return result;
    }

    /**
     * 脅威レベルを算出する。
     *   critical: 近接危険距離（8）以内に1体以上、遠隔の相手が視線の通る射程内、到達見込みが SAFE_LEAD_SECONDS 以内、
     *             または「迫っている」敵が検知範囲（16）内に2体以上
     *   warning : 検知範囲内にいるが上のどれでもない
     *   notice  : それ以外（現状の検知範囲では到達しないがフォールバック用）
     *
     * 「迫っている」は、近接危険距離内・接近が続いている・動きを測っていない身体（追跡なし）のいずれか。
     * 測った上で近づいていない敵は、何体いても数えない（L109: 14〜16mで止まっているゾンビ2体で5回の緊急対応）。
     * 直前の緊急対応が安全と結論した時に見えていた敵は、その時より SETTLED_MARGIN 以上近づくか、被弾するまで数えない。
     * 体力が半分以下なら、これらの絞り込みはせず従来どおり数える。
     */
    private assessThreatLevel(hostiles: NearbyHostile[]): ThreatLevel {
        const cannotWait = this.cannotWait();
        const closeCount = hostiles.filter(h => {
            const name = String(h.entity?.name ?? '').toLowerCase();
            if (h.distance <= this.detection.criticalDistance) return true;
            // Within reach of its attack (measured for kinds that have hit from afar) where it can see the body: a
            // bow or a potion needs the line of sight that a skeleton in the next cave, round a corner, does not have.
            const answered = answeredByReflex(this.bot, name);
            const reach = Math.max(RANGED_ATTACK_REACH[name] ?? 0, answered ? 0 : this.reachOf(name));
            if (h.distance <= reach && h.exposure !== 'reachable') return true;
            // On its way and here too soon, unless it is the one just settled and no closer than it was then.
            return h.arrivesIn !== undefined && h.arrivesIn <= SAFE_LEAD_SECONDS && (cannotWait || !h.unchanged);
        }).length;

        if (closeCount >= 1) return 'critical';
        const pressing = cannotWait ? hostiles : hostiles.filter(h => !h.unchanged
            && (h.distance <= this.detection.criticalDistance || !(this.bot as any).threatMotion || h.arrivesIn !== undefined));
        if (pressing.length >= this.detection.multiMobCriticalCount) return 'critical';
        if (hostiles.length >= 1) return 'warning';
        return 'notice';
    }

    /**
     * 現在の全敵対 Mob の位置を返す（逃走方向の再計算用）。
     * EventReactionSystem の継続逃走から呼ばれる。
     */
    scanCurrentHostiles(radius = this.detection.detectionDistance): HostileEntry[] {
        const result: HostileEntry[] = [];
        if (!this.bot.entity) return result;

        for (const entity of Object.values(this.bot.entities)) {
            if (entity.id === this.bot.entity.id) continue;
            const mobName = String((entity as any).name || '').toLowerCase();
            if (!isHostileEntity(entity as any, this.bot as any)) continue;

            const distance = this.bot.entity.position.distanceTo(entity.position);
            // The same rule as detection: only what can see or reach the body. Counting every mob within
            // range kept a body that had sealed itself in a shelter "contained" for as long as anything
            // lived in the caves around it, and its task never resumed (paid run L43, 21 mobs nearby).
            if (distance <= radius && isExposedTo(this.bot as any, entity as any)) {
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
                    return `緊急: ${hpInfo}。攻撃元: ${dmg.possibleSource}。${EMERGENCY_HOSTILE_GUIDANCE_JA}`;
                }
                // No attacker: say what the body can tell is hurting it, and what is wanted, not a list of
                // means. (The old sentence told every such case to eat, to ask a player for food, to hunt or
                // to wait; a burning body waited.)
                return `緊急: ${hpInfo}。攻撃してきた相手は見当たりません。`
                    + `${dmg.harm ?? '何に削られたかは身体からは分かりません（落下のように一度きりのこともある）'}。`
                    + '【目的】体力を削っているものを止める（その場に留まって続くなら、まず離れる）。止まったら、食料があれば食べて回復する。大規模なクラフト・採掘・建築は後回しにする。';
            }
            case 'suffocation': {
                const suff = eventData as SuffocationEventData;
                return `窒息中（酸素:${suff.oxygen ?? '不明'}/20）。水・埋没状態から脱出し、呼吸と周囲の安全を確認して`;
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
