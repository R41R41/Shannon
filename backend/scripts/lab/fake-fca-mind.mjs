// A stand-in for Shannon's mind (the shannon-ios API) for trying the common FCA body and ShannonUIMod on one PC.
// It speaks just enough of the body contract: POST /v1/body/minecraft/control (the body's poll; answered with commands)
// and POST /v1/body/minecraft/turns (what a player wrote to her; answered with a reply and, for "止まって", a stop).
// Loopback only, no model, no real data. Not the real mind: it only gives the body some read-only work to show.
//
//   node backend/scripts/lab/fake-fca-mind.mjs [port=4329] [token-file=fake-mind.token]
//   curl -X POST http://127.0.0.1:4329/admin/task -d '{"goal":"木を見て回る","steps":6}'   # start a task
//   curl http://127.0.0.1:4329/admin/state                                                  # what it saw
import http from 'node:http';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const READ_ONLY_PREFERENCE = ['get-health', 'get-position', 'get-time-and-weather', 'get-bot-status', 'list-inventory-items'];

export function createFakeMind({ token, stepDelayMs = 1500, now = () => Date.now() } = {}) {
  if (!token || token.length < 16) throw new Error('token of 16+ characters required');
  const state = { polls: 0, turns: [], receipts: [], commands: [], task: null, catalog: [], serverId: null, connectionId: null, bodyId: null, pending: [], seen: new Set() };
  let nextStepAt = 0;
  const readOnlySkills = () => {
    const names = state.catalog.filter(skill => skill.readOnly).map(skill => skill.name);
    const preferred = READ_ONLY_PREFERENCE.filter(name => names.includes(name));
    return preferred.length ? preferred : names.slice(0, 3);
  };
  const context = task => ({ scopeKey: 'owner', taskId: task.id, taskRevision: 1, bodyId: state.bodyId, sessionId: task.sessionId, generation: 1,
    goal: task.goal, completionCondition: '検証用の読み取りを終える',
    taskState: { phase: task.finished ? 'done' : 'running', progress: `${task.done}/${task.steps}`, recentResults: task.results.slice(-5) } });
  const command = (kind, extra = {}) => ({ schemaVersion: 1, id: `fake-${randomUUID()}`, serverId: state.serverId, connectionId: state.connectionId, kind,
    context: context(state.task), lease: { id: `lease-${state.task.id}`, generation: 1, holder: state.task.id },
    deadlineAt: new Date(now() + 30_000).toISOString(), ...extra });

  function startTask(goal, steps) {
    state.task = { id: `task-${randomUUID().slice(0, 8)}`, sessionId: `session-${randomUUID().slice(0, 8)}`, goal, steps, done: 0, issued: 0, results: [], inFlight: null, finished: false };
    nextStepAt = 0;
  }

  function onReceipts(receipts) {
    for (const receipt of receipts ?? []) {
      if (state.seen.has(receipt.id)) continue;
      state.seen.add(receipt.id);
      state.receipts.push({ id: receipt.id, outcome: receipt.outcome, result: String(receipt.result ?? '').slice(0, 120) });
      const task = state.task;
      if (task?.inFlight === receipt.id) {
        task.inFlight = null; task.done += 1;
        task.results.push({ name: task.inFlightSkill, ok: receipt.outcome === 'completed', summary: String(receipt.result ?? receipt.outcome).slice(0, 80) });
      }
    }
  }

  function nextCommands() {
    const out = [...state.pending.splice(0)];
    const task = state.task;
    if (!task || task.finished || task.inFlight || now() < nextStepAt) return out;
    if (task.issued >= task.steps) {
      task.finished = true;
      out.push(command('release'));
      return out;
    }
    const skills = readOnlySkills();
    if (!skills.length) return out;
    task.inFlightSkill = skills[task.issued % skills.length];
    const next = command('skill', { skill: task.inFlightSkill, arguments: {} });
    task.inFlight = next.id; task.issued += 1; nextStepAt = now() + stepDelayMs;
    out.push(next);
    return out;
  }

  function control(poll) {
    state.polls += 1;
    state.serverId = poll.serverId; state.connectionId = poll.connectionId; state.bodyId = poll.observation?.bodyId ?? state.bodyId;
    if (Array.isArray(poll.skills)) state.catalog = poll.skills;
    onReceipts(poll.receipts);
    const commands = state.bodyId ? nextCommands() : [];
    for (const item of commands) state.commands.push({ kind: item.kind, skill: item.skill, id: item.id });
    return { schemaVersion: 1, mode: 'common-fca', commands: commands.slice(0, 8), cancel: [], acknowledged: (poll.receipts ?? []).map(receipt => receipt.id) };
  }

  function turn(body) {
    state.turns.push({ speaker: body.speaker?.name, message: body.message });
    const message = String(body.message ?? '');
    if (/止まって|やめて/.test(message) && state.task && !state.task.finished && state.bodyId) {
      const reason = /やめて/.test(message) ? 'cancel' : 'handoff';
      state.task.finished = true;
      state.pending.push(command('stop', { stop: { requestId: `stop-${randomUUID().slice(0, 8)}`, reason, context: context(state.task) } }));
      return { reply: '止まったよ。（偽の心）', intent: { kind: 'stop', goal: '' }, duplicate: false };
    }
    if (/続けて|ついてきて|来て|ちょうだい/.test(message)) {
      if (!state.task || state.task.finished) startTask(`「${message.slice(0, 20)}」への応え（検証用）`, 4);
      return { reply: `うん、やってみるね。（偽の心: ${message.slice(0, 30)}）`, intent: { kind: 'none', goal: '' }, duplicate: false };
    }
    return { reply: `聞こえたよ。（偽の心: ${message.slice(0, 40)}）`, intent: { kind: 'none', goal: '' }, duplicate: false };
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      let body = {};
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { return send(400, { error: 'bad json' }); }
      const path = String(req.url).split('?')[0];
      if (path.startsWith('/admin/')) {
        if (path === '/admin/state') return send(200, { polls: state.polls, turns: state.turns, receipts: state.receipts.slice(-20), commands: state.commands.slice(-20), task: state.task && { id: state.task.id, goal: state.task.goal, done: state.task.done, steps: state.task.steps, finished: state.task.finished }, catalog: state.catalog.length });
        if (path === '/admin/task' && req.method === 'POST') { startTask(String(body.goal ?? '検証用のタスク').slice(0, 80), Math.min(30, Number(body.steps) || 5)); return send(200, { ok: true }); }
        return send(404, { error: 'unknown admin route' });
      }
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthenticated' });
      if (req.method !== 'POST') return send(405, { error: 'method' });
      if (path === '/v1/body/minecraft/control') return send(200, control(body));
      if (path === '/v1/body/minecraft/turns') return send(200, turn(body));
      if (path === '/v1/body/minecraft/claim') return send(200, { request: null, cancel: [] });
      if (path === '/v1/body/events') return send(200, { stored: true });
      return send(404, { error: 'unknown route' });
    });
  });
  return { server, state, startTask, control, turn };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('fake-fca-mind.mjs')) {
  const port = Number(process.argv[2] ?? 4329);
  const tokenFile = process.argv[3] ?? 'fake-mind.token';
  if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, randomUUID() + randomUUID(), { mode: 0o600 });
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const mind = createFakeMind({ token });
  mind.server.listen(port, '127.0.0.1', () => console.log(`fake mind on http://127.0.0.1:${port} (token file: ${tokenFile})`));
}
