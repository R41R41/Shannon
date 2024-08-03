const { Vec3 } = require('vec3');

/**
 * @param {import('../types').CustomBot} bot - The bot instance from mineflayer
 * @param {number} distance - The distance to the block
 * @returns {import('../types').Block} - The block in front of the bot
 */
module.exports = function getFrontBlock(bot, distance) {
    const { yaw, pitch } = bot.entity;
    const directionVector = new Vec3(
        -Math.sin(yaw) * Math.cos(pitch),
        -Math.sin(pitch),
        -Math.cos(yaw) * Math.cos(pitch)
    );

    const eyePosition = bot.entity.position.offset(0, bot.entity.height * 0.8, 0);
    const targetPosition = eyePosition.plus(directionVector.scaled(distance));
    const frontBlock = bot.blockAt(targetPosition);
    return frontBlock;
}