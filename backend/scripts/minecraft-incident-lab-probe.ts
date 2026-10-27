#!/usr/bin/env node
// The fix run's hold, end to end on a real isolated server and without any model (2026-10-28, owner: 「止めて直す実走」):
//   1. a go that the server will not let lay its blocks (adventure mode) stops `stuck`, sent as a held task's act (`context.incident.hold`);
//   2. the body writes its black box and the scene (save-all, the region/entities/poi files around it), stops the world (`/tick freeze`) and
//      holds the task: the next act of the task is refused;
//   3. the body is restarted (the bot leaves and a new one logs in, a new NativeCommonFcaBody): it is still held (the hold file), the world still
//      stopped, and it stands where it stood;
//   4. the cause is fixed (survival again) and the same act is sent with `context.incident.resume`: the world moves, the act passes;
//   5. the next act goes on;
//   6. (run 44, hold 1) someone else joins: a heavy failure of a held task is not held (the world cannot be stopped), its box and scene are
//      taken, the receipt says why, and the next act runs; then held again and cancelled.
// The body's own names are read at the freeze, as in production (the scene saver is made before the body logs in): the world is frozen with only
// the body (and the lab's operator, a spectator) on.
// The probe plays the head's part (it sends the commands the head would). Env (scripts/lab/run-incident-lab.sh): MINECRAFT_INCIDENT_NO_LLM=true,
// MINECRAFT_INCIDENT_PORT, MINECRAFT_INCIDENT_WORLD_DIRECTORY, MINECRAFT_INCIDENT_OUT (the box, the scene and the hold file go there), and
// MINECRAFT_INCIDENT_REPORT.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProbeBot, closeProbeBot } from '../src/services/minebot/testing/MinecraftProbeBot.js';
import { NativeCommonFcaBody } from '../src/services/minebot/integration/commonFca/nativeBody.js';
import { blackBoxOf } from '../src/services/minebot/utils/blackbox.js';
import { installIncidents } from '../src/services/minebot/utils/incidents.js';
import { SceneSaver, selfNames } from '../src/services/minebot/utils/sceneSave.js';

const port = Number(process.env.MINECRAFT_INCIDENT_PORT);
const worldDirectory = process.env.MINECRAFT_INCIDENT_WORLD_DIRECTORY ?? '';
const out = process.env.MINECRAFT_INCIDENT_OUT ?? '';
if (process.env.MINECRAFT_INCIDENT_NO_LLM !== 'true' || !Number.isInteger(port) || port < 25570 || port > 25599
  || !/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(worldDirectory) || !out) throw new Error('ISOLATED_INCIDENT_WORLD_REQUIRED');
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) if (process.env[key]) throw new Error(`INCIDENT_PROBE_REFUSES_PAID_KEY:${key}`);
if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'offline-test-not-used') throw new Error('INCIDENT_PROBE_REFUSES_PAID_KEY:OPENAI_API_KEY');

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const log = (text: string) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${text}`);
const ACTOR = 'MinebotTrial', FLOOR = 99;
const checks: Array<{ name: string; passed: boolean; detail: string }> = [];
const check = (name: string, passed: boolean, detail = '') => { checks.push({ name, passed, detail: detail.slice(0, 400) }); log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail.slice(0, 300)}` : ''}`); };

const operator: any = await createProbeBot(port);
async function ask(command: string, timeoutMs = 10_000): Promise<string> {
  const marker = `INCIDENTASK_${randomUUID().split('-').join('').slice(0, 10)}`;
  const seen: string[] = [];
  const answer = await new Promise<string>(resolve => {
    let timer: NodeJS.Timeout | undefined;
    const listener = (message: unknown) => { const text = String((message as any)?.toString?.() ?? ''); if (text.includes(marker)) done(); else seen.push(text); };
    const done = (suffix = '') => { if (timer) clearTimeout(timer); operator.removeListener('message', listener); resolve(seen.join('\n') + suffix); };
    timer = setTimeout(() => done('\n[timeout]'), timeoutMs);
    operator.on('message', listener);
    operator.chat(`/${command}`);
    operator.chat(`/tellraw @s ${JSON.stringify({ text: marker })}`);
  });
  await sleep(250);
  return answer;
}
const holdFile = path.join(out, 'hold.json');
const sceneRoot = path.join(out, 'scenes');
// Made before the body logs in, as production makes it (utils/incidents' incidentOptions): its own name is read at each freeze. The operator (the
// lab's hand, a spectator) is the only name it is told to pass over.
let current: any = null;
const scene = new SceneSaver({ command: (text, timeoutMs) => ask(text, timeoutMs), serverDir: worldDirectory, root: sceneRoot, self: () => selfNames(current),
  ignore: [operator.username] });

async function connect(): Promise<{ actor: any; body: NativeCommonFcaBody }> {
  const actor: any = await createProbeBot(port, ACTOR);
  current = actor;
  installIncidents(actor, { holdFile, scene });
  const body = new NativeCommonFcaBody(actor, { serverId: 'incident-lab', capture: async () => { throw new Error('no picture'); }, rendererConfigured: () => false });
  return { actor, body };
}
const TASK = 'incident-lab-task';
let commandNumber = 0;
async function act(body: NativeCommonFcaBody, args: Record<string, unknown>, incident: Record<string, unknown> | null, seconds = 90) {
  const id = `incident-lab-${++commandNumber}`;
  const command: any = { schemaVersion: 1, id, serverId: 'incident-lab', connectionId: 'incident-lab', kind: 'skill', skill: 'act', arguments: args,
    context: { scopeKey: 'lab', taskId: TASK, taskRevision: 1, bodyId: 'minecraft:incident-lab', sessionId: 'incident-session', generation: 1, goal: 'lab', completionCondition: 'none',
      ...(incident ? { incident } : {}) },
    lease: { id: 'incident-lease', generation: 1, holder: TASK }, deadlineAt: new Date(Date.now() + seconds * 1000).toISOString() };
  const started = Date.now();
  const receipt: any = await body.execute(command, new AbortController().signal);
  let parsed: any = null; try { parsed = JSON.parse(receipt.result ?? ''); } catch { parsed = null; }
  const lines = (parsed?.lines ?? []).map((line: any) => `${line.i}.${line.do} ${line.status}: ${line.line}`);
  log(`ACT ${id} ${((Date.now() - started) / 1000).toFixed(1)}s ${receipt.outcome} ${receipt.failureType ?? ''} ${(lines.at(-1) ?? String(receipt.result ?? '')).slice(0, 220)}`);
  return { id, receipt, parsed, lines, ms: Date.now() - started };
}
const tickState = async () => (await ask('tick query')).replace(/\s+/gu, ' ').slice(0, 200);

const report: Record<string, unknown> = { startedAt: new Date().toISOString() };
try {
  await ask('gamerule spawn_mobs false'); await ask('time set 6000'); await ask('weather clear');
  await ask('gamemode spectator ' + operator.username);
  await ask('fill -16 90 -16 16 99 16 minecraft:stone'); await ask('fill -16 100 -16 16 112 16 minecraft:air');
  // A gap of three across the whole arena (x 3..5, z -16..16), five deep, that the go must bridge with blocks (as hands-live's go_place_refused).
  const gap = await ask(`fill 3 95 -16 5 ${FLOOR} 16 minecraft:air`);
  log(`gap: ${gap.replace(/\s+/gu, ' ').slice(0, 120)}`);
  let { actor, body } = await connect();
  await ask(`tp ${ACTOR} 0.5 ${FLOOR + 1} 0.5`); await ask(`clear ${ACTOR}`); await ask(`give ${ACTOR} minecraft:cobblestone 16`);
  await ask(`gamemode adventure ${ACTOR}`); await sleep(2500);
  const goArgs = { hands: [{ do: 'go', to: { x: 9, y: FLOOR + 1, z: 0 }, canPlace: ['cobblestone'], maxPlace: 10, seconds: 60 }], why: '[lab] 穴を橋で渡る' };

  // 1–2: the held act fails heavy; the box, the scene, the freeze, the hold.
  const first = await act(body, goArgs, { hold: true });
  const incident = first.parsed?.incident;
  report.first = { lines: first.lines, incident, ms: first.ms };
  check('the go stops stuck (a heavy failure)', /go 止まった stuck/u.test(first.lines.join(' ')), first.lines.at(-1) ?? '');
  check('the receipt carries the incident, held and frozen', incident?.held === true && incident?.frozen === true && incident?.heavy === true, JSON.stringify(incident));
  check('with only the body on, the body is not counted as someone else (run 44)', incident?.frozen === true && !/others_present/u.test(String(incident?.freeze ?? '')), String(incident?.freeze ?? ''));
  const boxes = fs.existsSync(path.join(process.env.MINEBOT_BLACKBOX_DIR ?? '', TASK)) ? fs.readdirSync(path.join(process.env.MINEBOT_BLACKBOX_DIR ?? '', TASK)) : [];
  check('the black box was written under the task, with the incident id', boxes.some(file => file.startsWith(String(incident?.id))), boxes.join(','));
  const sceneDir = path.join(sceneRoot, String(incident?.id));
  const sceneFiles = fs.existsSync(path.join(sceneDir, 'scene.json')) ? JSON.parse(fs.readFileSync(path.join(sceneDir, 'scene.json'), 'utf8')) : null;
  check('the scene was saved with region, entities and level.dat', !!sceneFiles?.ok && sceneFiles.files.some((f: string) => f.includes('region')) && sceneFiles.files.includes('world/level.dat'),
    JSON.stringify({ files: sceneFiles?.files, saveMs: sceneFiles?.saveMs, copyMs: sceneFiles?.copyMs, bytes: sceneFiles?.bytes }));
  report.scene = sceneFiles; report.sceneDir = sceneDir;
  const frozenNow = await tickState();
  check('the world is frozen', /frozen/iu.test(frozenNow) && !/not frozen|running normally/iu.test(frozenNow), frozenNow);
  const second = await act(body, goArgs, null);
  check('the next act of the held task is refused (held)', second.receipt.failureType === 'held', String(second.receipt.result ?? '').slice(0, 200));
  const before = actor.entity?.position?.clone?.();

  // 3: the body is restarted.
  closeProbeBot(actor); await sleep(4000);
  ({ actor, body } = await connect()); await sleep(3000);
  const after = actor.entity?.position;
  check('after the restart the body stands where it stood', !!before && !!after && before.distanceTo(after) < 1.5, `${before} → ${after}`);
  check('after the restart the hold file is there', fs.existsSync(holdFile), fs.existsSync(holdFile) ? fs.readFileSync(holdFile, 'utf8').slice(0, 200) : 'none');
  const third = await act(body, goArgs, null);
  check('after the restart the act is still refused (held)', third.receipt.failureType === 'held', String(third.receipt.result ?? '').slice(0, 200));
  check('after the restart the world is still frozen', /frozen/iu.test(await tickState()));

  // 4: the cause fixed, the same act sent again with the resume.
  // The fix: survival again (the cause), and the body back where the act began (it stood at the rim of the gap: a go from there drops in, 5 down).
  await ask(`gamemode survival ${ACTOR}`); await ask(`tp ${ACTOR} 0.5 ${FLOOR + 1} 0.5`); await sleep(2000);
  const fourth = await act(body, goArgs, { resume: String(incident?.id) });
  report.resume = { lines: fourth.lines, ms: fourth.ms };
  check('the resumed act passes', fourth.receipt.outcome === 'completed', fourth.lines.at(-1) ?? '');
  const running = await tickState();
  check('the world moves again', !/frozen/iu.test(running) || /not frozen|running normally/iu.test(running), running);
  check('the hold file is gone', !fs.existsSync(holdFile));

  // 5: the next act goes on.
  const fifth = await act(body, { hands: [{ do: 'go', to: { x: 11, y: FLOOR + 1, z: 2 }, seconds: 30 }], why: '[lab] 続き' }, null);
  check('the next act goes on', fifth.receipt.outcome === 'completed', fifth.lines.at(-1) ?? '');
  // 6 (run 44): someone else on the server: the same heavy failure is not held. The box and the scene are taken, the world moves, and the task goes on.
  await ask(`fill 12 95 -16 14 ${FLOOR} 16 minecraft:air`); await ask(`gamemode adventure ${ACTOR}`); await sleep(1500);
  const visitor: any = await createProbeBot(port, 'LabVisitor'); await sleep(1500);
  const crowded = await act(body, { hands: [{ do: 'go', to: { x: 16, y: FLOOR + 1, z: 2 }, canPlace: ['cobblestone'], maxPlace: 10, seconds: 60 }], why: '[lab] ほかの人がいる時の穴' }, { hold: true });
  const notHeld = crowded.parsed?.incident;
  report.notHeld = notHeld ?? null;
  check('with someone else on, a heavy failure is not held: the receipt says why', notHeld?.heavy === true && notHeld?.held === false && notHeld?.frozen === false
    && /others_present:LabVisitor/u.test(String(notHeld?.notHeld ?? '')), JSON.stringify(notHeld ?? null));
  const crowdedScene = path.join(sceneRoot, String(notHeld?.id));
  check('with someone else on, the box and the scene are still taken', notHeld?.box === true && fs.existsSync(path.join(crowdedScene, 'scene.json')), crowdedScene);
  const crowdedTick = await tickState();
  check('with someone else on, the world is not frozen and no hold file is written', (!/frozen/iu.test(crowdedTick) || /running normally/iu.test(crowdedTick)) && !fs.existsSync(holdFile), crowdedTick);
  const goesOn = await act(body, { hands: [{ do: 'go', to: { x: 11, y: FLOOR + 1, z: 0 }, seconds: 30 }], why: '[lab] ほかの人がいても続く' }, { hold: true });
  check('with someone else on, the next act of the task runs (not refused)', goesOn.receipt.failureType !== 'held' && goesOn.receipt.outcome === 'completed', goesOn.lines.at(-1) ?? String(goesOn.receipt.result ?? '').slice(0, 200));
  closeProbeBot(visitor); await sleep(2500);
  // 7: alone again, held again, then the operator cancels the task (the head's release names the hold): the world moves again.
  const sixth = await act(body, { hands: [{ do: 'go', to: { x: 16, y: FLOOR + 1, z: 2 }, canPlace: ['cobblestone'], maxPlace: 10, seconds: 60 }], why: '[lab] 二つ目の穴' }, { hold: true });
  check('held again on the second gap', sixth.parsed?.incident?.held === true && /frozen/iu.test(await tickState()), JSON.stringify(sixth.parsed?.incident ?? null));
  check('the incident says where the act began and ended', Array.isArray(sixth.parsed?.incident?.start) && Array.isArray(sixth.parsed?.incident?.end), JSON.stringify([sixth.parsed?.incident?.start, sixth.parsed?.incident?.end]));
  const cancelled = await body.cancelIncident(String(sixth.parsed?.incident?.id));
  const afterCancel = await tickState();
  check('a cancel of the held task moves the world again and ends the hold', cancelled.done && !fs.existsSync(holdFile) && (!/frozen/iu.test(afterCancel) || /running normally/iu.test(afterCancel)), afterCancel);
  report.stats = blackBoxOf(actor)?.stats() ?? null;
  closeProbeBot(actor);
} catch (error) {
  check('the probe ran to its end', false, String((error as Error)?.stack ?? error).slice(0, 400));
} finally {
  try { await ask('tick unfreeze'); } catch { /* the server goes anyway */ }
  report.checks = checks;
  const passed = checks.length > 0 && checks.every(entry => entry.passed);
  if (process.env.MINECRAFT_INCIDENT_REPORT) fs.writeFileSync(process.env.MINECRAFT_INCIDENT_REPORT, JSON.stringify(report, null, 1));
  console.log(`INCIDENT_RESULT ${JSON.stringify({ passed, checks: checks.length, failed: checks.filter(entry => !entry.passed).map(entry => entry.name) })}`);
  closeProbeBot(operator);
  process.exit(passed ? 0 : 1);
}
