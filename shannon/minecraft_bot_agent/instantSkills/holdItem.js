const InstantSkill = require('./instantSkill.js');

class HoldItem extends InstantSkill {
    /**
     * @param {import('../types.js').CustomBot} bot
     */
    constructor(bot) {
        super(bot);
        this.skillName = "hold-item";
        this.description = "インベントリの中から指定したアイテムを手に持ちます。";
        this.params = [
            {
                "name": "itemName",
                "type": "string",
                "description": "手に持つアイテムの名前",
                "default": "null"
            },
            {
                "name": "hand",
                "type": "string",
                "description": "手の位置",
                "default": "hand"
            }
        ];
    }

    /**
     * @param {string} itemName
     * @param {string} hand
     */
    async run(itemName, hand) {
        console.log("holdItem", itemName, hand);
        try{
            const item = this.bot.inventory.items().find(i => i.name === itemName);
            if (item) {
                await this.bot.equip(item, hand);
                return { "success": true, "result": `${itemName}を手に持ちました。` };
            } else {
                return { "success": false, "result": `${itemName}がインベントリに見つかりません。` };
            }
        } catch (error) {
            return { "success": false, "result": `${error.message} in ${error.stack}` };
        }
    }
}

module.exports = HoldItem;