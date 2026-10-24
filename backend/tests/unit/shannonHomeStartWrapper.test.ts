import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const wrapper = fileURLToPath(new URL('../../../deploy/shannon-home-start.sh.template', import.meta.url));
const client = fileURLToPath(new URL('../../../deploy/shannon-home-start-client.py', import.meta.url));

// The client talks to fixed absolute paths (/usr/bin/systemctl, /usr/bin/ss, /run/...), so the
// harness loads it as a module and replaces the four things that touch the OS.
const harness = `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location('client', sys.argv[1])
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)
calls = []
def command(args, timeout=3):
    calls.append(args[0].rsplit('/', 1)[1])
    if args[0] == '/usr/bin/systemctl':
        return os.environ['MOCK_SHOW']
    if args[0] == '/usr/bin/ss':
        return os.environ.get('MOCK_LISTENER', '')
    raise AssertionError(args)
client.command = command
client.process_tick = lambda pid: '1'
client.publish = lambda request, payload: calls.append('publish') or ('dev', 'ino', payload['nonce'])
client.wait_ready = lambda *args: calls.append('wait')
error = None
try:
    client.main()
except Exception as exc:
    error = str(exc)
print(json.dumps({'calls': calls, 'error': error}))
`;

function run(show: string, listener = '') {
  const out = execFileSync('/usr/bin/python3', ['-I', '-c', harness, client], {
    env: { MOCK_SHOW: show, MOCK_LISTENER: listener },
    encoding: 'utf8',
  });
  return JSON.parse(out) as { calls: string[]; error: string | null };
}
const show = (load: string, active: string, pid: string) => `LoadState=${load}\nActiveState=${active}\nMainPID=${pid}`;

describe('reviewed fixed-unit start wrapper', () => {
  it('only runs the fixed client under python -I, with no arguments and no privilege change', () => {
    const lines = readFileSync(wrapper, 'utf8').split(/\r?\n/).filter(line => line && !line.startsWith('#'));
    expect(lines).toEqual(['set -eu', 'exec /usr/bin/python3 -I /usr/local/libexec/shannon-home-start-client.py']);
  });
});

describe('home start client with fake OS commands', () => {
  it.each(['inactive', 'failed'])('publishes one request when the unit is loaded, %s, MainPID 0 and nothing listens', active => {
    expect(run(show('loaded', active, '0'))).toEqual({ calls: ['systemctl', 'ss', 'publish', 'wait'], error: null });
  });

  const rejected: [string, string, string][] = [
    ['not loaded', show('not-found', 'inactive', '0'), ''],
    ['active', show('loaded', 'active', '0'), ''],
    ['still has a main process', show('loaded', 'inactive', '123'), ''],
    ['unit state unreadable (field missing)', 'LoadState=loaded\nActiveState=inactive', ''],
    ['unit state unreadable (field repeated)', `${show('loaded', 'inactive', '0')}\nMainPID=0`, ''],
    ['an existing home listener', show('loaded', 'inactive', '0'), 'LISTEN 0 4096 *:25560 *:*'],
  ];
  it.each(rejected)('never publishes a request: %s', (_name, output, listener) => {
    const result = run(output, listener);
    expect(result.error).not.toBeNull();
    expect(result.calls).not.toContain('publish');
  });
});
