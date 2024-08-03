const InstantSkill = require('./instantSkill.js');

class DisplayConstantSkillList extends InstantSkill {
    /**
     * @param {import('../types.js').CustomBot} bot
     */
    constructor(bot) {
        super(bot);
        this.skillName = "display-constant-skill-list";
        this.description = "Constant Skillのリストを表示します。";
        this.priority = 100;
        this.params = [];
    }

    async run() {
        try{
            if (this.bot.constantSkills === null) {
                return {"success": false, "result": "スキルリストが指定されていません"};
            }
            Object.keys(this.bot.constantSkills).forEach(async skillName => {
                const message = JSON.stringify({
                    text: `${skillName}`,
                    color: `${this.bot.constantSkills[skillName].status ? "blue" : "gray"}`,
                    underlined: true,
                    hoverEvent: {
                        action: 'show_text',
                        contents: `${this.bot.constantSkills[skillName].description}`
                    },
                    clickEvent: {
                        action: "suggest_command",
                        value: `../${skillName}`
                    }
                },
                );
                await this.bot.chat(`/tellraw @a ${message}`);
            });
            return {"success": true, "result": "Constant Skillのリストを表示しました"};
        } catch (error) {
            return {"success": false, "result": `${error.message} in ${error.stack}`};
        }
    }
}

module.exports = DisplayConstantSkillList;