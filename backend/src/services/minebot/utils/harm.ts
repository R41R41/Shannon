import { isBurning, standsOnMagma } from './lavaSafety.js';

interface HarmBody {
  entity?: { isInLava?: boolean; metadata?: unknown[]; effects?: Record<string, { id?: number }>; position?: unknown };
  blockAt?(position: unknown): { name?: string } | null;
  food?: number;
  game?: { dimension?: unknown };
  registry?: { effects?: Record<string, { name?: string } | undefined> };
}

/**
 * What the body can tell is wearing its health down when no attacker is named: read from its own state, not
 * guessed. The message for such damage used to be one fixed sentence ("environmental damage: a fall, drowning
 * and the like; eat, ask a player for food, hunt, wait"). A body on fire in the Nether was told that, found
 * nothing to breathe wrong and no enemy near, reported the emergency over, twice, and burned to death standing
 * still (paid run L77b). Undefined when nothing it carries says what the hurt was (a fall is over when it is felt).
 */
export function describeHarm(bot: HarmBody): string | undefined {
  const parts: string[] = [];
  const nether = String(bot.game?.dimension ?? '').includes('nether');
  if (bot.entity?.isInLava === true) parts.push('溶岩の中にいます（すぐ外へ出る）');
  else {
    let burning = false;
    try { burning = isBurning(bot as any); } catch { burning = false; }
    if (burning) {
      parts.push('身体が燃えています（溶岩や火に触れた後は約15秒燃え続け、毎秒1ずつ体力が減る）。'
        + (nether ? 'ここ（ネザー）では水を置けないので消せません。溶岩と火から離れ、食料があれば食べて体力を保ってください'
          : '水に入るか、水バケツの水を足元に置けば消えます'));
    }
  }
  let magma = false;
  try { magma = standsOnMagma(bot as any); } catch { magma = false; }
  if (magma) parts.push('マグマブロックの上に立っています（しゃがまずに乗っている間ずっと焼かれる。しゃがむか、マグマの無い足場へ移る）');
  if (typeof bot.food === 'number' && bot.food <= 0) parts.push('空腹で体力が減っています（食べれば止まる）');
  for (const [id, effect] of Object.entries(bot.entity?.effects ?? {})) {
    const name = String(bot.registry?.effects?.[String(effect?.id ?? id)]?.name ?? '').toLowerCase();
    if (name.includes('poison')) parts.push('毒を受けています（時間で切れる。体力1より下には減らない）');
    else if (name.includes('wither')) parts.push('ウィザー状態です（時間で切れるまで体力が減り続ける）');
  }
  return parts.length ? parts.join(' ') : undefined;
}
