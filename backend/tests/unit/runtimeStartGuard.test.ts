import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];
const sourceRoot = resolve(import.meta.dirname, '../../..');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'shannon-start-test-'));
  roots.push(root);
  for (const dir of ['scripts', 'backend', 'frontend', 'bin']) mkdirSync(join(root, dir));
  for (const file of ['scripts/start-mode-guard.sh', 'start.sh', 'backend/start.sh', 'frontend/start.sh']) {
    copyFileSync(join(sourceRoot, file), join(root, file));
    chmodSync(join(root, file), 0o755);
  }
  writeFileSync(join(root, '.shannon-development'), '');
  writeFileSync(join(root, '.dev-runtime-lock'), '');
  // If a guard regresses, never call real process killers, builders or servers.
  for (const command of ['tmux', 'lsof', 'npm', 'npx', 'node', 'sleep', 'taskkill', 'netstat']) {
    const file = join(root, 'bin', command);
    writeFileSync(file, '#!/bin/bash\necho attempted >> "' + join(root, 'side-effects') + '"\nexit 99\n');
    chmodSync(file, 0o755);
  }
  return root;
}

describe('development startup protection', () => {
  for (const entry of ['start.sh', 'backend/start.sh', 'frontend/start.sh']) {
    it(entry + ' refuses production mode before session/port cleanup', () => {
      const root = fixture();
      const result = spawnSync('bash', [join(root, entry)], {
        env: { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH },
        encoding: 'utf8', timeout: 2000,
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Refusing production-mode startup');
      expect(existsSync(join(root, 'side-effects'))).toBe(false);
    });
    it(entry + ' respects the live-runtime lock even with --dev', () => {
      const root = fixture();
      const result = spawnSync('bash', [join(root, entry), '--dev'], {
        env: { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH },
        encoding: 'utf8', timeout: 2000,
      });
      expect(result.status).toBe(3);
      expect(result.stderr).toContain('runtime is locked');
      expect(existsSync(join(root, 'side-effects'))).toBe(false);
    });
  }
  it('recognizes Shannon-dev through a backend/.. path without a marker', () => {
    const root = fixture();
    const dev = join(root, 'Shannon-dev');
    mkdirSync(join(dev, 'backend'), { recursive: true });
    const result = spawnSync('bash', [join(root, 'scripts/start-mode-guard.sh'), join(dev, 'backend') + '/..']);
    expect(result.status).toBe(2);
  });
  it('allows --dev only after the local runtime lock is removed', () => {
    const root = fixture();
    rmSync(join(root, '.dev-runtime-lock'));
    const result = spawnSync('bash', [join(root, 'scripts/start-mode-guard.sh'), root, '--dev']);
    expect(result.status).toBe(0);
  });
  it('does not change startup mode for unmarked production checkouts', () => {
    const root = fixture();
    rmSync(join(root, '.dev-runtime-lock'));
    rmSync(join(root, '.shannon-development'));
    expect(spawnSync('bash', [join(root, 'scripts/start-mode-guard.sh'), root]).status).toBe(0);
  });
});
