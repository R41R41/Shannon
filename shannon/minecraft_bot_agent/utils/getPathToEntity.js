const { goals, Movements } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');

class GetPathToEntity {
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
        const goal = new goals.GoalBlock(position.x, position.y, position.z);
        const defaultMove = new Movements(this.bot);
        defaultMove.allow1by1towers = true;
        defaultMove.canDig = true;
        defaultMove.allowParkour = true;
        defaultMove.allowSprinting = true;
        const path = await this.bot.pathfinder.getPathTo(defaultMove, goal);
        return path;
    }
}

module.exports = GetPathToEntity;