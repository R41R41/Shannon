import type { Schedule, ServiceStatus, SkillInfo } from '@shannon/common';

/**
 * Reports this runtime's operational state to the Shannon app API
 * (`POST /v1/platform/ops/snapshot`, see shannon-ios docs/ops-contract.md).
 *
 * Same direction and credential as the platform bridge: this runtime pushes, the
 * desktop reads from the app API and never connects here. A snapshot carries service
 * states, schedule names and times, and skill names with their descriptions. It never
 * carries a message, a post body, a user name or a task title.
 */
export interface ShannonOpsReporterConfig {
  /** The bridge URL (`…/v1/platform/turns`); the snapshot goes to the same origin. */
  url: string;
  token: string;
  timeoutMs: number;
  release: string;
  startedAt: string;
}

export type OpsServiceStatus = 'running' | 'stopped' | 'degraded' | 'unknown';

export interface OpsSnapshot {
  scopeKey: string;
  reportedAt: string;
  runtime: { release: string; startedAt: string };
  services: Array<{ id: string; label: string; category: string; status: OpsServiceStatus; detail?: string }>;
  minebot: [];
  schedules: Array<{ name: string; time: string }>;
  skills: Array<{ name: string; description: string }>;
}

export type OpsReportResult = 'reported' | 'refused' | 'unavailable';

export interface ShannonOpsReporter {
  observeStatus(service: string, status: ServiceStatus | null | undefined): void;
  /** The state a service last reported. */
  statusOf(service: string): OpsServiceStatus | undefined;
  scheduleNames(): readonly string[];
  observeSchedules(schedules: readonly Schedule[]): void;
  observeSkills(skills: readonly SkillInfo[]): void;
  snapshot(now?: Date): OpsSnapshot;
  report(now?: Date): Promise<OpsReportResult>;
}

const LIMITS = { services: 40, schedules: 60, skills: 100, id: 80, label: 80, category: 40, time: 40, description: 160 } as const;
const SERVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;

/** Null when the bridge is not configured; this runtime then reports nothing. */
export function createShannonOpsReporter(
  config: ShannonOpsReporterConfig,
  fetcher: typeof fetch = fetch,
): ShannonOpsReporter | null {
  const token = config.token.trim();
  const target = snapshotUrl(config.url.trim());
  if (!target || token.length < 32) return null;
  const services = new Map<string, OpsServiceStatus>();
  let schedules: OpsSnapshot['schedules'] = [];
  let skills: OpsSnapshot['skills'] = [];

  const snapshot = (now: Date = new Date()): OpsSnapshot => ({
    scopeKey: 'owner',
    reportedAt: now.toISOString(),
    runtime: { release: label(config.release, LIMITS.label) || 'unknown', startedAt: config.startedAt },
    services: [...services.entries()].sort(([left], [right]) => left.localeCompare(right)).slice(0, LIMITS.services)
      .map(([id, status]) => ({ id, label: id, category: id.split(':')[0]!.slice(0, LIMITS.category), status })),
    minebot: [],
    schedules,
    skills,
  });

  return {
    observeStatus(service, status) {
      if (typeof service !== 'string' || service.length > LIMITS.id || !SERVICE_ID.test(service)) return;
      services.set(service, status === 'running' ? 'running' : status === 'stopped' ? 'stopped' : status === 'connecting' ? 'degraded' : 'unknown');
    },
    statusOf: service => services.get(service),
    scheduleNames: () => schedules.map(schedule => schedule.name),
    observeSchedules(next) {
      // Only the name and the time: a schedule's data is the post it will make.
      schedules = next.flatMap(schedule => {
        const name = label(schedule?.name, LIMITS.label);
        const time = label(schedule?.time, LIMITS.time);
        return name && time ? [{ name, time }] : [];
      }).slice(0, LIMITS.schedules);
    },
    observeSkills(next) {
      const seen = new Set<string>();
      skills = next.flatMap(skill => {
        const name = label(skill?.name, LIMITS.label);
        const description = label(skill?.description, LIMITS.description);
        if (!name || !description || seen.has(name)) return [];
        seen.add(name);
        return [{ name, description }];
      }).slice(0, LIMITS.skills);
    },
    snapshot,
    async report(now) {
      try {
        const response = await fetcher(target, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(snapshot(now)),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
        if (response.status === 200) return 'reported';
        // 400, 403, 404 and 413 will not change by trying again with the same content.
        return response.status >= 400 && response.status < 500 && response.status !== 429 ? 'refused' : 'unavailable';
      } catch {
        return 'unavailable';
      }
    },
  };
}

function snapshotUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/v1/platform/turns') return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '::1'].includes(url.hostname))) return null;
    url.pathname = '/v1/platform/ops/snapshot';
    return url.toString();
  } catch {
    return null;
  }
}

/** One line without control characters, cut to the contract's bound. */
function label(value: unknown, maximum: number): string {
  if (typeof value !== 'string') return '';
  const line = value.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return [...line].slice(0, maximum).join('').trim();
}
