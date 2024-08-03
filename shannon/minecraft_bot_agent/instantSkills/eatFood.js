const InstantSkill = require('./instantSkill.js');
const HoldItem = require('./holdItem.js');

class EatFood extends InstantSkill{
    /**
     * @param {import('../types.js').CustomBot} bot
     */
    constructor(bot){
        super(bot);
        this.skillName = "eat-food";
        this.description = "指定されたアイテムを食べる";
        this.status = false;
        this.params = [{
            "name": "itemName",
            "description": "食べるアイテム",
            "type": "string"
        }];
        this.holdItem = new HoldItem(bot);
    }

    /**
     * @param {string} itemName
     */
    async run(itemName){
        console.log("eatFood", itemName);
        try{
            if (this.bot.food === 20){
                return {"success": false, "result": "満腹なので食べることができません"};
            }
            await this.holdItem.run(itemName, "hand");
            this.bot.deactivateItem();
            this.bot.activateItem();
            await new Promise(resolve => setTimeout(resolve, 3000));
            return {"success": true, "result": `${itemName}を食べました`};
        } catch (error) {
            return {"success": false, "result": `${error.message} in ${error.stack}`};
        }
    }
}

module.exports = EatFood;