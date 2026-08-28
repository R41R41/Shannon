import type { LineConfig } from './config.js';
import { LineLedger, lineKey, type LineEntry } from './ledger.js';
import { lineQuiet } from '../../modules/conversation/lineConversation.js';
import { PersonalRadarService } from '../radar/personalRadar.js';
import { PersonalTemporalRadar, type TemporalCatalogReader } from '../radar/personalTemporalRadar.js';
import { issueLineRadarContext, personalRadarOwner } from '../radar/radarAccess.js';
import type { PersonalCatalogPort } from '../../modules/radar/catalog.js';
import { catalogShape } from '../../modules/radar/catalogVersion.js';
import type { FeedConnectorPort } from '../radar/feedConnector.js';
import { lineRadarPolicyHash, parseLineRadarPolicy, type LineRadarPolicy } from './radarPolicy.js';

export interface LineRadarPorts {
  ledger: LineLedger; catalog: PersonalCatalogPort; feed: FeedConnectorPort; temporal: TemporalCatalogReader;
  readPolicy(): Promise<unknown>;
  deliver(id: string, authorize: (id: string) => Promise<boolean>): Promise<string>;
}
const acquisition = { maxPer24Hours: 3, minimumIntervalMs: 0, leaseMs: 30000 };
const sourceBody = (s: object) => Object.fromEntries(Object.entries(s).filter(([k]) => !['id','revision','audience','owner'].includes(k)));
const same = (a: unknown, b: unknown) => JSON.stringify(a, Object.keys(a as object).sort()) === JSON.stringify(b, Object.keys(b as object).sort());
/** One owner's delegated worker. Shares the catalog's reservation/CAS boundary, never Firebase tokens or legacy memory. */
export class LineRadarWorker {
  private readonly feed: PersonalRadarService;
  private readonly temporal: PersonalTemporalRadar;
  private readonly stopped = new AbortController();
  private running: Promise<string> | undefined;
  constructor(private readonly config: LineConfig, private readonly ports: LineRadarPorts, private readonly now = Date.now) {
    this.feed = new PersonalRadarService(ports.catalog, now, acquisition);
    this.temporal = new PersonalTemporalRadar(ports.catalog, ports.temporal, now, acquisition);
  }
  private async policy() { return parseLineRadarPolicy(await this.ports.readPolicy(), this.now()); }
  private async authority(policy: LineRadarPolicy, version: number) {
    if (this.stopped.signal.aborted || !this.config.enabled || !policy.enabled || policy.consentExpiresAt <= this.now()
      || lineRadarPolicyHash(await this.policy()) !== lineRadarPolicyHash(policy)) throw new Error('LINE_RADAR_STOPPED');
    const s = await this.ports.ledger.read();
    if (!s.optedIn || s.consentVersion !== version || s.personalUserId !== this.config.personalUserId) throw new Error('LINE_RADAR_STOPPED');
    return issueLineRadarContext(this.config.botUserId, this.config.personalUserId, Math.min(this.now() + 60000, policy.consentExpiresAt));
  }
  async status(): Promise<string> {
    const p = await this.policy(), s = await this.ports.ledger.read();
    const time = `${String(p.hourJst).padStart(2,'0')}:${String(p.minuteJst).padStart(2,'0')}（日本時間）`;
    return `個人Radar: ${s.optedIn && p.enabled && p.consentExpiresAt > this.now() ? '配信許可あり' : '停止中'}\n`
      + `予定: 毎日${time}、最大3項目。新着がなければ送信しません。\n`
      + `登録ソース: ${p.feeds.length}件${p.weather ? '＋天気' : ''}\n`
      + `取得許可期限: ${new Date(p.consentExpiresAt).toISOString()}\n`
      + '配信開始 / 配信停止 で切り替えできます。情報への返信から会話できます。';
  }
  /** Invalidate short-term conversation derivatives when consent, sources or retained content change. */
  async conversationVersion(): Promise<string> {
    const p = await this.policy(), s = await this.ports.ledger.read();
    const owner = personalRadarOwner(issueLineRadarContext(this.config.botUserId, this.config.personalUserId, this.now()+60000), this.now());
    const row = await this.ports.catalog.read(owner);
    const live = row ? [row.sources.map(e => [e.id, e.source?.enabled, (e.source?.consentExpiresAt ?? 0) > this.now(),
      e.records.filter(r => r.content.expiresAt > this.now()).map(r => r.content.id)]),
      catalogShape(row).temporalSources.map(e => [e.id, (e.source?.consentExpiresAt ?? 0) > this.now(),
        (e.snapshot?.content.validUntil ?? 0) > this.now()])] : [];
    return lineKey(JSON.stringify([s.consentVersion, lineRadarPolicyHash(p), p.consentExpiresAt > this.now(), row?.revision ?? 0, live]));
  }
  tick(): Promise<string> {
    if (this.running) return this.running;
    const task = this.run(); this.running = task;
    void task.finally(() => { if (this.running === task) this.running = undefined; }).catch(() => undefined);
    return task;
  }
  async stop() { this.stopped.abort(); await this.running; }
  private async synchronize(p: LineRadarPolicy, version: number, signal: AbortSignal) {
    const renew = () => this.authority(p, version);
    let context = await renew();
    let feeds = await this.feed.sources(context);
    for (const e of feeds.sources.filter(e => e.source && !p.feeds.some(f => f.id === e.id))) {
      await this.feed.revoke(context, e.id, feeds.revision, renew); feeds = await this.feed.sources(await renew());
    }
    for (const setting of p.feeds) {
      context = await renew(); feeds = await this.feed.sources(context);
      const desired = { ...sourceBody(setting), enabled: true, consentExpiresAt: p.consentExpiresAt };
      const current = feeds.sources.find(e => e.id === setting.id)?.source;
      if (!current || !same(sourceBody(current), desired)) await this.feed.configure(context, setting.id, { expectedRevision: feeds.revision, source: desired }, renew);
    }
    let temporal = await this.temporal.sources(await renew(), renew);
    for (const e of temporal.sources.filter(e => e.source && e.id !== p.weather?.id)) {
      await this.temporal.revoke(await renew(), e.id, temporal.revision, renew, signal); temporal = await this.temporal.sources(await renew(), renew);
    }
    if (p.weather) {
      const desired = { ...sourceBody(p.weather), enabled: true, consentExpiresAt: p.consentExpiresAt };
      const current = temporal.sources.find(e => e.id === p.weather!.id)?.source;
      if (!current || !same(sourceBody(current), desired)) await this.temporal.configure(await renew(), p.weather.id, { expectedRevision: temporal.revision, source: desired }, renew, signal);
    }
    // Explicit bounded recovery/expiry maintenance retains budgets and tombstones and never retries old I/O.
    context = await renew(); feeds = await this.feed.sources(context);
    await this.feed.maintain(context, feeds.revision, renew);
  }
  authorizeQuote = (id: string): Promise<boolean> => this.authorizeEntry(id, true);
  private async authorizeEntry(id: string, quote = false): Promise<boolean> {
    try {
      const p = await this.policy(); const state = await this.ports.ledger.read();
      const e = state.entries.find(e => e.id === id); const grant = e?.radarGrant;
      if (!e || !grant || e.kind !== 'push' || (quote ? e.quoteExpiresAt ?? e.expiresAt : e.expiresAt) <= this.now() || e.consentVersion !== state.consentVersion
        || grant.policyHash !== lineRadarPolicyHash(p)) return false;
      const context = await this.authority(p, state.consentVersion);
      if (grant.owner !== personalRadarOwner(context, this.now())) return false;
      await this.feed.assertCurrent(context, grant.catalogRevision);
      await this.authority(p, state.consentVersion); return true;
    } catch { return false; }
  }
  private async run(): Promise<string> {
    if (this.stopped.signal.aborted) return 'stopped';
    const signal = AbortSignal.any([this.stopped.signal, AbortSignal.timeout(45000)]);
    let slot: string | undefined;
    try {
      const p = await this.policy(); const initial = await this.ports.ledger.read();
      if (!initial.optedIn || !p.enabled || p.consentExpiresAt <= this.now() || !this.config.enabled) return 'disabled';
      const version = initial.consentVersion; const renew = () => this.authority(p, version);
      await renew();
      // Resume only never-sent pending work. 'sending'/unknown operations are never blindly retried.
      for (const e of initial.entries.filter(e => e.kind === 'push' && e.status === 'pending' && e.radarGrant && e.expiresAt > this.now())) {
        signal.throwIfAborted(); await this.ports.deliver(e.id, id => this.authorizeEntry(id));
      }
      const jst = new Date(this.now() + 9 * 3600000); const minute = jst.getUTCHours() * 60 + jst.getUTCMinutes();
      const due = p.hourJst * 60 + p.minuteJst;
      if (minute < due || minute >= due + 30 || lineQuiet(this.config, this.now())) return 'not-due';
      // A rolling 24h quota must not turn a daily schedule into alternate-day delivery when start seconds drift.
      if (!await this.ports.ledger.canReservePush()) return 'budget-wait';
      const before = await this.ports.catalog.read(personalRadarOwner(await renew(), this.now()));
      const starts = before?.acquisition?.starts.filter(t => t > this.now() - 86400000) ?? [];
      if (starts.length + p.feeds.length + (p.weather ? 1 : 0) > acquisition.maxPer24Hours) return 'budget-wait';
      slot = await this.ports.ledger.reserveRadarSlot(jst.toISOString().slice(0,10), version);
      if (!slot) return 'already-attempted';
      await this.synchronize(p, version, signal);
      const collected: string[] = [];
      for (const setting of [...p.feeds, ...(p.weather ? [p.weather] : [])]) {
        signal.throwIfAborted(); const context = await renew(); const current = await this.feed.sources(context);
        try {
          if (setting.kind === 'weather') await this.temporal.collect(context, setting.id, current.revision, renew, signal);
          else await this.feed.collect(context, setting.id, this.ports.feed, signal, renew, current.revision);
          collected.push(setting.id);
        } catch { signal.throwIfAborted(); await renew(); /* Failed source is omitted, never represented as fresh. */ }
      }
      const state = await this.ports.ledger.read();
      const seen = new Set(state.entries.flatMap(e => e.radarGrant?.clusters ?? []));
      const context = await renew(); const news = await this.feed.preview(context, seen);
      const temporal = await this.temporal.preview(context, renew, signal);
      if (news.revision !== temporal.revision) throw new Error('LINE_RADAR_CONFLICT');
      const weather = temporal.entries.find(e => e.content.kind === 'weather' && collected.includes(e.sourceId));
      const cards = news.items.filter(e => collected.includes(e.sourceId)).slice(0, weather ? 2 : 3);
      const lines = cards.map(e => `${e.card.title}\n${e.card.fact}\n${e.card.metadata.join(' ')}\n${e.card.sourceUrl}`);
      if (weather?.content.kind === 'weather') {
        const d = weather.content.items[0];
        lines.unshift(`天気 ${d.date}\n最低 ${d.minimumC ?? '不明'}°C / 最高 ${d.maximumC ?? '不明'}°C / 降水確率 ${d.precipitationPercent ?? '不明'}%\n${weather.content.attribution}\n${weather.content.providerUrl}`);
      }
      if (!lines.length) { await this.ports.ledger.finish(slot, { status: 'cancelled' }); return 'silent'; }
      const text = `Shannon Radar · ${jst.toISOString().slice(0,10)}\n\n${lines.join('\n\n')}\n\n配信停止:「配信停止」`;
      const grant: NonNullable<LineEntry['radarGrant']> = { owner: personalRadarOwner(context, this.now()), policyHash: lineRadarPolicyHash(p),
        catalogRevision: news.revision, clusters: cards.map(e => lineKey(JSON.stringify(e.card.sourceUrl))) };
      const catalog = await this.ports.catalog.read(grant.owner);
      if (!catalog || catalog.revision !== news.revision) throw new Error('LINE_RADAR_CONFLICT');
      const ids = new Set(cards.map(e => e.contentId));
      const quoteExpiresAt = Math.min(this.now() + 86400000, p.consentExpiresAt, weather?.content.validUntil ?? Infinity,
        ...catalog.sources.flatMap(e => e.records.filter(r => ids.has(r.content.id)).map(r => r.content.expiresAt)));
      signal.throwIfAborted(); await renew();
      const id = await this.ports.ledger.enqueue({ id: slot, ownerUserId: this.config.personalUserId, text,
        expiresAt: Math.min(news.validUntil, temporal.validUntil), quoteExpiresAt, consentVersion: version, radarGrant: grant });
      const result = id ? await this.ports.deliver(id, id => this.authorizeEntry(id)) : 'suppressed';
      await this.ports.ledger.finish(slot, { status: result === 'accepted' ? 'accepted' : 'cancelled' });
      return result;
    } catch {
      if (slot) await this.ports.ledger.finish(slot, { status: 'unknown' }).catch(() => undefined);
      return this.stopped.signal.aborted ? 'stopped' : 'unavailable';
    }
  }
}
