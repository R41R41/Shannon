const InstantSkill = require('./instantSkill.js');
const fs = require('fs');

class GetEquippedArmors extends InstantSkill {
    /**
     * @param {import('../types.js').CustomBot} bot
     */
    constructor(bot) {
        super(bot);
        this.skillName = "get-equipped-armors";
        this.description = "装備中の防具を取得します。";
        this.params = [];
        this.canUseByCommand = false;
    }

    async run() {
        try {
            const equippedArmors = {};
            const armorSlots = ["head", "torso", "legs", "feet"];
            for (const slot of armorSlots) {
                const item = this.bot.inventory.slots[this.bot.getEquipmentDestSlot(slot)];
                if (item) {
                    equippedArmors[slot] = item.name;
                } else {
                    equippedArmors[slot] = null;
                }
            }
            const path = require('path');
            const filePath = path.join(process.cwd(), 'saves', 'minecraft', 'equipped_armors.txt');
            const armorDescriptions = armorSlots.map(slot => `${slot}: ${equippedArmors[slot]}`).join('\n');
            fs.writeFileSync(filePath, armorDescriptions);
            return { "success": true, "result": `装備中の防具データを以下に格納しました: ${filePath}` };
        } catch (e) {
            return { "success": false, "result": `${e.message} in ${e.stack}` };
        }
    }
}

module.exports = GetEquippedArmors;
