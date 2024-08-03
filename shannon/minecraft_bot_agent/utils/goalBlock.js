const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');

class GoalBlock {
    /**
     * @param {import('../types').CustomBot} bot
     */
    constructor(bot) {
        this.bot = bot;
    }

    /**
     * @param {Vec3} position
     */
    async run(position) {
        await this.bot.pathfinder.goto(new goals.GoalBlock(position.x, position.y, position.z));
    }
}

module.exports = GoalBlock;