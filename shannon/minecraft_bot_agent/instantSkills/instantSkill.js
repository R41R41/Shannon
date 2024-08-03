const Skill = require('../Skill');

class InstantSkill extends Skill{
    /**
     * @param {import('../types').CustomBot} bot
     */
    constructor(bot) {
        super(bot);
        /** @type {number} */
        this.priority = 0;
        /** @type {boolean} */
        this.status = false;
        this.params = []
        this.canUseByCommand = true;
    }
}

module.exports = InstantSkill;