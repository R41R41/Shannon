const ConstantSkill = require("./constantSkill.js");
const AttackEntity = require("../instantSkills/attackEntity.js");

class AutoAttackHostile extends ConstantSkill{
    /**
     * @param {import('../types.js').CustomBot} bot
     */
    constructor(bot) {
        super(bot);
        this.skillName = "autoAttackHostile";
        this.description = "自動で敵モブを攻撃する";
        this.interval = 1000;
        this.distance = 24;
        this.tool_name = null;
        this.attackEntity = new AttackEntity(this.bot);
    }

    async run() {
        const hostile = this.bot.nearestEntity(entity => entity.type === 'hostile' && this.bot.entity.position.distanceTo(entity.position) <= this.distance);
        if (hostile){
            if (Math.abs(hostile.position.y - this.bot.entity.position.y) > 8){
                return;
            }
            if (this.bot.attackEntity){
                if (hostile.id === this.bot.attackEntity.id) return;
            }
            if (['zombified_piglin', 'enderman'].includes(hostile.name)){
                return;
            }
            this.bot.attackEntity = hostile;
            this.attackEntity.run(1, hostile.name, "null");
            this.bot.attackEntity = null;
        }
    }
}

module.exports = AutoAttackHostile;