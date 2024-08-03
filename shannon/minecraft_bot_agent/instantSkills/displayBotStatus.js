const InstantSkill = require('./instantSkill.js');

class DisplayBotStatus extends InstantSkill{
    /**
     * @param {import('../types.js').CustomBot} bot
     */
    constructor(bot){
        super(bot);
        this.skillName = "display-bot-status";
        this.description = "ボットの体力と満腹度を表示する";
        this.status = false;
        this.params = [];
    }

    async run(){
        console.log("displayBotStatus");
        try{
            const hpMessage = JSON.stringify({
                text: `HP ${this.bot.health.toFixed(1)}/20`,
                color: 'green',
            },);
            const foodMessage = JSON.stringify({
                text: `Food ${this.bot.food.toFixed(1)}/20`,
                color: 'green',
            },);
            await this.bot.chat(`/tellraw @a ${hpMessage}`);
            await this.bot.chat(`/tellraw @a ${foodMessage}`);
            return {"success": true, "result": `botの体力と満腹度を表示しました`};
        } catch (error) {
            return {"success": false, "result": `${error.message} in ${error.stack}`};
        }
    }
}

module.exports = DisplayBotStatus;