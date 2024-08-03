const InstantSkill = require('./instantSkill.js');
const fs = require('fs');

class GetHoldingItems extends InstantSkill {
    /**
     * @param {import('../types.js').CustomBot} bot
     */
    constructor(bot) {
        super(bot);
        this.skillName = "get-holding-items";
        this.description = "手持ちのアイテムを取得します。";
        this.params = [];
        this.canUseByCommand = false;
    }

    async run() {
        try {
            const itemInHand = await this.bot.utils.getHoldingItem.run("hand");
            const itemInOffHand = await this.bot.utils.getHoldingItem.run("off-hand");
            const path = require('path');
            const filePath = path.join(process.cwd(), 'saves', 'minecraft', 'holding_items.txt');
            const holdingItems = `hand: ${itemInHand.result}\noffhand: ${itemInOffHand.result}`;
            fs.writeFileSync(filePath, holdingItems);
            return { "success": true, "result": `手持ちのアイテムデータを以下に格納しました: ${filePath}` };
        } catch (e) {
            return { "success": false, "result": `${e.message} in ${e.stack}` };
        }
    }
}

module.exports = GetHoldingItems;
