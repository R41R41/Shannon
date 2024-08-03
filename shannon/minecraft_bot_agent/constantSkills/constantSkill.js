const Skill = require('../Skill');

class ConstantSkill extends Skill{
    /**
     * @param {import('../types').CustomBot} bot
     */
    constructor(bot) {
        super(bot);
        /** @type {number} */
        this.priority = 0;
        /** @type {boolean} */
        this.isLocked = false;
        /** @type {boolean} */
        this.status = false;
        /** @type {number} */
        this.interval = 1000;
    }

    lock() {
        if (this.isLocked) return;
        this.isLocked = true;
    }

    unlock() {
        if (!this.isLocked) return;
        this.isLocked = false;
    }
}

module.exports = ConstantSkill;