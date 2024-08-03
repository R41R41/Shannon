const InstantSkill = require('./instantSkill.js');
const fs = require('fs');

class GetEntitiesInfo extends InstantSkill {
    /**
     * @param {import('../types.js').CustomBot} bot
     */
    constructor(bot) {
        super(bot);
        this.skillName = "get-entities-info";
        this.description = "自分を含めた周囲のmob, player, hostileの位置情報を取得します。";
        this.priority = 100;
        this.canUseByCommand = false;
        this.params = []
    }

    async run() {
        try {
            const entitiesInfo = [];
            const path = require('path');
            const filePath = path.join(process.cwd(), 'saves', 'minecraft', 'surrounding_entities.txt');

            const sortedEntities = Object.values(this.bot.entities)
                .filter(entity => this.bot.entity.position.distanceTo(entity.position) <= 32 && (entity.type === 'mob' || entity.type === 'player' || entity.type === 'hostile'))
                .map(entity => ({
                    entity,
                    distance: this.bot.entity.position.distanceTo(entity.position)
                }))
                .sort((a, b) => a.distance - b.distance)
                .map(item => item.entity);

            sortedEntities.forEach(entity => {
                entitiesInfo.push({
                    id: entity.id,
                    name: entity.username || entity.name,
                    position: entity.position
                });
            });
            fs.writeFileSync(filePath, JSON.stringify(entitiesInfo, null, 2));
            return { "success": true, "result": `周囲のエンティティのデータを以下に格納しました: ${filePath}` };
        } catch (error) {
            return { "success": false, "result": `${error.message} in ${error.stack}` };
        }
    }
}

module.exports = GetEntitiesInfo;
