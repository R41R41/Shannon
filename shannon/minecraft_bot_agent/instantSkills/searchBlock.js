const InstantSkill = require('./instantSkill.js');
const {goals} = require('mineflayer-pathfinder');

class SearchBlock extends InstantSkill{
    /**
     * @param {import('../types.js').CustomBot} bot
     */
    constructor(bot){
        super(bot);
        this.skillName = "search-block";
        this.description = "指定されたブロックを探索する";
        this.status = false;
        this.mcData = require('minecraft-data')(this.bot.version);
        this.searchDistance = 64;
        this.params = [{
            "name": "blockName",
            "description": "探索するブロック",
            "type": "string"
        }];
    }

    /**
     * @param {string} blockName
     */
    async run(blockName){
        console.log("searchBlock", blockName);
        try{
            const Block = this.mcData.blocksByName[blockName];
            if (!Block) {
                return {"success": false, "result": `ブロック${blockName}はありません`};
            }
            const Blocks = this.bot.findBlocks({
                matching: Block.id,
                maxDistance: this.searchDistance,
                count: 1
            });
            if (Blocks.length === 0){
                return {"success": false, "result": `周囲${this.searchDistance}ブロック以内に${blockName}は見つかりませんでした`};
            }
            await this.bot.pathfinder.goto( new goals.GoalNear(Blocks[0].x, Blocks[0].y, Blocks[0].z, 1));
            return {"success": true, "result": `${blockName}は${Blocks[0].x} ${Blocks[0].y} ${Blocks[0].z}にあります。`};
        } catch (error) {
            return {"success": false, "result": `${error.message} in ${error.stack}`};
        }
    }
}

module.exports = SearchBlock;