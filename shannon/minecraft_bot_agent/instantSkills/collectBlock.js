const InstantSkill = require('./instantSkill.js');
const {goals} = require('mineflayer-pathfinder');

class CollectBlock extends InstantSkill{
    /**
     * @param {import('../types.js').CustomBot} bot
     */
    constructor(bot){
        super(bot);
        this.skillName = "collect-block";
        this.description = "指定されたブロックを集める";
        this.status = false;
        this.mcData = require('minecraft-data')(this.bot.version);
        this.searchDistance = 64;
        this.params = [{
                "name": "blockName",
                "description": "集めるブロック",
                "type": "string"
            },{
                "name": "count",
                "description": "集めるブロックの個数",
                "type": "number"
            }
        ];
    }

    /**
     * @param {string} blockName
     * @param {number} count
     */
    async run(blockName, count){
        console.log("collectBlock", blockName, count);
        try{
            const Block = this.mcData.blocksByName[blockName];
            await new Promise(resolve => setTimeout(resolve, 100));
            if (!Block) {
                return {"success": false, "result": `ブロック${blockName}はありません`};
            }
            const item = this.bot.registry.items[Block.drops[0]];
            const dropItemName = item.name;
            let collectItems = this.bot.inventory.items().filter((item) => item.name === dropItemName);
            let collectCount = collectItems.reduce((acc, item) => acc + item.count, 0);
            while(collectCount < count){
                const Blocks = this.bot.findBlocks({
                    matching: Block.id,
                    maxDistance: this.searchDistance,
                    count: 1
                });
                const block = this.bot.blockAt(Blocks[0]);
                if (!block) {
                    return {"success": false, "result": `ブロック ${blockName} が見つかりませんでした`};
                }
                await this.bot.pathfinder.goto(new goals.GoalNear(Blocks[0].x, Blocks[0].y, Blocks[0].z, 3));
                await this.bot.dig(block);
                await new Promise(resolve => setTimeout(resolve, 1000)); // ブロックがドロップするのを待つ
                const items = this.bot.nearestEntity(entity => entity.name === dropItemName);
                if (items) {
                    await this.bot.pathfinder.goto(new goals.GoalNear(items.position.x, items.position.y, items.position.z, 1));
                }
                collectItems = this.bot.inventory.items().filter((item) => item.name === dropItemName);
                collectCount = collectItems.reduce((acc, item) => acc + item.count, 0);
            }
            return {"success": true, "result": `${blockName}を${count}個集めました。`};
        } catch (error) {
            return {"success": false, "result": `${error.message} in ${error.stack}`};
        }
    }
}

module.exports = CollectBlock;