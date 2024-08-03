const ConstantSkill = require("./constantSkill.js");

class AutoRunFromHostiles extends ConstantSkill{
    /**
     * @param {import('../types.js').CustomBot} bot
     */
    constructor(bot) {
        super(bot);
        this.skillName = "autoRunFromHostiles";
        this.description = "自動で敵モブから逃げる";
        this.interval = 1000;
        this.distance = 16;
        this.radius = 8;
        this.runIfFatal = true;
    }

    async run() {
        const hostiles = Object.values(this.bot.entities).filter(entity => entity.type === 'hostile' && this.bot.entity.position.distanceTo(entity.position) <= this.distance);
        if (this.runIfFatal && this.bot.health > 2) return;
        if (hostiles.length > 0){
            await this.bot.utils.runFromEntities(this.bot, hostiles, this.radius);
        }
    }
}

module.exports = AutoRunFromHostiles;