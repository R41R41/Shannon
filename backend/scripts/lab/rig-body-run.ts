// The body's half of S4's isolated head + body rig (shannon-ios scripts/minecraft-trials/rig.py, services/api/scripts/minecraft-rig.ts): the real native body over a lab
// server, polling the head's loopback door as it polls the API in production. Run it as the lab probes run (from backend/, `node --loader ts-node/esm`, TS_NODE_TRANSPILE_ONLY=true,
// the env of scripts/lab/run-hunt-lab.sh) so that its compiler settings and packages are the body's own.
//   RIG_MC_PORT (the lab server)  RIG_HEAD_URL (http://127.0.0.1:<port> of the rig)  RIG_BODY_NAME (default I_am_Shannon)
import { createProbeBot, closeProbeBot } from '../../src/services/minebot/testing/MinecraftProbeBot.js';
import { NativeCommonFcaBody } from '../../src/services/minebot/integration/commonFca/nativeBody.js';
import { CommonFcaControlLoop } from '../../src/services/minebot/integration/commonFca/controlLoop.js';

const port = Number(process.env.RIG_MC_PORT), name = process.env.RIG_BODY_NAME ?? 'I_am_Shannon', head = process.env.RIG_HEAD_URL ?? '';
if (!Number.isInteger(port) || !head) throw new Error('RIG_MC_PORT and RIG_HEAD_URL are required');
const say = (tag: string, value: unknown) => console.log(`${tag} ${JSON.stringify(value)}`);

const actor: any = await createProbeBot(port, name);
actor.on('error', (error: Error) => say('RIG_BODY_ERROR', String(error?.message ?? error).slice(0, 200)));
actor.on('death', () => say('RIG_EVENT', { event: 'death', at: new Date().toISOString() }));
actor.on('end', (reason: unknown) => say('RIG_EVENT', { event: 'body_end', reason: String(reason).slice(0, 120) }));
const body = new NativeCommonFcaBody(actor, { serverId: 'rig', capture: async () => { throw new Error('no picture in the rig'); }, rendererConfigured: () => false });
const loop = new CommonFcaControlLoop({ baseUrl: head, token: 'rig-device-token-0000', serverId: 'rig', actuator: body, pollMilliseconds: 150 });
loop.start();
say('RIG_BODY_UP', { name, port, head });

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await loop.stop().catch(() => undefined);
  try { closeProbeBot(actor); } catch { /* the lab is closing */ }
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
