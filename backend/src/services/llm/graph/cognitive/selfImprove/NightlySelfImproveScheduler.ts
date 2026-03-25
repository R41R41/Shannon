/**
 * 夜間自己改善のスケジュール起動（1日1回・UTC 日付で重複防止）。
 * 既定設定では LLM を呼ばないため課金はほぼ発生しない。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../../../../../config/env.js';
import { getBackendRoot } from '../../../../../utils/backendRoot.js';
import { createLogger } from '../../../../../utils/logger.js';
import { SelfImprovementDaemon } from './SelfImprovementDaemon.js';
import { isNightlyFireTimeUtc, utcCalendarDateUtc } from './nightlySchedule.js';

const log = createLogger('SelfImprove:Nightly');

const TICK_MS = 60_000;

async function loadLastRunDate(statePath: string): Promise<string> {
    try {
        const raw = await readFile(statePath, 'utf-8');
        const j = JSON.parse(raw) as { lastRunUtcDate?: string };
        return j.lastRunUtcDate ?? '';
    } catch {
        return '';
    }
}

async function tick(): Promise<void> {
    const n = config.selfImprove.nightly;
    const now = new Date();

    if (!isNightlyFireTimeUtc(now, n.hourUtc, n.minuteUtc, n.windowMinutes)) return;

    const root = getBackendRoot();
    const dir = join(root, 'saves/self_improve');
    const statePath = join(dir, 'nightly_state.json');
    const today = utcCalendarDateUtc(now);
    const last = await loadLastRunDate(statePath);
    if (last === today) return;

    log.info(
        `🌙 夜間バッチ開始 (UTC ${today})。課金: reactive=${n.runReactiveImprovement}, ` +
        `codeAgent=${n.codeAgentEnabled}, mcSuites=${n.minecraftSuites.length}, mcAutoFix=${n.minecraftAutoFix}`,
    );

    const daemon = SelfImprovementDaemon.getInstance();
    const report = await daemon.runNightlyMaintenance();

    await mkdir(dir, { recursive: true });
    await writeFile(statePath, JSON.stringify({ lastRunUtcDate: today }, null, 2), 'utf-8');

    const url = n.morningWebhookUrl.trim();
    if (url) {
        try {
            const text = report.markdownReport.length > 1900
                ? `${report.markdownReport.slice(0, 1900)}…`
                : report.markdownReport;
            await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: text }),
            });
        } catch (e: any) {
            log.warn(`朝レポート Webhook 失敗: ${e?.message ?? e}`);
        }
    }

    log.info(`🌙 夜間バッチ完了 → ${report.markdownPath}`);
}

let started = false;

export function startNightlySelfImproveScheduler(): void {
    if (!config.selfImprove.nightly.enabled || started) return;
    started = true;
    log.info(
        `夜間スケジューラ有効: UTC ${config.selfImprove.nightly.hourUtc}:` +
        `${String(config.selfImprove.nightly.minuteUtc).padStart(2, '0')} ±` +
        `${config.selfImprove.nightly.windowMinutes}m`,
    );
    setInterval(() => {
        tick().catch(err => log.error(`tick エラー: ${err?.message ?? err}`));
    }, TICK_MS);
    tick().catch(err => log.error(`初回 tick エラー: ${err?.message ?? err}`));
}
