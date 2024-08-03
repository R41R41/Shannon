const InstantSkill = require('./instantSkill.js');

class Chat extends InstantSkill {
    /**
     * @param {import('../types.js').CustomBot} bot
     */
    constructor(bot) {
        super(bot);
        this.skillName = "chat";
        this.description = "Chat with the bot";
        this.priority = 50;
        this.params = [
            {
                "name": "text",
                "type": "string",
                "description": "チャットするテキストを指定します。",
                "default": null
            }
        ]
    }

    /**
     * @param {string} text
     */
    async run(text) {
        if (text === null) {
            return {"success": false, "result": "テキストが指定されていません"};
        }else{
            this.bot.chat(text);
            return {"success": true, "result": `${text}とチャットしました`};
        }
    }
}

module.exports = Chat;