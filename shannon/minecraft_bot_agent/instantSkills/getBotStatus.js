const InstantSkill = require('./instantSkill.js');

class GetBotStatus extends InstantSkill{
    /**
     * @param {import('../types.js').CustomBot} bot
     */
    constructor(bot){
        super(bot);
        this.skillName = "get-bot-status";
        this.description = "ボットの体力と満腹度を取得する";
        this.status = false;
        this.params = [];
    }

    async run(){
        console.log("getBotStatus");
        try{
            return {"success": true, "result": `体力: ${this.bot.health}/20, 満腹度: ${this.bot.food}/20`};
        } catch (error) {
            return {"success": false, "result": `${error.message} in ${error.stack}`};
        }
    }
}

module.exports = GetBotStatus;