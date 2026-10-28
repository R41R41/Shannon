import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { GoalOutcome, RunEnd } from '../../../src/services/minebot/integration/commonFca/continueContract.js';

/** The fixtures of the continue contracts (tests/fixtures/continue): the manifest says each file's hash (the body's copy equals the head's). */
export const FIXTURE_ROOT = path.resolve(__dirname, '../../fixtures/continue');
export function fixture<T = any>(name: string): T { return JSON.parse(readFileSync(path.join(FIXTURE_ROOT, name), 'utf8')) as T; }

interface Row { goal: GoalOutcome; end: RunEnd; released: boolean; dependState: 'succeeded' | 'failed' | 'pending' | 'unknown' }
/** The dependency table (the source of truth for both sides): the rows and the combinations that are not allowed. */
export function parseDependencyTable(): { outcomes: Row[]; notAllowed: Array<{ goal: GoalOutcome; end: RunEnd }> } {
  const table = fixture('continue/dependency-table.json');
  return { outcomes: table.outcomes, notAllowed: table.notAllowed };
}
