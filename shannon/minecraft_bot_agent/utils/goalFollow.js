const { goals } = require('mineflayer-pathfinder');

class GoalFollow {
    /**
     * @param {import('../types').CustomBot} bot
     */
    constructor(bot) {
        this.bot = bot;
    }

    /**
     * @param {import('../types').Entity} entity
     * @param {number} distance
     */
    async run(entity, distance) {
        if (!entity || !entity.position) {
            console.error('エンティティの位置情報が取得できません:', entity); // デバッグ情報を追加
            return {"error": true, "result": "エンティティの位置情報が取得できません"};
        }
        const goal = new goals.GoalFollow(entity, distance);
        await this.bot.pathfinder.setGoal(goal, true);
    }
}

module.exports = GoalFollow;

