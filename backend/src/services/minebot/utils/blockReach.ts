/**
 * How far the hand reaches a block, in one number (mb-llmc-cand, run 36): from the eye (feet + 1.62) to the block's centre. Dig, place,
 * use, chest, furnace, craft, `sight` and the cells `path` offers to stand in all say this and stop at this. Before, dig stopped at 5.0
 * and said "5m まで" while place and use stopped at 5.0 (USE_REACH + 0.5) and said "4.5m まで", and `sight` called 4.6 "届かない": six digs
 * of run 36 were sent at 5.2-5.8 m. 5.0 is what mineflayer allows (`canDigBlock`: 5.1 from an eye at 1.65) and what the digs and places of
 * runs 25-36 did at; the server's survival range is 4.5 from the block's nearest face plus a margin, so the centre may be further.
 */
export const BLOCK_REACH = 5.0;
