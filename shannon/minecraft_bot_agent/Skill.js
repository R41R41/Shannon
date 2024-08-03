class Skill {
    /**
     * @param {import('./types').CustomBot} bot
     */
    constructor(bot) {
        /** @type {string} */
        this.skillName = "skill";
        /** @type {string} */
        this.description = "skill";
        /** @type {boolean} */
        this.status = true;
        /** @type {import('./types').CustomBot} */
        this.bot = bot;
    }
}

module.exports = Skill;
