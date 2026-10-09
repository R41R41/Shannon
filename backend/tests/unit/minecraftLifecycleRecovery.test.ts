import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { LifecycleOperationJournal, MinecraftLifecycleOperator } from '../../src/services/integration/minecraftLifecycleOperator.js';
import { MinecraftLifecycleNative } from '../../src/services/integration/minecraftLifecycleNative.js';
import type { MinecraftLifecycleCommand, MinecraftLifecycleReceipt } from '../../src/services/integration/minecraftLifecycleContract.js';
import { reconcileReviewedOriginal } from '../../../scripts/reconcile-minecraft-lifecycle-receipt.mjs';

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-recovery-')); temporary.push(dir);
  const file = path.join(dir, 'journal.json'), journal = new LifecycleOperationJournal(file), base = Date.now() - 10000;
  const time = (offset: number) => new Date(base + offset).toISOString();
  const command: MinecraftLifecycleCommand = { schemaVersion: 1, id: 'original:start', serverId: 'home', connectionId: 'original:connection', action: 'start',
    authority: { scopeKey: 'owner', origin: 'owner_request', executionId: 'ops:original', lease: { id: 'original:action', holder: 'worker', generation: 3 }, sourceIds: ['ops:original'] },
    issuedAt: time(0), deadlineAt: time(2000) };
  const unknown: MinecraftLifecycleReceipt = { id: command.id, serverId: command.serverId, connectionId: command.connectionId, action: command.action,
    outcome: 'unknown', code: 'error', inputsReleased: false, observedAt: time(1000),
    state: { serverId: 'home', observedAt: time(1000), running: 'stopped', bot: 'absent', otherPlayers: 0 } };
  const receipt: MinecraftLifecycleReceipt = { ...unknown, outcome: 'refused', inputsReleased: true, observedAt: time(3000), state: { ...unknown.state, observedAt: time(3000) } };
  const review = { reviewedBy: 'release-operator', evidenceSha256: 'a'.repeat(64) };
  journal.begin(command); journal.settle(unknown);
  return { dir, file, journal, command, unknown, receipt, review, time };
}
describe('reviewed original lifecycle receipts', () => {
  it('retains original unknown history and authority while persisting one terminal revision', () => {
    const f = fixture(); expect(f.journal.held).toBe(true);
    f.journal.reconcileOriginalReceipt(f.unknown, f.receipt, f.review);
    const restored = new LifecycleOperationJournal(f.file), row = restored.entries.get(f.command.id)!;
    expect(row.command).toEqual(f.command); expect(row.receipt).toEqual(f.receipt);
    expect(row.receiptHistory).toEqual([f.unknown]); expect(row.receiptReview).toEqual(f.review); expect(restored.held).toBe(false);
    expect(restored.begin(f.command)).toBe(false);
    expect(() => restored.reconcileOriginalReceipt(f.receipt, { ...f.receipt, observedAt: f.time(4000) }, f.review)).toThrow('REVIEW_REJECTED');
    expect(() => restored.settle(f.unknown)).toThrow('RECEIPT_CONFLICT');
    restored.settle(f.receipt); expect(restored.entries.get(f.command.id)?.receiptHistory).toEqual([f.unknown]);
  });
  it.each(['id', 'connectionId', 'serverId', 'action', 'stateServer', 'sameTime', 'earlyState', 'futureState', 'futureReceipt', 'notReleased', 'unknown', 'invalidCode', 'falseSuccess', 'unreviewed', 'staleCAS'])('rejects %s without changing journal bytes or held state', scenario => {
    const f = fixture(), before = fs.readFileSync(f.file, 'utf8');
    const receipt = structuredClone(f.receipt), expected = structuredClone(f.unknown), review = { ...f.review };
    if (scenario === 'id') receipt.id = 'foreign';
    if (scenario === 'connectionId') receipt.connectionId = 'foreign';
    if (scenario === 'serverId') receipt.serverId = 'foreign';
    if (scenario === 'action') receipt.action = 'stop';
    if (scenario === 'stateServer') receipt.state.serverId = 'foreign';
    if (scenario === 'sameTime') receipt.observedAt = f.unknown.observedAt;
    if (scenario === 'earlyState') receipt.state.observedAt = f.time(-1);
    if (scenario === 'futureState') receipt.state.observedAt = f.time(4000);
    if (scenario === 'futureReceipt') receipt.observedAt = new Date(Date.now() + 60000).toISOString();
    if (scenario === 'notReleased') receipt.inputsReleased = false;
    if (scenario === 'unknown') receipt.outcome = 'unknown';
    if (scenario === 'invalidCode') (receipt as any).code = 'invented';
    if (scenario === 'falseSuccess') { receipt.outcome = 'completed'; receipt.code = 'changed'; }
    if (scenario === 'unreviewed') review.evidenceSha256 = '';
    if (scenario === 'staleCAS') expected.code = 'state_unknown';
    expect(() => f.journal.reconcileOriginalReceipt(expected, receipt, review)).toThrow('REVIEW_REJECTED');
    expect(fs.readFileSync(f.file, 'utf8')).toBe(before); expect(f.journal.held).toBe(true);
  });
  it('never lets normal settle or a restart infer resolution from matching state', () => {
    const f = fixture(); expect(() => f.journal.settle(f.receipt)).toThrow('RECEIPT_CONFLICT');
    expect(new LifecycleOperationJournal(f.file).held).toBe(true);
    expect(new LifecycleOperationJournal(f.file).entries.get(f.command.id)?.receipt).toEqual(f.unknown);
  });
  it('reopens only original receipt transmission after an unknown ACK, without native effects', async () => {
    const f = fixture(), bodies: any[] = [], effects: string[] = [];
    const native = new MinecraftLifecycleNative({ serverId: 'home', botUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146', onlineMode: true,
      processState: async () => 'stopped', command: async () => { throw Object.assign(Error('closed'), { code: 'ECONNREFUSED' }); },
      botState: () => ({ phase: 'absent', serverId: null, uuid: null }), authorize: async () => true,
      start: async () => { effects.push('start'); }, login: async () => { effects.push('login'); }, logout: async () => { effects.push('logout'); } });
    const operator = new MinecraftLifecycleOperator({ baseUrl: 'http://fixture.invalid', token: 'fixture', native, journal: f.journal,
      fetcher: (async (_url, init) => { const body = JSON.parse(String(init?.body)); bodies.push(body);
        return new Response(JSON.stringify({ schemaVersion: 1, commands: [], cancel: [], acknowledged: body.receipts.map((r: any) => r.id) })); }) as typeof fetch });
    await operator.poll(); await operator.poll(); expect(bodies[1].receipts).toEqual([]);
    operator.reconcileOriginalReceipt(f.unknown, f.receipt, f.review);
    await operator.poll(); await operator.poll();
    expect(bodies[2].receipts).toEqual([f.receipt]); expect(bodies[3].receipts).toEqual([]); expect(effects).toEqual([]);
    expect(f.journal.entries.get(f.command.id)?.command.authority).toEqual(f.command.authority); operator.stop();
  });
  it('CLI requires explicit review, a stopped original PID and exact CAS; it never calls the actuator', async () => {
    const f = fixture(), reviewFile = path.join(f.dir, 'review.json');
    fs.writeFileSync(reviewFile, JSON.stringify({ expectedUnknown: f.unknown, receipt: f.receipt, review: f.review }));
    const args = ['--journal', f.file, '--review', reviewFile, '--stopped-operator-pid', '123456', '--apply-reviewed-original'];
    const before = fs.readFileSync(f.file, 'utf8');
    await expect(reconcileReviewedOriginal(args, { Journal: LifecycleOperationJournal, processExists: () => undefined })).rejects.toThrow('NOT_STOPPED');
    await expect(reconcileReviewedOriginal(args.slice(0, -1), { Journal: LifecycleOperationJournal })).rejects.toThrow('ARGUMENTS');
    await expect(reconcileReviewedOriginal(args, { Journal: LifecycleOperationJournal, processExists: () => { throw Object.assign(Error('denied'), { code: 'EPERM' }); } })).rejects.toThrow('denied');
    expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
    const dependencies = { Journal: LifecycleOperationJournal, processExists: () => { throw Object.assign(Error('absent'), { code: 'ESRCH' }); } };
    expect(await reconcileReviewedOriginal(args, dependencies)).toEqual({ id: f.command.id, receiptRevised: true, actuatorInvoked: false });
    await expect(reconcileReviewedOriginal(args, dependencies)).rejects.toThrow('REVIEW_REJECTED');
  });
});
describe('fixed home start permission assets', () => {
  const deploy = path.resolve(process.cwd(), '../deploy');
  it('grants only the exact azureuser, systemd unit and start verb', () => {
    let rule: (action: any, subject: any) => unknown = () => { throw Error('missing rule'); };
    vm.runInNewContext(fs.readFileSync(path.join(deploy, '49-shannon-home-start.rules'), 'utf8'),
      { polkit: { Result: { YES: 'YES' }, addRule: (value: typeof rule) => { rule = value; } } });
    const grant = (id = 'org.freedesktop.systemd1.manage-units', user = 'azureuser', unit = 'shannon-home.service', verb = 'start') => rule({ id, lookup: (key: string) => ({ unit, verb }[key]) }, { user });
    expect(grant()).toBe('YES');
    for (const verb of ['stop', 'restart', 'reload', 'kill', 'set-property', '']) expect(grant(undefined, undefined, undefined, verb)).toBeUndefined();
    expect(grant(undefined, 'foreign')).toBeUndefined(); expect(grant(undefined, undefined, 'shannon.service')).toBeUndefined();
    expect(grant('org.freedesktop.systemd1.manage-unit-files')).toBeUndefined();
  });
  it('preserves NNP and passes only fixed noninteractive start argv, refusing an existing listener', () => {
    const f = fixture(), wrapper = fs.readFileSync(path.join(deploy, 'shannon-home-start.sh.template'), 'utf8');
    expect(wrapper).toContain('exec /usr/bin/systemctl --no-ask-password start shannon-home.service');
    expect(wrapper).not.toMatch(/exec sudo|NoNewPrivileges=no|--ask-password/);
    execFileSync('/bin/sh', ['-n', path.join(deploy, 'shannon-home-start.sh.template')]);
    const mock = path.join(f.dir, 'systemctl'), trace = path.join(f.dir, 'trace'), script = path.join(f.dir, 'start.sh');
    fs.writeFileSync(mock, `#!/bin/sh
if [ "$1" = show ]; then echo loaded; exit 0; fi
printf '%s\n' "$@" > "$TRACE"
grep '^NoNewPrivs:' /proc/$$/status >> "$TRACE"
`); fs.chmodSync(mock, 0o700);
    fs.writeFileSync(path.join(f.dir, 'ss'), `#!/bin/sh
printf "%s" "$LISTENER"
`); fs.chmodSync(path.join(f.dir, 'ss'), 0o700);
    // Only the fixture copy executes; its final absolute binary is replaced by our temp mock.
    fs.writeFileSync(script, wrapper.replace('/usr/bin/systemctl', mock)); fs.chmodSync(script, 0o700);
    const env = { ...process.env, PATH: `${f.dir}:${process.env.PATH}`, TRACE: trace, LISTENER: '' };
    execFileSync('/usr/bin/setpriv', ['--no-new-privs', '/bin/sh', script], { env });
    expect(fs.readFileSync(trace, 'utf8')).toBe('--no-ask-password\nstart\nshannon-home.service\nNoNewPrivs:\t1\n');
    fs.unlinkSync(trace);
    expect(() => execFileSync('/usr/bin/setpriv', ['--no-new-privs', '/bin/sh', script], { env: { ...env, LISTENER: 'existing-world' }, stdio: 'pipe' })).toThrow();
    expect(fs.existsSync(trace)).toBe(false);
  });
});
