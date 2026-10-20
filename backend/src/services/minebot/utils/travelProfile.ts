/** See the dig cost in travelProfile. */
export const TRAVEL_DIG_COST = 3;
/**
 * A block laid on the way (a bridge, a step up a bank). The planner's own price is 1, a single step; laying one takes the executor about a
 * second (it crouches and backs to the edge), five steps' worth. Priced at 1, a route over snow laid block after block where it could have
 * walked round; in run 19 it held its building pose for eight seconds on a snowy slope (the sheep search, D50).
 */
export const TRAVEL_PLACE_COST = 5;

/**
 * The profile of a walk that neither digs nor lays a block (utils/rockTravel): the ground as it is, no towers, no parkour (a jump
 * near a rim is what the cliff-edge stop of the body guards against), falls of four at most. Run 21's far walks over a hill were
 * planned with digging at 3 and laying at 5 and came out as zigzags of both; where the ground can be walked, this is the walk.
 */
export function walkOnlyProfile(isInWater: boolean) {
  return [
    false, // allow1by1towers
    true,  // allowSprinting
    false, // allowParkour
    true,  // canOpenDoors
    false, // canDig
    true,  // dontMineUnderFallingBlock
    1,     // digCost (unused)
    isInWater, // allowFreeMotion
    true,  // canSwim
    4,     // maxDropDown
    isInWater ? 2 : 10, // liquidCost
    false, // canPlace
    1,     // placeCost (unused)
  ] as const;
}

/**
 * The movement profile move-to travels with, as setMovements/buildMovements arguments after the bot.
 * check-path-to plans with the same one, so that its "reachable" means what a move would do (it used to compare
 * distances only and said "reachable" to a body no move could take anywhere: common run 7).
 */
export function travelProfile(isInWater: boolean) {
  return [
    false, // allow1by1towers
    true,  // allowSprinting
    true,  // allowParkour
    true,  // canOpenDoors
    true,  // canDig
    true,  // dontMineUnderFallingBlock
    // Prefer existing routes; still tunnel when it is quicker. The route planner prices a block dug at (1 + 3 x its seconds) x this, a
    // step at 1, and a step is about 0.2 s at a run: at 10 one block of stone (0.6 s with a stone pickaxe) weighed as much as 28 steps,
    // about 5 s of walking round. 3 weighs it as 8 steps (1.7 s): still round a short detour, through rock when the way round is long.
    // In run 19 walks of 9-11 m to an ore underground took 23-29 s each (10:34, 10:35 and 10:38 JST).
    isInWater ? 8 : TRAVEL_DIG_COST,
    isInWater, // allowFreeMotion
    true,  // canSwim
    4,     // maxDropDown
    isInWater ? 2 : 10, // liquidCost: 水中では低め、陸上では水を強く回避
    true,  // canPlace
    TRAVEL_PLACE_COST,
  ] as const;
}
