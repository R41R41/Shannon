const InstantSkill = require('./instantSkill.js');
const { Vec3 } = require('vec3');

class FindPlaceablePosition extends InstantSkill {
    /**
     * @param {import('../types.js').CustomBot} bot
     */
    constructor(bot) {
        super(bot);
        this.skillName = 'find-placeable-position';
        this.description = '指定された空間内でブロックを置ける座標を探します。';
        this.params = [
            {
                "name": "startPosition",
                "type": "vec3",
                "description": "検索を開始する座標を指定します。",
                "default": '0,0,0'
            },
            {
                "name": "endPosition",
                "type": "vec3",
                "description": "検索を終了する座標を指定します。",
                "default": '0,0,0'
            }
        ]
    }

    /**
     * 
     * @param {Vec3} startPosition 
     * @param {Vec3} endPosition 
     */
    async run(startPosition, endPosition) {
        try{
            if (startPosition === "0,0,0" || endPosition === "0,0,0") {
                const botPosition = this.bot.entity.position;
                startPosition = new Vec3(botPosition.x - 5, botPosition.y - 1, botPosition.z - 5);
                endPosition = new Vec3(botPosition.x + 5, botPosition.y + 1, botPosition.z + 5);
            }
            const placeablePositions = [];
            for (let x = startPosition.x; x <= endPosition.x; x++) {
                for (let y = startPosition.y; y <= endPosition.y; y++) {
                    for (let z = startPosition.z; z <= endPosition.z; z++) {
                        const position = new Vec3(x, y, z);
                        const block = this.bot.blockAt(position);
                        if (block.name === 'air' || block.name === 'water') {
                            const neighbors = [
                                this.bot.blockAt(position.offset(1, 0, 0)),
                                this.bot.blockAt(position.offset(-1, 0, 0)),
                                this.bot.blockAt(position.offset(0, 1, 0)),
                                this.bot.blockAt(position.offset(0, -1, 0)),
                                this.bot.blockAt(position.offset(0, 0, 1)),
                                this.bot.blockAt(position.offset(0, 0, -1))
                            ];
                            if (neighbors.some(neighbor => neighbor.name !== 'air' && neighbor.name !== 'water')) {
                                placeablePositions.push(position);
                            }
                        }
                    }
                }
            }
            const validPositions = placeablePositions.filter(position => {
                const blockBelow = this.bot.blockAt(position.offset(0, -1, 0));
                return blockBelow.name !== 'air' && blockBelow.name !== 'water';
            });
            if (validPositions.length === 0) {
                return {"success": false, "result": "ブロックを置ける座標が見つかりませんでした"};
            }
            const botPosition = this.bot.entity.position;
            let closestPosition = validPositions[0];
            let minDistance = botPosition.distanceTo(closestPosition);
            const filteredPositions = validPositions.filter(position => {
                const distance = botPosition.distanceTo(position);
                return distance > 1;
            });
            if (filteredPositions.length === 0) {
                return {"success": false, "result": "ブロックを置ける座標が見つかりませんでした"};
            }
            for (const position of filteredPositions) {
                const distance = botPosition.distanceTo(position);
                if (distance < minDistance) {
                    closestPosition = position;
                    minDistance = distance;
                }
            }
            const closestPositionBelow = closestPosition.offset(0, -1, 0);
            return {
                "success": true,
                "result": `place_position: ${closestPosition.x}, ${closestPosition.y}, ${closestPosition.z}\n` +
                          `placed_block_position: ${closestPositionBelow.x}, ${closestPositionBelow.y}, ${closestPositionBelow.z}`
            };
        } catch (error) {
            return {"success": false, "result": `${error.message} in ${error.stack}`};
        }
    }
}

module.exports = FindPlaceablePosition;