const fs = require('fs');
const InstantSkill = require('./instantSkill.js');

class GetInventoryItems extends InstantSkill {
    /**
     * @param {import('../types.js').CustomBot} bot
     */
    constructor(bot) {
        super(bot);
        this.skillName = "get-inventory-items";
        this.description = "インベントリーのアイテムを取得します";
        this.bot = bot;
        this.params = []
        this.canUseByCommand = false;
    }

    async run() {
        try {
            const items = this.bot.inventory.items();
            const path = require('path');
            const filePath = path.join(process.cwd(), 'saves', 'minecraft', 'inventory.txt');
            const itemDescriptions = items.map(item => `name: ${item.name}, count: ${item.count}`).join('\n');
            fs.writeFileSync(filePath, itemDescriptions);
            return { "success": true, "result": `インベントリーのアイテムデータを以下に格納しました: ${filePath}` };
        } catch (error) {
            return { "success": false, "result": `${error.message} in ${error.stack}` };
        }
    }
}

module.exports = GetInventoryItems;