import { execFile } from 'node:child_process';
import path from 'node:path';
import type { Platform, ServiceCommand } from '@shannon/common';
import { logger } from '../../utils/logger.js';
import { dispatchServiceCommand } from '../runtime/serviceCommandRegistry.js';
import { getSchedulerPort } from '../runtime/schedulerGateway.js';
import { requestSkillList } from '../runtime/skillListRegistry.js';
import { getWebNotificationHub } from '../web/webNotificationHub.js';
import { createOpsCommandPuller } from './shannonOpsCommands.js';
import { createShannonOpsReporter, type OpsReportResult } from './shannonOpsReporter.js';

const REPORT_MILLISECONDS = 60_000;
const COMMAND_POLL_MILLISECONDS = 10_000;
// The Minecraft servers this runtime manages (minecraft/client.ts VALID_SERVERS). Lab servers are not among them.
const MINECRAFT_SERVERS: readonly string[] = ['1.21.4-fabric-youtube', '1.21.4-test', '1.19.0-youtube', '1.21.1-play', '1.21.11-fabric-test'];
const SERVICES: readonly string[] = [
  'discord', 'twitter', 'youtube', 'youtube:live_chat', 'minecraft', 'minebot', 'minebot:bot', 'notion',
  ...MINECRAFT_SERVERS.map(server => `minecraft:${server}`),
];

let timer: NodeJS.Timeout | null = null;
let commandTimer: NodeJS.Timeout | null = null;

/**
 * Starts the once-a-minute operational report to the Shannon app API. It does nothing
 * unless the platform bridge is configured, and a failure here never reaches a service.
 */
export async function startShannonOpsReporter(): Promise<void> {
  if (timer) return;
  try {
    const { config } = await import('../../config/env.js');
    const reporter = createShannonOpsReporter({
      url: config.shannonCoreBridge.url, token: config.shannonCoreBridge.token, timeoutMs: config.shannonCoreBridge.timeoutMs,
      // The release directory name, e.g. `platform-people-20261002-cc7480f`.
      release: path.basename(path.resolve(process.cwd(), '..')),
      startedAt: new Date(Date.now() - Math.round(process.uptime() * 1_000)).toISOString(),
    });
    if (!reporter) return;
    const hub = getWebNotificationHub();
    hub.onStatus(payload => { if ('service' in payload) reporter.observeStatus(payload.service as Platform, payload.status); });
    hub.onPostSchedule(payload => reporter.observeSchedules(payload.data));
    hub.onSkill(skills => reporter.observeSkills(skills));
    requestSkillList();
    let last: OpsReportResult | null = null;
    const tick = async () => {
      // Ask each service for its present state (a read; the answers arrive through the hub), then report.
      await Promise.allSettled(SERVICES.map(service => dispatchServiceCommand(service, 'status' as ServiceCommand, service)));
      try { reporter.observeSchedules(getSchedulerPort().listSchedules()); } catch { /* the scheduler is not running */ }
      const result = await reporter.report();
      // Content-free: only a change of outcome is logged.
      if (result !== last) logger.info(`[ShannonOps] report: ${result}`);
      last = result;
    };
    timer = setInterval(() => { void tick(); }, REPORT_MILLISECONDS);
    // Operations asked for in the management window: pulled, performed one at a time, reported with a fixed code.
    const puller = createOpsCommandPuller({
      url: config.shannonCoreBridge.url, token: config.shannonCoreBridge.token, timeoutMs: config.shannonCoreBridge.timeoutMs,
    }, {
      dispatch: async (service, command, serverName) => {
        const registered = await dispatchServiceCommand(service, command as ServiceCommand, serverName ?? service).then(() => true, () => false);
        return registered && (command !== 'status' || reporter.statusOf(service) !== undefined);
      },
      statusOf: service => reporter.statusOf(service),
      scheduleNames: () => reporter.scheduleNames(),
      runSchedule: name => getSchedulerPort().callSchedule({ type: 'call_schedule', name }),
      labRunning,
    });
    if (puller) {
      let lastPull = '';
      commandTimer = setInterval(() => {
        void puller.pull().then(result => {
          if (result === 'performed') { logger.info('[ShannonOps] command performed'); void tick(); }
          else if (result !== lastPull && result === 'unavailable') logger.info('[ShannonOps] commands: unavailable');
          lastPull = result;
        });
      }, COMMAND_POLL_MILLISECONDS);
      commandTimer.unref();
    }
    timer.unref();
    setTimeout(() => { void tick(); }, 5_000).unref();
  } catch (error) {
    logger.warn(`[ShannonOps] reporter not started: ${error instanceof Error ? error.name : 'error'}`);
  }
}

export function stopShannonOpsReporter(): void {
  if (timer) clearInterval(timer);
  if (commandTimer) clearInterval(commandTimer);
  timer = null;
  commandTimer = null;
}

/** A paid lab run is in progress (its probe process exists). Starting a server then would slow it. */
function labRunning(): Promise<boolean> {
  return new Promise(resolve => {
    execFile('pgrep', ['-f', 'minecraft-campaign-live-probe'], { timeout: 5_000 }, (error, stdout) => {
      // pgrep exits 1 when nothing matches; any other failure is treated as "running", the safe side.
      if (!error) resolve(stdout.trim().length > 0);
      else resolve((error as NodeJS.ErrnoException & { code?: number | string }).code !== 1);
    });
  });
}
