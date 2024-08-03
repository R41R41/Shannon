const InstantSkill = require('./instantSkill.js');

class EquipArmor extends InstantSkill {
    /**
     * @param {import('../types.js').CustomBot} bot
     */
    constructor(bot) {
        super(bot);
        // Please make sure the skill-name part is in kebab-case
        this.skillName = "equip-armor";
        this.description = "指定された防具を装備します。";
        this.params = [
            {
                "name": "armorType",
                "type": "string",
                "description": "装備する防具の種類（例：helmet, chestplate, leggings, boots）, またはnullで全ての防具を脱ぎます。",
                "default": "null"
            }
        ];
    }

    async run(armorType) {
        console.log("equipArmor", armorType);
        try{
            // When making the bot perform an action, use this.bot
            if (armorType === "null"){
                const armorSlots = ["head", "torso", "legs", "feet"];
                let unequipped = false;
                for (const slot of armorSlots) {
                    if (this.bot.inventory.slots[this.bot.getEquipmentDestSlot(slot)]) {
                        await this.bot.unequip(slot);
                        unequipped = true;
                    }
                }
                if (unequipped) {
                    return { "success": true, "result": "全ての防具を脱ぎました。" };
                } else {
                    return { "success": true, "result": "既に全ての防具を脱いでいます。" };
                }
            }else{
                const armor = this.bot.inventory.items().find(item => item.name.includes(armorType));
                if (armor) {
                    const equipSlot = {
                        "helmet": "head",
                        "chestplate": "torso",
                        "leggings": "legs",
                        "boots": "feet"
                    }[armorType] || "head";
                    await this.bot.equip(armor, equipSlot);
                    return { "success": true, "result": `${armorType} を装備しました。` };
                } else {
                    return { "success": false, "result": `${armorType} が見つかりません。` };
                }
            }
        }catch(e){
            return { "success": false, "result": `${e.message} in ${e.stack}` };
        }
    }
}

module.exports = EquipArmor;
