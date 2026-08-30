import { useState, type FormEvent } from 'react';
import { sourceIdValid, sourceInput, type SourceEntry, type SourceInput } from './radarClient';
import styles from './RadarDashboard.module.scss';

const localDateTime = (time: number) => { const d = new Date(time); return new Date(time - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
export function SourceEditor({ entry, onSave, onClose }: {
  entry?: SourceEntry; onSave: (id: string, source: SourceInput) => void; onClose: () => void;
}) {
  const source = entry?.source;
  const [id, setId] = useState(entry?.id ?? '');
  const [kind, setKind] = useState<SourceInput['kind']>(source?.kind ?? 'youtube');
  const [locator, setLocator] = useState(source?.locator ?? '');
  const [hosts, setHosts] = useState(source?.articleHosts.join(', ') ?? '');
  const [topics, setTopics] = useState(source?.topicIds.join(', ') ?? '');
  const [enabled, setEnabled] = useState(source?.enabled ?? false);
  const [until, setUntil] = useState(localDateTime(source?.consentExpiresAt ?? Date.now() + 7 * 86400000));
  const [retention, setRetention] = useState(source?.retentionMs ?? 86400000);
  const [count, setCount] = useState(source?.maxItems ?? 10);
  const [error, setError] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault(); setError('');
    try {
      const consentExpiresAt = Date.parse(until);
      if (!sourceIdValid(id) || !Number.isFinite(consentExpiresAt) || consentExpiresAt <= Date.now() || consentExpiresAt > Date.now() + 30 * 86400000) throw new Error();
      const input = sourceInput({ enabled, consentExpiresAt, kind, locator: locator.trim(),
        articleHosts: kind === 'youtube' ? ['www.youtube.com'] : hosts.split(',').map(h => h.trim()).filter(Boolean),
        topicIds: topics.split(',').map(t => t.trim()).filter(Boolean), maxItems: count, retentionMs: retention });
      onSave(id, input);
    } catch { setError('入力を確認してください。ID・トピックは半角英数字など、同意期限は今から30日以内です。'); }
  };
  return <form className={styles.editor} onSubmit={submit} autoComplete="off">
    <div className={styles.sectionHeading}><h2>{entry ? 'ソースを編集' : 'ソースを追加'}</h2><button type="button" onClick={onClose}>閉じる</button></div>
    <p>公開フィードの設定だけを保存します。この操作で情報取得や通知は始まりません。</p>
    <details className={styles.note}><summary>登録できる値の確認方法</summary>
      <p><strong>YouTube：</strong>チャンネルページのURLや @handle ではなく、<code>UC</code>で始まる24文字の公開チャンネルIDを入力します。</p>
      <p><strong>Web：</strong>ブラウザで読める記事ページではなく、HTTPSのRSS / AtomフィードURLを入力します。記事リンクの許可ホストには、フィード内の記事URLで使われるホスト名だけを指定します。</p>
    </details>
    <div className={styles.fields}>
      <label>ソースID<input required maxLength={128} value={id} disabled={!!entry} onChange={e => setId(e.target.value)} placeholder="my-youtube" /></label>
      <label>種類<select value={kind} onChange={e => { setKind(e.target.value as SourceInput['kind']); setLocator(''); }}><option value="youtube">YouTube</option><option value="web">Web RSS / Atom</option></select></label>
      <label className={styles.full}>{kind === 'youtube' ? 'YouTubeチャンネルID' : '公開フィードURL'}<input required maxLength={2048} value={locator} onChange={e => setLocator(e.target.value)} placeholder={kind === 'youtube' ? 'UCで始まる24文字のID' : 'https://example.org/feed.xml'} /></label>
      {kind === 'web' && <label className={styles.full}>記事リンクの許可ホスト<input required maxLength={2530} value={hosts} onChange={e => setHosts(e.target.value)} placeholder="example.org, news.example.org" /><small>カンマ区切りで完全一致。秘密・署名付きURLは登録しないでください。</small></label>}
      <label className={styles.full}>トピックID（任意）<input maxLength={1290} value={topics} onChange={e => setTopics(e.target.value)} placeholder="nintendo, splatoon" /><small>本人が選ぶ分類です。年齢・性別などの属性を推測・登録する欄ではありません。</small></label>
      <label>同意期限（端末の現地時刻）<input required type="datetime-local" value={until} onChange={e => setUntil(e.target.value)} /></label>
      <label>取得結果の保持上限<select value={retention} onChange={e => setRetention(Number(e.target.value))}>{![86400000, 259200000, 604800000].includes(retention) && <option value={retention}>現在の設定（{Math.round(retention / 60000)}分）</option>}<option value={86400000}>1日</option><option value={259200000}>3日</option><option value={604800000}>7日</option></select></label>
      <label>1回の候補上限<input required type="number" min={1} max={20} value={count} onChange={e => setCount(Number(e.target.value))} /></label>
    </div>
    <label className={styles.consent}><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />このソースを、上記期限まで私の候補として使うことに同意する</label>
    <p className={styles.note}>変更すると、このソースの保存済み候補は消去されます。設定保存は定期取得・Discord投稿の許可ではありません。</p>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <button className={styles.primary} type="submit">設定を保存</button>
  </form>;
}
