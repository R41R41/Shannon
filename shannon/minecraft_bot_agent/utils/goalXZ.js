const { goals } = require('mineflayer-pathfinder');

class GoalXZ {
    /**
     * @param {import('../types').CustomBot} bot
     */
    constructor(bot) {
        this.bot = bot;
    }

    /**
     * @param {number} x
     * @param {number} z
     */
    async run(x, z) {
        if (!x || !z) {
            console.error('x, zの位置情報が取得できません:', x, z); // デバッグ情報を追加
            return {"error": true, "result": "x, zの位置情報が取得できません"};
        }
        await this.bot.pathfinder.goto(new goals.GoalXZ(x, z));
    }
}

module.exports = GoalXZ;