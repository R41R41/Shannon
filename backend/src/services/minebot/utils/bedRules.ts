/**
 * Beds of every colour work the same: `bed` or any `<colour>_bed` names one. Outside the Overworld a bed is not slept
 * in but explodes (the Nether and the End), so no skill puts the body into one there.
 */
export const isBedName = (name: unknown): boolean => {
  const text = String(name ?? '').replace(/^minecraft:/, '');
  return text === 'bed' || text.endsWith('_bed');
};

export function bedExplodesHere(bot: { game?: { dimension?: unknown } }): boolean {
  return /nether|the_end/.test(String(bot.game?.dimension ?? ''));
}

export const BED_EXPLODES = 'ネザーとエンドではベッドは爆発するため使いません（リスポーン地点はオーバーワールドのベッドで決めます）';
