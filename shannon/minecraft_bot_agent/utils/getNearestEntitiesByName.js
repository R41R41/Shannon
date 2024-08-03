/**
 * @param {import('../types').CustomBot} bot
 * @param {string} entity_name
 * @returns {import('../types').Entities}
 */
module.exports = function getNearestEntitiesByName(bot, entity_name) {
    const entities = Object.values(bot.entities).filter(entity => {
        if (entity_name) {
            return entity.name === entity_name || entity.username === entity_name
        }
        return true
    })
    if (entities.length === 0) return []
    const sortedEntities = entities.map(entity => {
        const distance = bot.entity.position.distanceTo(entity.position)
        return {entity, distance}
    }).sort((a, b) => a.distance - b.distance)
    const nearestEntities = sortedEntities.slice(0, 10).map(item=> item.entity)
    return nearestEntities
}
