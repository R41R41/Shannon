/**
 * The closed word (the first word of a stopped hand's line, utils/actReport CLOSED) for the codes of mine, make and smelt
 * (hands-contract.md 3, 4, 6). The code itself is in the line's text: `mine 止まった no_block: ...`.
 */
export const MINE_MAKE_SMELT_WORDS: Record<string, string> = {
  // mine
  no_block: '無い', no_tool: '掘れない', tool_broke: '掘れない', full: '満杯', unreachable: '届かない', limit_time: '時間切れ', limit_dig: '掘れない', danger: '溶岩が流れ込む',
  // make
  missing: '無い', no_table: '無い', no_recipe: '無い', craft_failed: '無い',
  // smelt
  no_furnace: '無い', fuel_short: '無い',
};
