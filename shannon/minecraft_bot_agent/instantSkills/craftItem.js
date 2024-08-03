const InstantSkill = require('./instantSkill.js');
const { goals } = require('mineflayer-pathfinder');
const assert = require('assert')

class CraftItem extends InstantSkill{
    /**
     * @param {import('../types.js').CustomBot} bot
     */
    constructor(bot){
        super(bot);
        this.skillName = "craft-item";
        this.description = "指定されたアイテムを作成する";
        this.status = false;
        this.mcData = require('minecraft-data')(this.bot.version);
        this.params = [
            {
                "name": "itemName",
                "description": "作成するアイテム",
                "type": "string"
            },{
                "name": "amount",
                "description": "作成するアイテムの数量",
                "type": "number"
            }
        ];
    }

    /**
     * @param {string} itemName
     * @param {number} amount
     */
    async run(itemName, amount){
        console.log("craftItem", itemName);
        try{
            const item = this.mcData.itemsByName[itemName];
            await new Promise(resolve => setTimeout(resolve, 100));
            if (!item) {
                return {"success": false, "result": `アイテム ${itemName} が見つかりませんでした`};
            }
            console.log(item.id);
            const recipe = this.bot.recipesFor(item.id,null,null,true)[0];
            await new Promise(resolve => setTimeout(resolve, 100));
            if (!recipe) {
                return {"success": false, "result": `アイテム ${itemName} のレシピが見つかりませんでした`};
            }
            if (recipe.requiresTable) {
                const craftingTable = this.bot.findBlock({
                    matching: this.mcData.blocksByName.crafting_table.id,
                    maxDistance: 64
                });
                if (!craftingTable) {
                    return {"success": false, "result": "近くに作業台が見つかりませんでした"};
                }
                await this.bot.pathfinder.goto(new goals.GoalNear(craftingTable.position.x, craftingTable.position.y, craftingTable.position.z, 3));
                await this.bot.craft(recipe, amount, craftingTable);
            }else{
                await this.bot.craft(recipe, amount, null);
            }
            const items = this.bot.inventory.items().filter(item => item.name === itemName);
            if (items && items.length >= amount){
                return {"success": true, "result": `${itemName}を${amount}個作成しました`};
            }
            return {"success": false, "result": `${itemName}を作成できませんでした`};
        } catch (error) {
            return {"success": false, "result": `${error.message} in ${error.stack}`};
        }
    }
}

module.exports = CraftItem;