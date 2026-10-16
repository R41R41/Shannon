// Starts the real Minebot client (the common FCA body) on a throwaway world, for trying ShannonUIMod against it.
// Run by uimod-fca-lab.sh with the lab's own environment; see docs/minebot-ui-mod-fca.md.
//   TS_NODE_TRANSPILE_ONLY=true node --loader ts-node/esm scripts/lab/uimod-fca-lab.ts
import { MinebotClient } from '../../src/services/minebot/client.js';

const serverName = process.env.MINEBOT_COMPANION_SERVER_NAME;
if (!serverName || serverName === 'shannon-home' || process.env.MINEBOT_COMMON_FCA !== 'on' || process.env.MINEBOT_LAB_OFFLINE_AUTH !== 'on') {
  console.error('LAB_ENV_INVALID: needs MINEBOT_COMPANION_SERVER_NAME (not shannon-home), MINEBOT_COMMON_FCA=on and MINEBOT_LAB_OFFLINE_AUTH=on');
  process.exit(2);
}
const client = MinebotClient.getInstance(true);
await client.start();
const started = await (client as any).startBot({ serverName, serviceCommand: 'start' });
console.log(`LAB_BOT_${started ? 'STARTED' : 'FAILED'} ${serverName}`);
if (!started) process.exit(1);
const stop = async () => { try { await (client as any).stopBot({ serverName, serviceCommand: 'stop' }); } finally { process.exit(0); } };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
