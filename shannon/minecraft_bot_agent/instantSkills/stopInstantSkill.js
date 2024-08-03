const InstantSkill = require('./instantSkill.js');

class StopInstantSkill extends InstantSkill {
    /**
     * @param {import('../types.js').CustomBot} bot
     */
    constructor(bot) {
        super(bot);
        this.skillName = "stop-instant-skill";
        this.description = "指定したインスタントスキルを終了します。";
        this.params = [
            {
                "name": "skillName",
                "type": "string",
                "description": "終了するインスタントスキルの名前"
            }
        ];
        this.canUseByCommand = false;
    }

    async run(skillName) {
        try {
            if (this.bot.instantSkills[skillName]) {
                this.bot.instantSkills[skillName].status = false;
                return { "success": true, "result": `${skillName}を終了しました` };
            } else {
                return { "success": false, "result": `${skillName}は存在しません` };
            }
        } catch (e) {
            return { "success": false, "result": `${e.message} in ${e.stack}` };
        }
    }
}

module.exports = StopInstantSkill;