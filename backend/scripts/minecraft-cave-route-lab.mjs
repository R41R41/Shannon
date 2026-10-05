#!/usr/bin/env node
// Clone a stopped, isolated campaign world for a repeatable route trial.
// Never writes to the source world or a shared Minecraft port.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const source = process.env.MINECRAFT_CAVE_SOURCE ?? '';
const sourcePort = Number(process.env.MINECRAFT_CAVE_SOURCE_PORT ?? 25579);
const port = Number(process.env.MINECRAFT_CAVE_PORT ?? 25580);
if (!/^\/home\/azureuser\/minecraft\/progressive-lab-[A-Za-z0-9]+$/.test(source)
  || !fs.statSync(source).isDirectory()) throw new Error('CAVE_ISOLATED_SOURCE_REQUIRED');
if (!Number.isInteger(port) || port < 25577 || port > 25650) throw new Error('CAVE_PORT_INVALID');
if (!Number.isInteger(sourcePort) || sourcePort < 25577 || sourcePort > 25650 || sourcePort === port)
  throw new Error('CAVE_SOURCE_PORT_INVALID');
const session = `codex-cave-route-${port}`;
if (spawnSync('tmux', ['has-session', '-t', session]).status === 0
  || spawnSync('bash', ['-c', `ss -ltn | grep -q ':${port} '`]).status === 0)
  throw new Error('CAVE_PORT_OR_SESSION_IN_USE');
const properties = fs.readFileSync(path.join(source, 'server.properties'), 'utf8');
if (!properties.includes('server-ip=127.0.0.1') || !properties.includes(`server-port=${sourcePort}`)
  || !properties.includes('level-type=minecraft\\:normal')) throw new Error('CAVE_SOURCE_CONFIGURATION_INVALID');
const directory = fs.mkdtempSync('/home/azureuser/minecraft/progressive-lab-');
fs.cpSync(source, directory, { recursive: true, force: false });
const propertiesFile = path.join(directory, 'server.properties');
fs.writeFileSync(propertiesFile, properties.replace(`server-port=${sourcePort}`, `server-port=${port}`));
const started = spawnSync('tmux', ['new-session', '-d', '-s', session, '-c', directory,
  'java -Xms512M -Xmx2G -jar fabric-server-launch.jar nogui']);
if (started.status !== 0) throw new Error('CAVE_SERVER_START_FAILED');
process.stdout.write(JSON.stringify({ directory, session, port }) + '\n');
