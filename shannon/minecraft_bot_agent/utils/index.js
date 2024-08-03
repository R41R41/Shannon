const getFrontBlock = require('./getFrontBlock');
const getNearestEntitiesByName = require('./getNearestEntitiesByName');
const getParams = require('./getParams');
const getChatResponse = require('./getChatResponse');
const setMovements = require('./setMovements');
const GoalFollow = require('./goalFollow');
const GoalXZ = require('./goalXZ');
const runFromEntities = require('./runFromEntities');
const GoalDistanceEntity = require('./goalDistanceEntity');
const GetPathToEntity = require('./getPathToEntity');
const GoalBlock = require('./goalBlock');
const PostRequestToLLM = require('./postRequestToLLM');
const GetHoldingItem = require('./getHoldingItem');

module.exports = class Utils {
    /**
     * @param {import('../types').CustomBot} bot
     */
    constructor(bot) {
        this.bot = bot;
        this.goalFollow = new GoalFollow(bot);
        this.getFrontBlock = getFrontBlock;
        this.getNearestEntitiesByName = getNearestEntitiesByName;
        this.getParams = getParams;
        this.getChatResponse = getChatResponse;
        this.setMovements = setMovements;
        this.goalXZ = new GoalXZ(bot);
        this.runFromEntities = runFromEntities;
        this.goalDistanceEntity = new GoalDistanceEntity(bot);
        this.getPathToEntity = new GetPathToEntity(bot);
        this.goalBlock = new GoalBlock(bot);
        this.postRequestToLLM = new PostRequestToLLM(bot);
        this.getHoldingItem = new GetHoldingItem(bot);
    }
}