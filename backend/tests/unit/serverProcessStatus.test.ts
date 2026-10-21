import { describe, expect, it, vi } from 'vitest';
import { shannonHomeProcessStatus, type ServerStatusCommand } from '../../src/services/minecraft/serverProcessStatus.js';

const unit = (load = 'loaded', active = 'inactive', sub = 'dead', pid = 0) =>
  `LoadState=${load}\nActiveState=${active}\nSubState=${sub}\nMainPID=${pid}\n`;
const absent = () => Object.assign(Error('missing tmux'), { code: 1, stderr: 'error connecting to /tmp/tmux-1000/shannon-home (No such file or directory)\n' });
function commands(show: string | Error, legacy: 'running' | Error = absent()) {
  return vi.fn<Parameters<ServerStatusCommand>, ReturnType<ServerStatusCommand>>(async (file) => {
    if (file === 'systemctl') { if (show instanceof Error) throw show; return show; }
    if (legacy instanceof Error) throw legacy;
    return '';
  });
}

describe('fixed dedicated-home process ownership without adopting the running legacy world', () => {
  it('observes an active direct Java unit without requiring a tmux session', async () => {
    const run = commands(unit('loaded', 'active', 'running', 42));
    expect(await shannonHomeProcessStatus(run)).toBe('running');
    expect(run.mock.calls).toEqual([['systemctl', ['show', 'shannon-home.service', '--no-pager',
      '--property=LoadState', '--property=ActiveState', '--property=SubState', '--property=MainPID']]]);
  });
  it.each(['loaded', 'not-found'])('preserves a running legacy tmux when the unit is %s and inactive', async load => {
    const run = commands(unit(load), 'running');
    expect(await shannonHomeProcessStatus(run)).toBe('running');
    expect(run.mock.calls[1]).toEqual(['tmux', ['-L', 'shannon-home', 'has-session', '-t', '=shannon-home']]);
  });
  it.each(['loaded', 'not-found'])('establishes stopped only when the %s unit and exact legacy session are absent', async load => {
    expect(await shannonHomeProcessStatus(commands(unit(load)))).toBe('stopped');
  });
  // 2026-10-21: systemd SIGKILLed a shutdown that never ended (Result=timeout) and left ActiveState=failed, SubState=failed, MainPID=0.
  // The body read that as unknown and refused every later start (state_unknown).
  it.each(['loaded', 'not-found'])('establishes stopped for a %s unit that systemd killed after TimeoutStopSec (failed/failed, MainPID 0)', async load => {
    const run = commands(unit(load, 'failed', 'failed', 0));
    expect(await shannonHomeProcessStatus(run)).toBe('stopped');
    expect(run.mock.calls[1]).toEqual(['tmux', ['-L', 'shannon-home', 'has-session', '-t', '=shannon-home']]);
  });
  it.each([
    unit('loaded', 'failed', 'failed', 42), unit('loaded', 'failed', 'dead', 0), unit('loaded', 'inactive', 'failed', 0),
    unit('loaded', 'activating', 'start', 42), unit('loaded', 'activating', 'start', 0),
    unit('loaded', 'deactivating', 'stop-sigterm', 42), unit('loaded', 'deactivating', 'stop-sigterm', 0), unit('loaded', 'deactivating', 'final-sigkill', 0),
    unit('loaded', 'active', 'exited'), unit('loaded', 'active', 'running', 0), unit('loaded', 'reloading', 'reload', 0), unit('masked'), unit('masked', 'failed', 'failed'),
  ])('retains an ambiguous unit state as unknown when legacy is absent (%s)', async state => {
    expect(await shannonHomeProcessStatus(commands(state))).toBe('unknown');
  });
  it('can still observe the original tmux world beside a failed unit without launching either', async () => {
    expect(await shannonHomeProcessStatus(commands(unit('loaded', 'failed', 'failed'), 'running'))).toBe('running');
  });
  it('does not call a failed unit stopped when the old tmux session cannot be proven absent', async () => {
    const unreadable = Object.assign(Error('permission'), { code: 1, stderr: 'error connecting to /tmp/tmux-1000/shannon-home (Permission denied)\n' });
    expect(await shannonHomeProcessStatus(commands(unit('loaded', 'failed', 'failed'), unreadable))).toBe('unknown');
    expect(await shannonHomeProcessStatus(commands(unit('loaded', 'failed', 'failed'), Object.assign(absent(), { killed: true, signal: 'SIGTERM' })))).toBe('unknown');
  });
  it.each([
    Object.assign(Error('permission'), { code: 1, stderr: 'error connecting to /tmp/tmux-1000/shannon-home (Permission denied)\n' }),
    Object.assign(Error('timeout'), { code: 1, killed: true, stderr: '' }),
    Object.assign(Error('missing binary'), { code: 'ENOENT' }),
    Object.assign(absent(), { killed: true, signal: 'SIGTERM' }),
  ])('never converts a failed legacy status read into stopped (%s)', async error => {
    expect(await shannonHomeProcessStatus(commands(unit(), error))).toBe('unknown');
  });
  it.each([Error('systemctl permission'), Error('systemctl timeout'), 'LoadState=loaded\n',
    unit() + 'MainPID=0\n', unit().replace('MainPID=0', 'MainPID=-1')])('does not infer stopped from malformed or failed unit reads (%s)', async state => {
    const run = commands(state);
    expect(await shannonHomeProcessStatus(run)).toBe('unknown');
    expect(run).toHaveBeenCalledOnce();
  });
});
