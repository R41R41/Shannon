const InstantSkill = require('./instantSkill.js');
const { Vec3 } = require('vec3');
const HoldItem = require('./holdItem.js');
const { goals } = require('mineflayer-pathfinder');

class PlaceBlock extends InstantSkill {
    /**
     * @param {import('../types.js').CustomBot} bot
     */
    constructor(bot) {
        super(bot);
        this.skillName = "place-block";
        this.description = "指定したブロックを置きます。";
        this.holdItem = new HoldItem(bot);
        this.params = [
            {
                "name": "blockName",
                "type": "string",
                "description": "置くブロックの名前",
                "default": "null"
            },
            {
                "name": "placePosition",
                "type": "vec3",
                "description": "ブロックを置く座標",
                "default": "0,0,0"
            },
            {
                "name": "placedBlockPosition",
                "type": "vec3",
                "description": "ブロックを面で接するように置く先の既に置いてあるブロックの座標",
                "default": "0,0,0"
            }
        ];
    }

    /**
     * @param {string} blockName
     * @param {Vec3} placePosition
     * @param {Vec3} placedBlockPosition
     */
    async run(blockName, placePosition, placedBlockPosition) {
        console.log("placeBlock", blockName, placePosition, placedBlockPosition);
        try{
            const block = this.bot.blockAt(placedBlockPosition);
            if (block.name.includes("air") || block.name.includes("void") || block.name.includes("water")) {
                return { "success": false, "result": `${placedBlockPosition}に設置可能なブロックがありません。get-blocks-dataツールで確認してください。` };
            }
            const response = await this.holdItem.run(blockName, "hand");
            if (!response.success) {
                return response;
            }
            const relativePosition = placePosition.minus(placedBlockPosition);
            if (!((Math.abs(relativePosition.x) === 1 && relativePosition.y === 0 && relativePosition.z === 0) ||
                  (relativePosition.x === 0 && Math.abs(relativePosition.y) === 1 && relativePosition.z === 0) ||
                  (relativePosition.x === 0 && relativePosition.y === 0 && Math.abs(relativePosition.z) === 1))) {
                return { "success": false, "result": "ブロックを置く座標と既に置いてあるブロックの座標の差は単位ベクトルでなければなりません。" };
            }
            await this.bot.pathfinder.goto(new goals.GoalNear(placePosition.x, placePosition.y, placePosition.z, 3));
            await this.bot.placeBlock(block, relativePosition);
            return { "success": true, "result": `${blockName}を${placePosition}に置きました。` };
        } catch (error) {
            return { "success": false, "result": `${error.message} in ${error.stack}` };
        }
    }
}

module.exports = PlaceBlock;