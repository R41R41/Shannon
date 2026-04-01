import { createLogger } from '../../../utils/logger.js';
import { ConstantSkill, CustomBot } from '../types.js';

const log = createLogger('Minebot:Skill:autoCombatAssess');

/**
 * 戦闘判断 ConstantSkill
 *
 * 1000ms 周期で周囲の敵モブを評価し、不利なら即座に逃走。
 * LLM を使わず、ヒューリスティックで瞬時に判断する（System 1）。
 *
 * 判断基準:
 * - 敵が 2体以上 かつ 8m 以内 → 即逃走
 * - 敵が 1体でも HP < 10 → 即逃走
 * - 武器なし かつ 敵が 6m 以内 → 即逃走
 */
class AutoCombatAssess extends ConstantSkill {
    private readonly DETECT_RADIUS = 12;
    private readonly DANGER_RADIUS = 8;
    private readonly FLEE_RADIUS = 32;
    private lastFleeTime = 0;
    private readonly FLEE_COOLDOWN_MS = 5000;

    private readonly HOSTILE_MOBS = new Set([
        'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'creeper', 'spider',
        'cave_spider', 'enderman', 'witch', 'slime', 'phantom', 'pillager',
        'vindicator', 'evoker', 'ravager', 'piglin_brute', 'warden',
        'zombie_villager', 'zombified_piglin',
    ]);

    private readonly WEAPONS = new Set([
        'netherite_sword', 'diamond_sword', 'iron_sword', 'golden_sword', 'stone_sword', 'wooden_sword',
        'netherite_axe', 'diamond_axe', 'iron_axe', 'golden_axe', 'stone_axe', 'wooden_axe',
    ]);

    constructor(bot: CustomBot) {
        super(bot);
        this.skillName = 'auto-combat-assess';
        this.description = '周囲の敵モブを評価し、不利な状況では即座に逃走する';
        this.interval = 1000;
        this.priority = 10; // autoRunFromHostiles (9) より高い
        this.status = true;
        this.containMovement = true;
        this.isCritical = false;
    }

    async runImpl() {
        // #19 fix: CombatController (combat-engage) が実行中なら干渉しない
        if (this.bot.executingSkill) return;
        // クールダウン中はスキップ
        if (Date.now() - this.lastFleeTime < this.FLEE_COOLDOWN_MS) return;

        // 周囲の敵モブを収集
        const hostiles = Object.values(this.bot.entities).filter(entity => {
            if (!entity || !entity.position || !entity.isValid) return false;
            const name = entity.name?.toLowerCase() ?? '';
            if (!this.HOSTILE_MOBS.has(name)) return false;
            const dist = this.bot.entity.position.distanceTo(entity.position);
            return dist <= this.DETECT_RADIUS;
        });

        if (hostiles.length === 0) return;

        // 近距離の敵数
        const closeHostiles = hostiles.filter(e =>
            this.bot.entity.position.distanceTo(e.position) <= this.DANGER_RADIUS
        );

        // 武器の有無
        const heldItem = this.bot.heldItem;
        const hasWeapon = heldItem ? this.WEAPONS.has(heldItem.name) : false;

        // 判断
        let shouldFlee = false;
        let reason = '';

        if (closeHostiles.length >= 2) {
            shouldFlee = true;
            reason = `${closeHostiles.length}体の敵モブが${this.DANGER_RADIUS}m以内`;
        } else if (this.bot.health < 10 && closeHostiles.length >= 1) {
            shouldFlee = true;
            reason = `HP低下(${this.bot.health}/20) + 敵${closeHostiles.length}体`;
        } else if (!hasWeapon && closeHostiles.length >= 1) {
            const nearest = closeHostiles[0];
            const dist = this.bot.entity.position.distanceTo(nearest.position);
            if (dist <= 6) {
                shouldFlee = true;
                reason = `武器なし + ${nearest.name}が${dist.toFixed(1)}m`;
            }
        }

        if (shouldFlee) {
            this.lastFleeTime = Date.now();
            log.warn(`⚠️ 戦闘判断: 逃走！ (${reason})`);
            try {
                await this.bot.utils.runFromEntities(this.bot, hostiles, this.FLEE_RADIUS);
            } catch {
                // 逃走失敗は無視
            }
        }
    }
}

export default AutoCombatAssess;
