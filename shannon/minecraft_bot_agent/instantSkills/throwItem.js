const InstantSkill = require('./instantSkill.js');

class ThrowItem extends InstantSkill {
    constructor(bot) {
        super(bot);
        this.skillName = "throw-item";
        this.description = "特定のアイテムをまとめて捨てる";
        this.priority = 50;
        this.params = [
            {
                "name": "itemName",
                "type": "string",
                "description": "投げるアイテムの名前を指定します。",
                "default": null
            }
        ]
    }

    /**
     * @param {string} itemName
     */
    async run(itemName) {
        try{
            console.log("throwItem", itemName);
            const item = this.bot.inventory.items().find(item => item.name === itemName);
            if (item) {
                await this.bot.tossStack(item);
                return {"success": true, "result": "アイテムを投げました"};
            } else {
                this.bot.chat("インベントリにそのアイテムはありません");
                return {"success": false, "result": "インベントリにそのアイテムはありません"};
            }
        } catch (error) {
            return {"success": false, "result": `${error.message} in ${error.stack}`};
        }
    }
}

module.exports = ThrowItem;