const { goals } = require('mineflayer-pathfinder');

class GoalDistanceEntity {
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
        const target = this.calcTargetPosition(this.bot.entity.position.x, this.bot.entity.position.z, entity.position.x, entity.position.z, distance);
        // entityの速度を考慮して目標地点を調整
        const entitySpeedX = entity.velocity.x;
        const entitySpeedZ = entity.velocity.z;

        const botSpeed = 2;
        const length = Math.sqrt(Math.pow(target.x - this.bot.entity.position.x, 2) + Math.pow(target.z - this.bot.entity.position.z, 2));
        const timeToReach = length / botSpeed + 0.5;
        const entityPositionX = entity.position.x + entitySpeedX * timeToReach;
        const entityPositionZ = entity.position.z + entitySpeedZ * timeToReach;
        const adjustedTarget = this.calcTargetPosition(this.bot.entity.position.x, this.bot.entity.position.z, entityPositionX, entityPositionZ, distance);
        
        await this.bot.pathfinder.goto(new goals.GoalXZ(adjustedTarget.x, adjustedTarget.z));
        console.log(adjustedTarget);
    }

    calcTargetPosition(botX, botZ, entityX, entityZ, distance) {
        const dx = entityX - botX;
        const dz = entityZ - botZ;
        const length = Math.sqrt(dx * dx + dz * dz);
        const ratio = distance / length;
        return { x: botX + dx * ratio, z: botZ + dz * ratio };
    }
}

module.exports = GoalDistanceEntity;