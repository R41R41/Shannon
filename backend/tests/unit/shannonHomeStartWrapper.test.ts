import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const wrapper = fileURLToPath(new URL('../../../deploy/shannon-home-start.sh.template', import.meta.url));
let sandbox: string;
beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'shannon-home-wrapper-offline-'));
  const scripts = {
    systemctl: '#!/bin/sh\n[ "$MOCK_STATUS_FAIL" != yes ] || exit 1\nprintf "%s\\n" "$MOCK_LOAD"\n',
    ss: '#!/bin/sh\n[ "$MOCK_PORT_FAIL" != yes ] || exit 1\nprintf "%s" "$MOCK_LISTENER"\n',
    sudo: '#!/bin/sh\nprintf "%s\\n" "$@" > "$MOCK_RECORD"\n',
  };
  for (const [name, script] of Object.entries(scripts)) writeFileSync(path.join(sandbox, name), script, { mode: 0o700 });
});
afterEach(() => rmSync(sandbox, { recursive: true, force: true }));
function run(extra: Record<string, string> = {}) {
  return execFileSync('/bin/sh', [wrapper], { env: { PATH: sandbox, MOCK_LOAD: 'loaded', MOCK_RECORD: path.join(sandbox, 'record'), ...extra }, stdio: 'pipe' });
}
describe('reviewed fixed-unit start wrapper using only fake OS commands', () => {
  it('hands off only the exact noninteractive start authority after loaded and no listener', () => {
    run();
    expect(readFileSync(path.join(sandbox, 'record'), 'utf8')).toBe('-n\n/usr/bin/systemctl\nstart\nshannon-home.service\n');
  });
  const rejected: Record<string, string>[] = [
    { MOCK_LOAD: 'not-found' }, { MOCK_LOAD: 'failed' }, { MOCK_STATUS_FAIL: 'yes' },
    { MOCK_PORT_FAIL: 'yes' }, { MOCK_LISTENER: 'LISTEN 0 4096 *:25560 *:*' },
  ];
  it.each(rejected)('never starts on absent/uncertain unit or an existing home listener (%s)', extra => {
    expect(() => run(extra)).toThrow();
    expect(() => readFileSync(path.join(sandbox, 'record'))).toThrow();
  });
});
