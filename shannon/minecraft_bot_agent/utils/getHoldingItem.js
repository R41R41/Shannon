class GetHoldingItem {
    /**
     * @param {import('../types').CustomBot} bot
     */
    constructor(bot) {
        this.bot = bot;
    }

    /**
     * @param {import('../types').Hand} hand
     */
    async run(hand) {
        try{
            const holdingItem = this.bot.inventory.slots[this.bot.getEquipmentDestSlot(hand)];
            if (!holdingItem) {
                return { "success": true, "result": "no item" };
            }
            return { "success": true, "result": holdingItem.name };
        } catch (e) {
            return { "success": false, "result": `${e.message} in ${e.stack}` };
        }
    }
}

module.exports = GetHoldingItem;