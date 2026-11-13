// Halcyon's Minecraft body: the production minebot's body path (common FCA: NativeCommonFcaBody + CommonFcaControlLoop polling the
// head's POST /v1/body/minecraft/control), run alone, without Discord, Mongo, the UI mod or the renderer. Her head (halcyon-head,
// 127.0.0.1:4329) decides; this process only acts and reports. The same shape as the rig's body (halcyon-head
// scripts/minecraft-trials/rig.py, rig-body-run.ts), with the paired device token of halcyon-home instead of the rig's.
//
// Also, as the production bot does on its companion world: a game-chat line that starts with her name goes to the head as a turn
// (POST /v1/body/minecraft/turns) and the reply is said in chat; her death goes to POST /v1/body/events.
//
// Every minute (and once at start) her day's spend is checked against HALCYON_MINECRAFT_DAILY_USD (scripts/halcyon/budget-guard.py);
// over it, the body leaves the world and the process ends with code 3 (systemd does not restart it).
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createProbeBot, closeProbeBot } from '../../src/services/minebot/testing/MinecraftProbeBot.js';
import { NativeCommonFcaBody } from '../../src/services/minebot/integration/commonFca/nativeBody.js';
import { CommonFcaControlLoop } from '../../src/services/minebot/integration/commonFca/controlLoop.js';
import { CompanionBodyClient } from '../../src/services/minebot/integration/CompanionBodyClient.js';
import { listenToPlayerChat, isAddressedToShannon as isAddressedToHer } from '../../src/services/minebot/integration/gameChat.js';
import { companionBodyNow, othersOnline, speakCompanionReply, takeCompanionTurn, watchCompanionBodyEvents }
  from '../../src/services/minebot/integration/companionBodyParts.js';
import { installSpawnScan } from '../../src/services/minebot/utils/worldScan.js';
import { installRigSpawnScan } from './rig-spawn-scan.js';

const env = process.env;
const port = Number(env.HALCYON_MC_PORT ?? 25570);
const name = env.HALCYON_BODY_NAME ?? 'Halcyon';
const head = env.HALCYON_HEAD_URL ?? 'http://127.0.0.1:4329';
const serverId = env.HALCYON_SERVER_ID ?? 'halcyon-home';
const tokenFile = env.HALCYON_BODY_TOKEN_FILE ?? '';
const guard = env.HALCYON_BUDGET_GUARD ?? '';
const say = (tag: string, value: unknown) => console.log(`${new Date().toISOString()} ${tag} ${JSON.stringify(value)}`);

if (!Number.isInteger(port) || port <= 25569) throw new Error('HALCYON_MC_PORT must be a port above 25569');
const token = readFileSync(tokenFile, 'utf8').trim();
if (token.length < 16 || /\s/.test(token)) throw new Error('HALCYON_BODY_TOKEN_FILE does not hold a device token');

/** 0: room left; 3: the day's cap is reached; anything else: the guard failed (treated as no room: fail closed). */
function budgetRoom(): boolean {
  if (!guard) return true;
  const run = spawnSync('python3', ['-I', guard, 'check'], { encoding: 'utf8', timeout: 20_000 });
  const line = (run.stdout ?? '').trim().split('\n').pop() ?? '';
  if (run.status === 0) return true;
  say('HALCYON_BUDGET_STOP', { status: run.status, line: line.slice(0, 200), error: (run.stderr ?? '').slice(0, 200) });
  return false;
}
if (!budgetRoom()) process.exit(3);

const actor: any = await createProbeBot(port, name);
const stopSpawnScan = installRigSpawnScan(actor, installSpawnScan, line => say('BODY_SCAN', line));
actor.on('error', (error: Error) => say('BODY_ERROR', String(error?.message ?? error).slice(0, 200)));
actor.on('kicked', (reason: unknown) => say('BODY_KICKED', String(typeof reason === 'string' ? reason : JSON.stringify(reason)).slice(0, 200)));
actor.on('death', () => say('BODY_EVENT', { event: 'death' }));
actor.on('end', (reason: unknown) => { say('BODY_EVENT', { event: 'body_end', reason: String(reason).slice(0, 120) }); void shutdown(1); });

const body = new NativeCommonFcaBody(actor, { serverId, capture: async () => { throw new Error('no renderer on Halcyon\'s body'); },
  rendererConfigured: () => false });
const loop = new CommonFcaControlLoop({ baseUrl: head, token, serverId, actuator: body, pollMilliseconds: 200 });
loop.start();

// Game chat and death, as the production companion body (skillAgent.ts botOnChat/handleChat, MinebotCompanionBody).
const client = new CompanionBodyClient({ baseUrl: head, token, serverId });
const events = watchCompanionBodyEvents(actor, { name: () => actor.username,
  onDeath: cause => { void client.died(cause, othersOnline(actor)).then(ok => say('BODY_DEATH_SENT', { cause, ok })); } });
let turnBusy = false;
const stopChat = env.HALCYON_CHAT === 'off' ? () => {} : listenToPlayerChat(actor, speaker => {
  if (speaker.self || speaker.name === name || !isAddressedToHer(speaker.message) || turnBusy) return;
  turnBusy = true;
  void takeCompanionTurn(client, { speakerUuid: speaker.uuid, speakerName: speaker.name, message: speaker.message,
    body: companionBodyNow(actor, { busyWith: loop.busy ? 'request' : 'idle', recentAdvancements: events.recentAdvancements }) },
  reply => { speakCompanionReply(actor, reply, { lineLimit: 256, maxLines: 3 }); })
    .then(outcome => say('BODY_TURN', { from: speaker.name, outcome: outcome.kind === 'answered' ? outcome.action : outcome.kind }))
    .catch(error => say('BODY_TURN_ERROR', String(error?.message ?? error).slice(0, 200)))
    .finally(() => { turnBusy = false; });
});
say('HALCYON_BODY_UP', { name, port, head, serverId });

const budgetTimer = setInterval(() => { if (!budgetRoom()) void shutdown(3); }, 60_000);

let closing = false;
async function shutdown(code: number): Promise<void> {
  if (closing) return;
  closing = true;
  clearInterval(budgetTimer);
  stopChat();
  events.dispose();
  stopSpawnScan();
  await loop.stop().catch(() => undefined);
  try { closeProbeBot(actor); } catch { /* closing */ }
  say('HALCYON_BODY_DOWN', { code });
  setTimeout(() => process.exit(code), 500).unref();
}
process.on('SIGTERM', () => { void shutdown(0); });
process.on('SIGINT', () => { void shutdown(0); });
