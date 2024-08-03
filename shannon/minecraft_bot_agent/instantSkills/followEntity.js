const InstantSkill = require('./instantSkill.js');

class FollowEntity extends InstantSkill {
    /**
     * @param {import('../types.js').CustomBot} bot
     */
    constructor(bot) {
        super(bot);
        this.skillName = "follow-entity";
        this.description = "エンティティを追尾します";
        this.priority = 10;
        this.params = [
            {
                name: "entityName",
                type: "string",
                description: "The name of the entity to follow",
                default: null
            }
        ];
    }

    /**
     * @param {string} entity_name
     */
    async run(entityName) {
        try{
            if (entityName === null) {
                return {"success": false, "result": "エンティティの名前が指定されていません"};
            }
            let entities = await this.bot.utils.getNearestEntitiesByName(this.bot, entityName);
            if (entities.length === 0) return {"success": false, "result": "エンティティが見つからない"};
            const entity = entities[0];

            while (this.status) {
                this.bot.pathfinder.setGoal(null);
                this.bot.setControlState('sprint', false);
                this.bot.setControlState('forward', false);
                this.bot.setControlState('jump', false);
                this.bot.setControlState('sneak', false);
                if (this.bot.entity.isInWater) {
                    await this.swim(entity);
                }else{
                    await this.bot.utils.goalFollow.run(entity, 1.5);
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            this.bot.pathfinder.setGoal(null);
            return {"success": true, "result": "エンティティの追尾を終了しました"};
        } catch (error) {
            return {"success": false, "result": `${error.message} in ${error.stack}`};
        }
    }

    async swim(entity){
        await this.bot.lookAt(entity.position,true);
        this.bot.setControlState('sprint', true);
        this.bot.setControlState('forward', true);
        const frontBlock = this.bot.utils.getFrontBlock(this.bot,1);
        const aboveBlock = this.bot.world.getBlock(this.bot.entity.position.offset(0, 2, 0));
        const aboveAboveBlock = this.bot.world.getBlock(this.bot.entity.position.offset(0, 3, 0));
        const belowBlock = this.bot.world.getBlock(this.bot.entity.position.offset(0, -1, 0));
                
        if (this.bot.oxygenLevel < 5) {
            // 酸素レベルが低いなら、上に進む
            this.bot.setControlState('jump', true);
            this.bot.setControlState('sneak', false);
        }else if (frontBlock && frontBlock.name !== 'water' && frontBlock.name !== 'air') {
            // 前方に水がないなら、上に進む
            this.bot.setControlState('jump', true);
            this.bot.setControlState('sneak', false);
        }else if (aboveBlock && aboveBlock.name !== 'water' && belowBlock && belowBlock.name == 'water') {
            // 泳げる深さがあって上方に水がないなら、下に進む
            this.bot.setControlState('jump', false);
            this.bot.setControlState('sneak', true);
        }else if(aboveAboveBlock && aboveAboveBlock.name !== 'water' && belowBlock && belowBlock.name == 'water'){
            // 上に上に水があるなら、前に進む
            this.bot.setControlState('jump', false);
            this.bot.setControlState('sneak', false);
        } else if (this.bot.entity.position.y < entity.position.y) {
            // エンティティより下にいるなら、上に進む
            this.bot.setControlState('jump', true);
            this.bot.setControlState('sneak', false);
        }
    }
}

module.exports = FollowEntity;
