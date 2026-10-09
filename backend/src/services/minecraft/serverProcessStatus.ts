import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export type ServerProcessStatus = 'running' | 'stopped' | 'unknown';
export type ServerStatusCommand = (file: string, args: readonly string[]) => Promise<string>;
const exec = promisify(execFile);
const run: ServerStatusCommand = async (file, args) => (await exec(file, [...args], { timeout: 2000, maxBuffer: 8192 })).stdout;
const UNIT = 'shannon-home.service';

/** A fixed home unit, with the old dedicated tmux still observed until its owner-controlled shutdown. No adoption or actuator. */
export async function shannonHomeProcessStatus(command: ServerStatusCommand = run): Promise<ServerProcessStatus> {
  let unitStopped = false;
  try {
    const text = await command('systemctl', ['show', UNIT, '--no-pager', '--property=LoadState', '--property=ActiveState', '--property=SubState', '--property=MainPID']);
    const fields = new Map<string, string>();
    for (const line of text.trim().split(/\r?\n/)) {
      const pair = /^(LoadState|ActiveState|SubState|MainPID)=(.*)$/.exec(line);
      if (!pair || fields.has(pair[1])) return 'unknown';
      fields.set(pair[1], pair[2]);
    }
    if (fields.size !== 4 || !/^\d+$/.test(fields.get('MainPID')!)) return 'unknown';
    const loaded = fields.get('LoadState'), active = fields.get('ActiveState'), sub = fields.get('SubState'), pid = Number(fields.get('MainPID'));
    if (!Number.isSafeInteger(pid)) return 'unknown';
    if (loaded === 'loaded' && active === 'active' && sub === 'running' && pid > 0) return 'running';
    unitStopped = (loaded === 'loaded' || loaded === 'not-found') && active === 'inactive' && sub === 'dead' && pid === 0;
  } catch { return 'unknown'; } // A failed systemctl read cannot establish that the dedicated process is absent.
  try {
    await command('tmux', ['-L', 'shannon-home', 'has-session', '-t', '=shannon-home']);
    return 'running';
  } catch (error) {
    const failed = error as { code?: unknown; stderr?: unknown; killed?: unknown; signal?: unknown };
    const missing = typeof failed.stderr === 'string' && /^(?:error connecting to [^\r\n]+ \(No such file or directory\)|no server running on [^\r\n]+|can't find session: shannon-home)\s*$/.test(failed.stderr);
    return unitStopped && failed.code === 1 && failed.killed !== true && failed.signal == null && missing ? 'stopped' : 'unknown';
  }
}
