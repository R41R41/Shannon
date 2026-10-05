/** Physical skills keep their body lease until runImpl settles after cancellation
 * (see "keeps the lease until a non-cooperative cancelled body actually settles").
 * A raw timer wait ignores the action signal, so a cancelled skill kept the lease
 * for seconds and starved emergency reactions. Skill waits must use actionDelay.
 * No game server, bot process, network or database is used.
 */
import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { cancelActiveActions, executeAction } from '../../src/services/minebot/execution/ActionExecution.js';
import TowerUp from '../../src/services/minebot/instantSkills/towerUp.js';

const SKILL_DIR = fileURLToPath(new URL('../../src/services/minebot/instantSkills/', import.meta.url));

/** Intentionally kept raw waits: file -> maximum count and why. Remove an entry once converted. */
const RAW_WAIT_ALLOWLIST: Record<string, { max: number; reason: string }> = {
};

const RAW_WAIT_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  // new Promise(r => setTimeout(r, ms)), new Promise<void>((resolve) => { setTimeout(resolve, ms) })
  { name: 'promise-wrapped setTimeout', pattern: /new\s+Promise\s*(?:<[^>]*>)?\s*\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\{?\s*setTimeout\s*\(\s*\1\s*,/ },
  // A resolver passed straight to setTimeout on its own line (multi-line promise bodies).
  { name: 'setTimeout(resolve, ms)', pattern: /setTimeout\s*\(\s*(?:resolve|res|r|done)\s*,/ },
  { name: 'promisified setTimeout', pattern: /promisify\s*\(\s*setTimeout\s*\)/ },
  { name: 'timers/promises', pattern: /from\s+['"](?:node:)?timers\/promises['"]/ },
];

function rawWaitSites(file: string): Array<{ line: number; kind: string; text: string }> {
  const sites: Array<{ line: number; kind: string; text: string }> = [];
  readFileSync(join(SKILL_DIR, file), 'utf8').split('\n').forEach((text, index) => {
    const code = text.trim();
    if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
    const hit = RAW_WAIT_PATTERNS.find(({ pattern }) => pattern.test(text));
    if (hit) sites.push({ line: index + 1, kind: hit.name, text: code });
  });
  return sites;
}

afterEach(() => { vi.useRealTimers(); });

describe('instant skill waits observe action cancellation', () => {
  it('uses actionDelay instead of raw timer waits in every instant skill', () => {
    const files = readdirSync(SKILL_DIR).filter(name => name.endsWith('.ts')).sort();
    expect(files.length).toBeGreaterThan(40);
    const violations: string[] = [];
    for (const file of files) {
      const sites = rawWaitSites(file);
      const allowed = RAW_WAIT_ALLOWLIST[file]?.max ?? 0;
      if (sites.length > allowed) {
        violations.push(...sites.map(site => `${file}:${site.line} [${site.kind}] ${site.text}`),
          `${file}: ${sites.length} raw wait(s), allowlist permits ${allowed}`);
      }
    }
    expect(violations, 'Replace raw waits with actionDelay(this.bot, ms) from execution/observedWait.js').toEqual([]);
  });

  it('keeps every allowlist entry pointed at an existing file with a reason', () => {
    for (const [file, entry] of Object.entries(RAW_WAIT_ALLOWLIST)) {
      expect(readdirSync(SKILL_DIR)).toContain(file);
      expect(entry.reason.trim().length).toBeGreaterThan(10);
      expect(entry.max).toBeGreaterThan(0);
    }
  });

  it('detects the raw wait shapes it is meant to forbid', () => {
    const forbidden = [
      'await new Promise(r => setTimeout(r, 100));',
      'await new Promise((resolve) => setTimeout(resolve, ms));',
      'return new Promise<void>(r => setTimeout(r, ms));',
      'await new Promise(done => { setTimeout(done, 50); });',
      '  setTimeout(resolve, 200);',
      "import { setTimeout as sleep } from 'node:timers/promises';",
    ];
    for (const text of forbidden) expect(RAW_WAIT_PATTERNS.some(({ pattern }) => pattern.test(text)), text).toBe(true);
    const permitted = [
      'await actionDelay(this.bot, 100);',
      "const timeout = setTimeout(() => reject(new Error('timeout')), 5000);",
      "new Promise<string>((resolve) => setTimeout(() => resolve('item'), 2000))",
    ];
    for (const text of permitted) expect(RAW_WAIT_PATTERNS.some(({ pattern }) => pattern.test(text)), text).toBe(false);
  });

  it('releases the physical lease promptly when a retrying tower-up placement loop is cancelled', async () => {
    vi.useFakeTimers();
    // Feet start on stone at y=64. Pressing jump lifts the feet into the
    // placement window, but every placement is rejected, so the skill keeps
    // retrying (its try/catch swallows placeBlock errors). With raw timers the
    // cancelled body ran on for about 2.3 s on land while holding the lease.
    const solid = (position: Vec3) => ({ name: 'stone', boundingBox: 'block', position, diggable: true });
    const air = (position: Vec3) => ({ name: 'air', boundingBox: 'empty', position, diggable: false });
    const bot: any = Object.assign(new EventEmitter(), {
      executingSkill: false, interruptExecution: false,
      entity: { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, isInWater: false },
      blockAt: (pos: Vec3) => (pos.floored().y <= 63 ? solid(pos.floored()) : air(pos.floored())),
      inventory: { items: () => [{ name: 'cobblestone', count: 16, type: 1 }] },
      heldItem: { name: 'cobblestone' },
      equip: vi.fn(async () => {}),
      placeBlock: vi.fn(async () => { throw new Error('placement not acknowledged'); }),
      look: vi.fn(async () => {}),
      setControlState: vi.fn((control: string, state: boolean) => {
        if (control === 'jump' && state) bot.entity.position = new Vec3(0.5, 65.3, 0.5);
      }),
      getControlState: () => false,
      clearControlStates: vi.fn(), stopDigging: vi.fn(), deactivateItem: vi.fn(),
      pathfinder: { stop: vi.fn(), setGoal: vi.fn(), isMoving: () => false },
    });

    const tower = new TowerUp(bot);
    const running = tower.run(1);
    await vi.advanceTimersByTimeAsync(200);
    const attemptsBeforeCancel = bot.placeBlock.mock.calls.length;
    expect(attemptsBeforeCancel).toBeGreaterThan(0);

    cancelActiveActions(bot);
    expect(await running).toMatchObject({ success: false, failureType: 'interrupted' });

    let successorStarted = false;
    const successor = executeAction(bot, 'move-to', 0, async () => {
      successorStarted = true;
      return { success: true, result: 'moved' };
    });
    // Far below the ~2.3 s the old non-cooperative loop kept running.
    await vi.advanceTimersByTimeAsync(40);
    expect(successorStarted).toBe(true);
    expect(await successor).toMatchObject({ success: true });
    expect(bot.placeBlock.mock.calls.length).toBe(attemptsBeforeCancel);
    expect(bot.executingSkill).toBe(false);
  });
});
