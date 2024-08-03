const InstantSkill = require('./instantSkill.js');

class DisplayInventory extends InstantSkill {
    /**
     * @param {import('../types.js').CustomBot} bot
     */
    constructor(bot) {
        super(bot);
        this.skillName = "display-inventory";
        this.description = "インベントリを表示します。";
        this.priority = 10;
        this.params = [];
    }

    async run() {
        try {
            const inventoryItems = await this.bot.inventory.items();
            inventoryItems.sort((a, b) => a.name.localeCompare(b.name));
            inventoryItems.forEach(async item => {
                const message = JSON.stringify({
                    text: `${item.name} ${item.count}`,
                        color: 'gray',
                    underlined: true,
                    hoverEvent: {
                        action: 'show_text',
                        contents: `throw ${item.name}`
                    },
                    clickEvent: {
                        action: "suggest_command",
                            value: `./throw-item ${item.name}`
                    }
                },);
                await this.bot.chat(`/tellraw @a ${message}`);
            });
            return {"success": true, "result": "インベントリを表示しました"};
        } catch (error) {
            return {"success": false, "result": `${error.message} in ${error.stack}`};
        }
    }
}

module.exports = DisplayInventory;