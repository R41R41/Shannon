import { TemporalRadarPanel } from './TemporalRadarPanel';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { RadarController } from './radarController';
import type { RadarErrorCode, SourceEntry, AuditEvent } from './radarClient';
import { SourceEditor } from './SourceEditor';
import styles from './RadarDashboard.module.scss';

const messages: Record<RadarErrorCode, string> = {
  authorization: '利用権限を確認できませんでした。内容を消去しました。再ログインしてください。',
  conflict: '別の更新と競合しました。保存結果を再読み込みで確認してください。自動で上書きはしません。',
  invalid: '設定または応答の形式を確認できませんでした。内容を消去しました。',
  unavailable: 'Radar APIは準備中、または現在利用できません。実データは表示していません。',
  network: '接続を確認できませんでした。古い内容は表示しません。',
  uncertain: '取得・保存・削除の結果を確認できません。操作を繰り返さず、再読み込みで結果を確認してください。',
};
const date = (time: number) => new Date(time).toLocaleString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export function RadarDashboard({ controller, onLogout, isAdmin = false }: {
  controller: RadarController; onLogout: () => void; isAdmin?: boolean;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    controller.activate();
    const visibility = () => controller.visibility(document.visibilityState === 'visible');
    const hidden = () => controller.visibility(false);
    const returned = () => controller.visibility(document.visibilityState === 'visible');
    const restored = (event: PageTransitionEvent) => { if (event.persisted) returned(); };
    document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', hidden); window.addEventListener('pageshow', restored);
    window.addEventListener('blur', hidden); window.addEventListener('focus', returned);
    if (document.visibilityState !== 'visible') hidden(); else void controller.load();
    return () => { controller.stop(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', hidden);
      window.removeEventListener('pageshow', restored); window.removeEventListener('blur', hidden); window.removeEventListener('focus', returned); };
  }, [controller]);
  const busy = state.status === 'saving' || state.status === 'collecting' || state.status === 'loading';
  return <main className={styles.page}>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>SHANNON / PERSONAL</p><h1>Radar<span>静かに、気になることだけ。</span></h1></div>
      <nav aria-label="Radarナビゲーション">{isAdmin && <a href="/shannonUI">管理コンソール</a>}<button onClick={() => { controller.stop(); onLogout(); }}>ログアウト</button></nav>
    </header>
    <div className={styles.intro}><div><span className={styles.badge}>本人のみ・非通知</span><p>登録ソースから届いた候補を、最大3件。ここから会話や通知は始まりません。</p></div>
      <button type="button" onClick={() => void controller.load()} disabled={busy || state.status === 'closed' || state.status === 'hidden'}>{busy ? '確認中…' : '保存内容を再読み込み'}</button></div>
    <aside className={styles.notice}>開発中：定期実行・Discord投稿は未有効化です。再読み込みは保存済み内容の確認だけです。取得は別の明示操作で、サーバーが接続を許可した場合だけ行えます。</aside>
    {state.error && <p role="alert" className={styles.error}>{messages[state.error]}</p>}
    {state.status === 'loading' && <p role="status" className={styles.placeholder}>本人の設定と有効期限を確認しています…</p>}
    {state.status === 'collecting' && <div role="status" className={styles.placeholder}>選択したソースを取得しています。取得中の内容は表示しません。<p>中断しても取得回数は戻らず、保存済みの結果は残る場合があります。</p><button onClick={() => controller.cancelCollection()}>取得を中断</button></div>}
    {state.status === 'saving' && <p role="status" className={styles.placeholder}>変更を確認しています。以前の内容は非表示にしました。</p>}
    {['expired', 'hidden'].includes(state.status) && <p role="status" className={styles.placeholder}>プライバシー保護のため表示を消去しました。保存内容を再読み込みしてください。</p>}
    {state.status === 'closed' && <p role="status" className={styles.placeholder}>この画面の内容を消去しました。</p>}
    {state.status === 'ready' && state.data && <ReadyRadar key={state.data.sources.revision} controller={controller} data={state.data} />}
    <footer className={styles.footer}>表示は最大60秒で消去。タブを離れた時・ログアウト時も消去します。人物情報の推測や、無反応からの学習は行いません。</footer>
  </main>;
}
function ReadyRadar({ controller, data }: { controller: RadarController; data: NonNullable<ReturnType<RadarController['getSnapshot']>['data']> }) {
  const [editor, setEditor] = useState<SourceEntry | 'new' | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [collecting, setCollecting] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const active = data.sources.sources.filter(s => s.source);
  const allSources = [...data.sources.sources,...(data.sources.temporal?.sources ?? [])];
  const canAdd = allSources.length < 32 && allSources.filter(e=>e.source).length < 10;
  const collectable = allSources.filter(e=>e.source);
  const canCollect = data.sources.collectionAvailable === true;
  const actionLabels: Record<AuditEvent['action'], string> = { configure: '設定更新', revoke: '削除', reserve: '取得予約', collect: '取得完了', collect_failed: '取得停止', maintain: '期限切れの整理' };
  return <>
    <section aria-labelledby="collect-title" className={styles.sources}>
      <div className={styles.sectionHeading}><h2 id="collect-title">ソースを明示的に取得</h2><span>最大3ソース・30秒</span></div>
      <p>再読み込みとは別の操作です。選択したソースだけを取得し、取得回数を消費します。自動再試行・投稿は行いません。</p>
      {!canCollect && <p className={styles.note}>取得機能はまだ接続されていません。</p>}
      <fieldset disabled={!canCollect || collecting}><legend>取得するソース</legend>{collectable.map(entry => <label key={entry.id} className={styles.pickSource}>
        <input type="checkbox" checked={selected.includes(entry.id)} disabled={!entry.source!.enabled || entry.source!.consentExpiresAt <= data.preview.servedAt || (!selected.includes(entry.id) && selected.length >= 3)}
          onChange={event => { setSelected(ids => event.target.checked ? [...ids, entry.id] : ids.filter(id => id !== entry.id)); }} />{entry.id}
      </label>)}</fieldset>
      <button disabled={!canCollect || !selected.length || collecting} onClick={() => { setCollecting(true); setEditor(null); setDeleting(null); }}>選択内容を確認</button>
      {collecting && <div role="group" aria-label="情報取得の確認" className={styles.confirm}><p>{selected.join('、')} を取得します。失敗・中断でも回数を消費します。途中まで保存される場合があります。</p>
        <button onClick={() => void controller.collect(selected)}>選択したソースを取得する</button><button onClick={() => setCollecting(false)}>取得をやめる</button></div>}
    </section>
    <section aria-labelledby="digest-title" className={styles.digest}>
      <div className={styles.sectionHeading}><h2 id="digest-title">今回のダイジェスト</h2><span>{data.preview.items.length} / 3件 · 版 {data.sources.revision}</span></div>
      {!data.preview.items.length && <div className={styles.empty}><strong>今は、表示する候補がありません。</strong><p>未取得・期限切れ・停止中のソースは表示されません。何も通知しない状態も正常です。</p></div>}
      <div className={styles.cards}>{data.preview.items.map(item => <article key={item.contentId} className={styles.card}>
        <p className={styles.sourceLabel}>{item.sourceId} · ソース版 {item.sourceRevision}</p>
        <h3><a href={item.card.sourceUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"
          onClick={event => { if (!controller.isReadable()) { event.preventDefault(); controller.clear(); } }}>{item.card.title}</a></h3>
        <p>{item.card.fact}</p><div className={styles.metadata}>{item.card.metadata.map((m, i) => <span key={i}>{m}</span>)}</div>
        <p className={styles.reason}>選定理由：{item.matchedTopicIds.length ? `設定したトピック ${item.matchedTopicIds.join('・')}` : '登録ソースの掲載情報'}。記事の真偽・新規性を保証するものではありません。</p>
      </article>)}</div>
    </section>
    {data.sources.temporal && <TemporalRadarPanel controller={controller} sources={data.sources.temporal} preview={data.preview.temporal ?? []} canAdd={canAdd} />}
    <section aria-labelledby="sources-title" className={styles.sources}>
      <div className={styles.sectionHeading}><div><h2 id="sources-title">自分のソース</h2><p>公開YouTube / Webフィード。天気・予定とは別に管理します。</p></div>
        <button type="button" disabled={!canAdd} onClick={() => { setEditor('new'); setDeleting(null); setCollecting(false); }}>ソースを追加</button></div>
      {active.length === 0 && <p className={styles.empty}>ソースはまだ登録されていません。</p>}
      <ul className={styles.sourceList}>{active.map(entry => <li key={entry.id}>
        <div><strong>{entry.id}</strong><span className={styles.sourceState}>{!entry.source!.enabled ? '停止中' : entry.source!.consentExpiresAt <= data.preview.servedAt ? '同意期限切れ' : '同意あり'}</span>
          <p>{entry.source!.kind === 'youtube' ? 'YouTube' : 'Web'} · 同意期限 {date(entry.source!.consentExpiresAt)}</p><code>{entry.source!.locator}</code></div>
        <div className={styles.rowActions}><button type="button" aria-label={`${entry.id}を編集`} onClick={() => { setEditor(entry); setDeleting(null); setCollecting(false); }}>編集</button>
          <button type="button" aria-label={`${entry.id}を削除`} onClick={() => { setDeleting(entry.id); setEditor(null); setCollecting(false); }}>削除</button></div>
      </li>)}</ul>
      {data.sources.sources.length > active.length && <p className={styles.note}>削除済みID {data.sources.sources.length - active.length}件は再利用できません。遅れて届いた結果の復活を防ぐために保持しています。</p>}
      {deleting && <div role="group" aria-label="ソース削除の確認" className={styles.confirm}>
        <p><strong>{deleting}</strong> の設定と保存候補を削除します。同じIDは再利用できません。</p>
        <button type="button" onClick={() => void controller.revoke(deleting)}>設定と候補を削除する</button><button type="button" onClick={() => setDeleting(null)}>キャンセル</button>
      </div>}
      {editor && <SourceEditor key={editor === 'new' ? 'new' : editor.id} entry={editor === 'new' ? undefined : editor}
        onSave={(id, source) => void controller.save(id, source)} onClose={() => setEditor(null)} />}
    </section>
    <section aria-label="最近の操作履歴" className={styles.sources}><details><summary>最近の操作履歴（{data.audit.events.length}件）</summary>
      <p>直近{data.audit.capacity}件・最長{Math.floor(data.audit.retentionMs / 86400000)}日です。すべての試行を記録した完全な監査ではありません。</p>
      {data.audit.omittedThroughRevision > 0 && <p className={styles.note}>版 {data.audit.omittedThroughRevision} 以前の履歴は、この表示には残っていません。</p>}
      {!data.audit.events.length && <p>表示できる履歴はありません。</p>}
      <ol className={styles.auditList}>{[...data.audit.events].reverse().map(event => <li key={event.revision}><strong>{actionLabels[event.action]}</strong> · {event.sourceId} · 版 {event.revision}<br />
        <span>{date(event.at)} · 追加{event.added} / 更新{event.updated} / 変更なし{event.unchanged}{event.removed === undefined ? '' : ` / 消去${event.removed}`}{event.outcome ? ` · ${event.outcome}` : ''}</span></li>)}</ol>
    </details></section>
  </>;
}
