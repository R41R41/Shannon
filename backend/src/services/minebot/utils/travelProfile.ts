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
    isInWater ? 8 : 10, // prefer existing routes; still tunnel when necessary
    isInWater, // allowFreeMotion
    true,  // canSwim
    4,     // maxDropDown
    isInWater ? 2 : 10, // liquidCost: 水中では低め、陸上では水を強く回避
  ] as const;
}
