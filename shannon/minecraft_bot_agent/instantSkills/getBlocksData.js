const fs = require('fs');
const InstantSkill = require('./instantSkill.js');
const { Vec3 } = require('vec3');

class GetBlocksData extends InstantSkill {
    /**
     * @param {import('../types.js').CustomBot} bot
     */
    constructor(bot) {
        super(bot);
        this.skillName = "get-blocks-data";
        this.description = "指定した空間のブロックのデータを取得します";
        this.bot = bot;
        this.params = [
            {
                name: "startPoint",
                type: "vec3",
                description: "始点座標",
                default: "0, 0, 0"
            },
            {
                name: "endPoint",
                type: "vec3",
                description: "終点座標",
                default: "3, 4, 4"
            }
        ]
        this.canUseByCommand = false;
    }

    /**
     * @param {Vec3} startPoint
     * @param {Vec3} endPoint
     */
    async run(startPoint, endPoint) {
        try {
            const blocksData = [];
            const volume = Math.abs((endPoint.x - startPoint.x) * (endPoint.y - startPoint.y) * (endPoint.z - startPoint.z));
            if (volume > 64) {
                return { "success": false, "result": "指定した空間の体積が64を超えています" };
            }

            for (let x = startPoint.x; x <= endPoint.x; x++) {
                for (let y = startPoint.y; y <= endPoint.y; y++) {
                    for (let z = startPoint.z; z <= endPoint.z; z++) {
                        const block = this.bot.blockAt(new Vec3(x, y, z));
                        if (block) {
                            blocksData.push({
                                position: { x, y, z },
                                name: block.name,
                            });
                        }
                    }
                }
            }
            const path = require('path');
            const filePath = path.join(process.cwd(), 'saves', 'minecraft', 'blocks.txt');
            fs.writeFileSync(filePath, JSON.stringify(blocksData, null, 2));
            return { "success": true, "result": `指定した空間のブロックデータを以下に格納しました: ${filePath}` };
        } catch (error) {
            return { "success": false, "result": `${error.message} in ${error.stack}` };
        }
    }
}

module.exports = GetBlocksData;