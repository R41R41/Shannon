const ConstantSkill = require("./constantSkill");

class AutoPickUpItem extends ConstantSkill {
    /**
     * @param {import('../types').CustomBot} bot
     */
    constructor(bot) {
        super(bot);
        this.skillName = "autoPickUpItem";
        this.description = "自動でアイテムを拾う";
        this.interval = null;
        /** @type {import('../types').Entity} */
        this.pickUpItemName = null;
    }

    /**
     * @param {import('../types').Entity} entity
     */
    async run(entity) {
        if (entity.displayName === 'Item') {
            let item = null;
            setTimeout(async () => {
                item = entity.getDroppedItem();
                if (this.pickUpItemName) {
                    if (this.pickUpItemName !== item.name) {
                        return;
                    }
                }
                console.log("pickUpItem", item.count, item.name);
                await this.bot.lookAt(entity.position);
                await this.bot.utils.goalFollow.run(entity, 1.5);
                await this.bot.collectBlock.collect(entity);
            }, 100);
        }
    }
}

module.exports = AutoPickUpItem;