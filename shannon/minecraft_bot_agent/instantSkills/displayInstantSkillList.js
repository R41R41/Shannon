const InstantSkill = require('./instantSkill.js');

class DisplayInstantSkillList extends InstantSkill {
    /**
     * @param {import('../types.js').CustomBot} bot
     */
    constructor(bot) {
        super(bot);
        this.skillName = "display-instant-skill-list";
        this.description = "Instant Skillのリストを表示します。";
        this.priority = 100;
        this.params = [];
    }

    async run() {
        try{
            if (this.bot.instantSkills === null) {
                return {"success": false, "result": "スキルリストが指定されていません"};
            }
            Object.keys(this.bot.instantSkills).forEach(async skillName => {
                if (!this.bot.instantSkills[skillName].canUseByCommand) return;
                const message = JSON.stringify({
                    text: `${skillName}`,
                    color: `${this.bot.instantSkills[skillName].status ? "green" : "gray"}`,
                    underlined: true,
                    hoverEvent: {
                        action: 'show_text',
                        contents: `${this.bot.instantSkills[skillName].description}`
                    },
                    clickEvent: {
                            action: "suggest_command",
                            value: `./${skillName}`
                        }
                    },
                );
                await this.bot.chat(`/tellraw @a ${message}`);
            });
            return {"success": true, "result": "Instant Skillのリストを表示しました"};
        } catch (error) {
            return {"success": false, "result": `${error.message} in ${error.stack}`};
        }
    }
}

module.exports = DisplayInstantSkillList;