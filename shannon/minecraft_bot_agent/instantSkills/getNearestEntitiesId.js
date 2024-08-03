const InstantSkill = require('./instantSkill.js');
const getNearestEntitiesByName = require('../utils/getNearestEntitiesByName.js');

class GetNearestEntitiesId extends InstantSkill {
    constructor(bot) {
        super(bot);
        this.skillName = "getNearestEntitiesId";
        this.description = "Get the nearest entities id";
        this.priority = 100;
        this.canUseByCommand = false;
        this.params = [
            {
                "name": "entity_name",
                "type": "string",
                "description": "エンティティの名前を指定します。",
                "default": null
            }
        ]
    }

    async run(entity_name) {
        if (entity_name === null) {
            return {"error": true, "result": "エンティティの名前が指定されていません"};
        }
        const nearestEntities = await getNearestEntitiesByName(this.bot, entity_name);
        if (nearestEntities.length == 0) {
            return {"error": true, "result": "No entities found"};
        }
        const result = nearestEntities.map(entity => {
            const name = entity.name || entity.username;
            const id = entity.id;
            const position = entity.position;
            return `id: ${id}, name: ${name}, position: ${position}`;
        }).join('\n');
        return {"error": false, "result": result};
    }
}

module.exports = GetNearestEntitiesId;
