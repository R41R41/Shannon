const InstantSkill = require('./instantSkill');

class RunFromEntity extends InstantSkill{
    /**
     * @param {import('../types').CustomBot} bot
     */ 
    constructor(bot) {
        super(bot);
        this.skillName = 'runFromEntity';
        this.description = 'Run from the nearest entity';
        this.params = [
            {
                type: 'string',
                name: 'entity_name',
                description: 'The name of the entity to run from'
            }
        ];
    }

    /**
     * @param {string} entity_name
     */
    async run(entity_name) {
        const entity = this.bot.nearestEntity(entity => entity.displayName === entity_name);
        if (entity){
            this.bot.utils.runFromEntities(this.bot, entity, 16);
        }
    }
}

module.exports = RunFromEntity;