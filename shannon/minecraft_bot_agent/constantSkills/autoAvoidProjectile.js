const ConstantSkill = require("./constantSkill.js");

class AutoAvoidProjectile extends ConstantSkill {
    constructor(bot){
        super(bot);
        this.skillName = "autoAvoidProjectile";
        this.description = "自動で投擲物を避ける";
        this.interval = null;
    }

    async run(projectile){
        const distance = this.bot.entity.position.distanceTo(projectile.position)
        // 距離が10以内の投擲物を検知
        if (distance < 10) {
            const futurePosition = projectile.position.clone().add(projectile.velocity.clone().scale(distance / projectile.velocity.norm()))
            // 自分に当たるかどうかを判定
            if (this.isColliding(futurePosition)) {
                this.lock();
                try{
                    console.log(`avoidProjectile`);
                    const avoidanceDirection = futurePosition.minus(this.bot.entity.position).normalize().scale(-2)
                    const newPosition = this.bot.entity.position.plus(avoidanceDirection)
                    this.bot.lookAt(newPosition, true)
                    this.bot.setControlState('jump', true)
                    this.bot.setControlState('forward', true)
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    this.bot.setControlState('jump', false)
                    this.bot.setControlState('forward', false)
                } finally {
                    this.unlock();
                }
            }
        }
    }

    isColliding(futurePosition) {
        const botPosition = this.bot.entity.position;
        const dx = Math.abs(botPosition.x - futurePosition.x);
        const dy = Math.abs(botPosition.y + 1 - futurePosition.y);
        const dz = Math.abs(botPosition.z - futurePosition.z);
        return dx < 0.5 && dy < 1 && dz < 0.5;
    }
}

module.exports = AutoAvoidProjectile;