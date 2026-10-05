import { createLogger } from '../../../utils/logger.js';

const log = createLogger('Minebot:ServerRefusal');

/**
 * The server has the last word on where the body can be. When it puts the
 * body back, the client's picture of the world was wrong at that spot: a
 * block whose real shape is offset from the one the client models (pointed
 * dripstone, whose position the server shifts per block), a block the client
 * lost, a shape the client does not know at all. The navigator plans from the
 * client's picture, so it sent the body into the same spot again and again:
 * 65 corrections in 48 seconds beside dripstone in a pool, with the move
 * still "in progress" (paid run L36).
 *
 * This is the body learning from the refusal itself, whatever the cause: the
 * cells it was entering when the server refused it three times in a row are
 * remembered as closed for a while: the client's own physics and the navigator
 * both see a full block there, so the body neither plans through the cell nor
 * brushes into it on a straight line between two free cells (which is how it
 * met the dripstone: swimming past, a third of its width inside that cell).
 * The block keeps its identity (water stays water for swimming and for
 * searches); only its collision is taken from the server's verdict.
 */
const STRIKES = 3;
const WINDOW_MS = 2000;
const CLOSED_MS = 2 * 60_000;
/** A closed cell collides like a full block in the client's own physics and planning. */
const FULL_BLOCK = [[0, 0, 0, 1, 1, 1]];
const MAX_CLOSED = 256;
/** A correction this large is a teleport or a respawn, not a refused step. */
const MAX_STEP = 2;
const HALF_WIDTH = 0.3;

interface Point { x: number; y: number; z: number }
export interface ServerRefusalState { strikes: Map<string, number[]>; closed: Map<string, number> }
interface RefusalBot {
  entity?: { position: Point };
  serverRefusals?: ServerRefusalState;
  pathfinder?: { movements?: unknown; setMovements?(movements: unknown): void };
  blockAt?(position: Point, extraInfos?: boolean): object | null;
  on(event: 'physicsTick' | 'forcedMove' | 'blockUpdate', listener: (...args: any[]) => void): unknown;
}

const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

/** Columns (x,z) the body's footprint covers at a position. */
function footprint(at: Point): Array<[number, number]> {
  const columns: Array<[number, number]> = [];
  for (let x = Math.floor(at.x - HALF_WIDTH + 1e-6); x <= Math.floor(at.x + HALF_WIDTH - 1e-6); x++)
    for (let z = Math.floor(at.z - HALF_WIDTH + 1e-6); z <= Math.floor(at.z + HALF_WIDTH - 1e-6); z++) columns.push([x, z]);
  return columns;
}

/**
 * The cells the body was moving into when it was refused: the columns its
 * claimed position covers and the server's does not; when it never left its
 * columns (an obstacle inside the cell it stands in), the column its leading
 * edge points at. Feet and head level both, since either can be what is hit.
 */
export function refusedCells(claimed: Point, server: Point): string[] {
  const dx = claimed.x - server.x, dy = claimed.y - server.y, dz = claimed.z - server.z;
  if (Math.hypot(dx, dy, dz) > MAX_STEP || (Math.abs(dx) < 0.005 && Math.abs(dz) < 0.005)) return [];
  const held = new Set(footprint(server).map(([x, z]) => `${x},${z}`));
  let entering = footprint(claimed).filter(([x, z]) => !held.has(`${x},${z}`));
  if (!entering.length) {
    const reach = HALF_WIDTH + 0.05;
    entering = [[Math.floor(claimed.x + (Math.abs(dx) >= 0.005 ? Math.sign(dx) * reach : 0)), Math.floor(claimed.z + (Math.abs(dz) >= 0.005 ? Math.sign(dz) * reach : 0))]];
  }
  const feet = Math.floor(server.y + 1e-6);
  return entering.flatMap(([x, z]) => [key(x, feet, z), key(x, feet + 1, z)]);
}

/** Record one refusal; returns the cells that have just been closed by it. */
export function noteServerRefusal(state: ServerRefusalState, claimed: Point, server: Point, now = Date.now()): string[] {
  const closedNow: string[] = [];
  for (const cell of refusedCells(claimed, server)) {
    const times = (state.strikes.get(cell) ?? []).filter(at => now - at <= WINDOW_MS);
    times.push(now);
    state.strikes.set(cell, times);
    if (times.length >= STRIKES && !((state.closed.get(cell) ?? 0) > now)) { state.closed.set(cell, now + CLOSED_MS); closedNow.push(cell); }
  }
  for (const [cell, until] of state.closed) if (until <= now) state.closed.delete(cell);
  while (state.closed.size > MAX_CLOSED) state.closed.delete(state.closed.keys().next().value as string);
  for (const [cell, times] of state.strikes) if (!times.some(at => now - at <= WINDOW_MS)) state.strikes.delete(cell);
  return closedNow;
}

export function closedByServer(bot: unknown, position: Point, now = Date.now()): boolean {
  const until = (bot as RefusalBot | undefined)?.serverRefusals?.closed.get(key(position.x, position.y, position.z));
  return until !== undefined && until > now;
}

/** For the navigator: a cell the server has been refusing costs more than any route may. */
export function serverRefusalStepCost(bot: unknown): (block: { position?: Point }) => number {
  return block => block?.position && closedByServer(bot, block.position) ? 100 : 0;
}

export function installServerRefusals(bot: RefusalBot): void {
  if (bot.serverRefusals) return;
  const state: ServerRefusalState = bot.serverRefusals = { strikes: new Map(), closed: new Map() };
  // Physics, the navigator and its straight-line shortcut all read the world through blockAt.
  const blockAt = bot.blockAt?.bind(bot);
  if (blockAt) bot.blockAt = (position: Point, extraInfos?: boolean) => {
    const block = blockAt(position, extraInfos);
    if (!block || state.closed.size === 0 || !closedByServer(bot, { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) })) return block;
    return Object.assign(Object.create(block), { shapes: FULL_BLOCK, boundingBox: 'block' });
  };
  let claimed: Point | null = null;
  bot.on('physicsTick', () => { const p = bot.entity?.position; if (p) claimed = { x: p.x, y: p.y, z: p.z }; });
  bot.on('forcedMove', () => {
    const server = bot.entity?.position;
    if (!server || !claimed) return;
    const closed = noteServerRefusal(state, claimed, { x: server.x, y: server.y, z: server.z });
    claimed = { x: server.x, y: server.y, z: server.z };
    if (!closed.length) return;
    log.warn(`🚧 サーバーが続けて通さなかった場所を閉じた道として覚えた（2分間）: ${closed.map(cell => `(${cell})`).join(' ')}。経路はここを避けて引き直す`);
    // The navigator plans again from the corrected picture, with its goal unchanged.
    try { if (bot.pathfinder?.movements) bot.pathfinder.setMovements?.(bot.pathfinder.movements); } catch { /* planning again is best effort */ }
  });
  bot.on('blockUpdate', (before: { type?: number } | null, after: { type?: number; position?: Point } | null) => {
    if (state.closed.size && before?.type !== after?.type) reopenChangedCell(state, after?.position);
  });
}

/**
 * A refusal says the client's picture of that cell was wrong at the time. When the picture of the cell
 * changes (the server sends its block, the body digs it out), the old refusal no longer describes it.
 */
export function reopenChangedCell(state: ServerRefusalState, position: Point | undefined): void {
  if (!position) return;
  const cell = key(position.x, position.y, position.z);
  state.closed.delete(cell);
  state.strikes.delete(cell);
}

export function serverRefusalPlugin(bot: unknown): void { installServerRefusals(bot as RefusalBot); }
