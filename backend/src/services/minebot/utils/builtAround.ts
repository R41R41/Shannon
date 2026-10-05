/** How far from its centre the body is still told of what it built round itself. */
const NEAR = 8;

interface Built { name: string; centre: { x: number; y: number; z: number }; total: number; missing: () => number }
interface Body { builtAround?: Built; entity?: { position?: { x: number; y: number; z: number } } }

/**
 * What the body last built round itself (build-around-self), while it is near it: where its centre is, whether
 * the body is in it, and how many of its blocks are not standing now. A wall dug through to fetch a drop, or
 * broken by a blast, is a gap something can come in by; the body that built it is told so, and how to close it.
 */
export function builtAroundStatus(bot: unknown): string | null {
  const body = bot as Body | null | undefined;
  const built = body?.builtAround, at = body?.entity?.position;
  if (!built || !at || typeof built.missing !== 'function') return null;
  const { x, y, z } = built.centre;
  const away = Math.hypot(at.x - (x + 0.5), at.z - (z + 0.5));
  if (away > NEAR || Math.abs(at.y - y) > NEAR) return null;
  const inside = Math.floor(at.x) === x && Math.floor(at.z) === z && Math.abs(at.y - y) < 1;
  const missing = built.missing();
  const where = inside ? 'いま中央のマスにいる' : `中央から${away.toFixed(1)}m離れている`;
  return `${built.name}（中央のマス (${x},${y},${z})、${where}）: `
    + (missing === 0 ? `${built.total}マスすべて建っている`
      : `${built.total}マス中${missing}マスが欠けている（${inside ? '' : '中央のマスへ戻ってから'}build-around-self をもう一度呼べば塞がる）`);
}
