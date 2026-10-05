#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { labUiModConfig, pickUiModJars } from './lab/lab-ui-mod.mjs';

// Run on the VM. Runtime libraries are immutable; all world/config/log writes
// go to this newly created directory. No existing save or mods are reused.
const template = '/home/azureuser/minecraft/1.21.11-fabric-test';
const root = '/home/azureuser/minecraft';
const port = Number(process.env.MINECRAFT_LAB_PORT ?? 25577);
const terrain = process.env.MINECRAFT_LAB_TERRAIN ?? 'flat';
const unassisted = process.env.MINECRAFT_LAB_UNASSISTED === 'true';
// How far the body sees (chunks sent to it). Five is light on a two-core VM; a person plays at ten or more, and a
// village 100 blocks off is in view for them. Mobs and block changes are still simulated five chunks out.
const viewDistance = Math.max(5, Math.min(12, Number(process.env.MINECRAFT_LAB_VIEW_DISTANCE ?? 5) || 5));
if (!['flat', 'natural'].includes(terrain)) throw new Error('Invalid terrain profile');
if (unassisted && terrain !== 'natural') throw new Error('Unassisted campaign requires natural terrain');
if (!Number.isInteger(port) || port < 1 || port > 65535 || (port >= 25565 && port <= 25569)) {
  throw new Error('Invalid isolated lab port');
}
// MINECRAFT_LAB_PUBLIC=true: a server people join from outside, as for any multiplayer game (the user asked for
// it on 2026-10-05, so friends can watch). Real accounts only (online-mode) and only the names in
// MINECRAFT_LAB_WHITELIST; the operator works over RCON on a port the VM's firewall does not open (it opens
// 25500-25600). The world is still new and empty, with nothing of the shared worlds or of Shannon-prod.
const publicServer = process.env.MINECRAFT_LAB_PUBLIC === 'true';
const RCON_OFFSET = 1000;
const whitelistNames = (process.env.MINECRAFT_LAB_WHITELIST ?? '').split(',').map(name => name.trim()).filter(Boolean);
// MINECRAFT_LAB_OPS: whitelisted people who are op (the owner asked to always be, 2026-10-05). Never the bot.
const opNames = (process.env.MINECRAFT_LAB_OPS ?? '').split(',').map(name => name.trim()).filter(Boolean);
if (publicServer) {
  if (!unassisted) throw new Error('A public lab is only for unassisted campaigns');
  if (port < 25500 || port > 25600 || port + RCON_OFFSET <= 25600) throw new Error('Public lab port must be in 25500-25600');
  if (!whitelistNames.length || !whitelistNames.every(name => /^[A-Za-z0-9_]{3,16}$/.test(name))) {
    throw new Error('MINECRAFT_LAB_WHITELIST="Name1,Name2" required for a public lab');
  }
  const botName = process.env.MINECRAFT_LAB_BOT_NAME || 'I_am_Shannon';
  if (opNames.some(name => !whitelistNames.includes(name) || name === botName)) {
    throw new Error('MINECRAFT_LAB_OPS must be whitelisted people, not the bot');
  }
}
// MINECRAFT_LAB_UI_MOD=true (public labs only): the world gets ShannonUIMod and Fabric API from
// MINECRAFT_LAB_MODS_DIR and a config/shannonuimod.json the campaign probe reads (ports: lab/lab-ui-mod.mjs).
const uiMod = process.env.MINECRAFT_LAB_UI_MOD === 'true';
if (uiMod && !publicServer) throw new Error('MINECRAFT_LAB_UI_MOD is only for a public lab');
const uiModsDirectory = process.env.MINECRAFT_LAB_MODS_DIR ?? '/home/azureuser/Shannon-dev/backend/saves/minecraft/uimod-test';
const uiModJars = uiMod ? pickUiModJars(fs.readdirSync(uiModsDirectory)) : [];
// The token stays in the world's config file (mode 600): the probe reads it from there, and it is never printed.
const uiModConfig = uiMod ? labUiModConfig({ gamePort: port, botPlayerName: process.env.MINECRAFT_LAB_BOT_NAME || 'I_am_Shannon',
  backendToken: randomBytes(24).toString('hex') }) : null;
const uiModPorts = uiModConfig ? { backendPort: uiModConfig.backendPort, httpServerPort: uiModConfig.httpServerPort } : null;
const session = port === 25577 ? 'codex-progressive-lab' : `codex-progressive-lab-${port}`;
const username = 'ShannonProbe';
// A tmux server of its own. Sessions created on the default server belong
// to whichever service started that server first: stopping that service
// (terraria.service, 2026-10-01) took every lab server down with it.
const tmuxSocket = process.env.MINECRAFT_LAB_TMUX_SOCKET ?? 'minebot-lab';
if (spawnSync('tmux', ['-L', tmuxSocket, 'has-session', '-t', session]).status === 0) {
  throw new Error('Progressive lab already exists');
}
for (const used of [port, ...(uiModPorts ? Object.values(uiModPorts) : [])]) {
  if (spawnSync('bash', ['-c', `ss -ltn | grep -q ':${used} '`]).status === 0) {
    throw new Error(`Isolated port already in use: ${used}`);
  }
}
const directory = fs.mkdtempSync(path.join(root, 'progressive-lab-'));
for (const name of ['libraries', 'versions', 'fabric-server-launch.jar']) {
  fs.symlinkSync(path.join(template, name), path.join(directory, name));
}
fs.cpSync(path.join(template, '.fabric'), path.join(directory, '.fabric'), { recursive: true });
fs.mkdirSync(path.join(directory, 'mods'));
for (const jar of uiModJars) fs.copyFileSync(path.join(uiModsDirectory, jar), path.join(directory, 'mods', jar));
if (uiModConfig) {
  fs.mkdirSync(path.join(directory, 'config'));
  fs.writeFileSync(path.join(directory, 'config', 'shannonuimod.json'), JSON.stringify(uiModConfig, null, 2) + '\n', { mode: 0o600 });
}
fs.writeFileSync(path.join(directory, 'eula.txt'), 'eula=true\n');
const digest = createHash('md5').update(`OfflinePlayer:${username}`).digest();
digest[6] = (digest[6] & 0x0f) | 0x30;
digest[8] = (digest[8] & 0x3f) | 0x80;
const hex = digest.toString('hex');
const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
let access = ['server-ip=127.0.0.1', 'online-mode=false'];
if (publicServer) {
  // The operator is the console; only the people in MINECRAFT_LAB_OPS are op. Entries carry the account ids
  // Mojang gives the names.
  const whitelist = [];
  for (const name of whitelistNames) {
    const response = await fetch(`https://api.mojang.com/users/profiles/minecraft/${name}`);
    if (!response.ok) throw new Error(`Unknown Minecraft name: ${name}`);
    const { id } = await response.json();
    whitelist.push({ uuid: id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'), name });
  }
  fs.writeFileSync(path.join(directory, 'whitelist.json'), JSON.stringify(whitelist));
  fs.writeFileSync(path.join(directory, 'ops.json'), JSON.stringify(whitelist.filter(entry => opNames.includes(entry.name))
    .map(entry => ({ ...entry, level: 4, bypassesPlayerLimit: false }))));
  access = ['server-ip=', 'online-mode=true', 'white-list=true', 'enforce-whitelist=true',
    'enable-rcon=true', `rcon.port=${port + RCON_OFFSET}`, `rcon.password=${randomBytes(24).toString('hex')}`,
    'broadcast-rcon-to-ops=false', 'motd=Shannon Minebot lab'];
} else {
  fs.writeFileSync(path.join(directory, 'ops.json'), JSON.stringify([{ uuid, name: username, level: 4, bypassesPlayerLimit: true }]));
}
fs.writeFileSync(path.join(directory, 'server.properties'), [
  ...access, `server-port=${port}`,
  'enforce-secure-profile=false', 'spawn-protection=0', 'allow-flight=true',
  `view-distance=${viewDistance}`, 'simulation-distance=5', `max-players=${publicServer ? 10 : 3}`,
  'level-name=progressive_world', `level-type=minecraft:${terrain === 'natural' ? 'normal' : 'flat'}`,
  ...(unassisted ? [] : ['level-seed=9272026']),
  ...(terrain === 'flat' ? ['generator-settings={"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:dirt","height":2},{"block":"minecraft:grass_block","height":1}],"biome":"minecraft:plains","structures":{}}'] : []),
  `generate-structures=${terrain === 'natural'}`, `difficulty=${unassisted ? 'normal' : 'peaceful'}`, 'gamemode=survival',
  'enable-command-block=false', 'max-tick-time=60000', 'sync-chunk-writes=true',
].join('\n') + '\n', { mode: 0o600 });
const started = spawnSync('tmux', ['-L', tmuxSocket, 'new-session', '-d', '-s', session, '-c', directory,
  'java -Xms512M -Xmx2G -jar fabric-server-launch.jar nogui']);
if (started.status !== 0) throw new Error('Failed to start isolated server');
process.stdout.write(JSON.stringify({ directory, session, tmuxSocket, port, uuid, terrain,
  seed: unassisted ? 'random-hidden-from-bot' : 9272026, unassisted, public: publicServer,
  ...(publicServer ? { whitelist: whitelistNames } : {}), ...(uiModPorts ? { uiMod: { ...uiModPorts, jars: uiModJars } } : {}) }) + '\n');
