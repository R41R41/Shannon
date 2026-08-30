import { useState, type FormEvent } from 'react';
import type { RadarController } from './radarController';
import { sourceIdValid } from './radarClient';
import { temporalInput, type TemporalEntry, type TemporalInput, type TemporalSources, type TemporalPreview, type CalendarEvent } from './temporalClient';
import styles from './RadarDashboard.module.scss';
// Open-Meteo WMO interpretation table: https://open-meteo.com/en/docs
const weatherLabels: Record<number,string> = {
  0:'快晴',1:'おおむね晴れ',2:'一部くもり',3:'くもり',45:'霧',48:'着氷性の霧',
  51:'弱い霧雨',53:'霧雨',55:'強い霧雨',56:'弱い着氷性の霧雨',57:'強い着氷性の霧雨',
  61:'弱い雨',63:'雨',65:'強い雨',66:'弱い着氷性の雨',67:'強い着氷性の雨',
  71:'弱い雪',73:'雪',75:'強い雪',77:'霧雪',80:'弱いにわか雨',81:'にわか雨',82:'激しいにわか雨',
  85:'弱いにわか雪',86:'強いにわか雪',95:'雷雨',96:'ひょうを伴う雷雨',99:'強いひょうを伴う雷雨',
};
const localDate = (time:number)=>{const d=new Date(time);return new Date(time-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
const when = (event:CalendarEvent,zone:string) => event.when.kind==='all-day'
  ? `${event.when.startDate} 〜 ${event.when.endDateExclusive}（終了日を含まない・終日）`
  : `${new Date(event.when.start).toLocaleString('ja-JP',{timeZone:zone})} 〜 ${new Date(event.when.end).toLocaleString('ja-JP',{timeZone:zone})}`;
export function TemporalRadarPanel({controller,sources,preview,canAdd}:{controller:RadarController;sources:TemporalSources;preview:TemporalPreview[];canAdd:boolean}) {
  const [editing,setEditing]=useState<TemporalEntry|TemporalInput['kind']|null>(null);
  const [deleting,setDeleting]=useState<string|null>(null);
  return <section aria-labelledby="temporal-title" className={styles.sources}>
    <div className={styles.sectionHeading}><div><h2 id="temporal-title">天気と予定</h2><p>あなたのための情報。公開カードや会話の記憶には使いません。</p></div></div>
    <div className={styles.temporalGrid}>{preview.map(entry=><article key={entry.sourceId} className={styles.card}>
      <p className={styles.sourceLabel}>{entry.sourceId} · {entry.timeZone}</p>
      <h3>{entry.content.kind==='weather'?'3日間の天気':'これからの予定'}</h3>
      {entry.content.kind==='weather'?<div className={styles.weatherDays}>{entry.content.items.map(day=><div key={day.date}>
        <strong>{day.date.slice(5)}</strong><span>{day.weatherCode===null?'天気不明':weatherLabels[day.weatherCode]??'天気不明'}</span>
        <span>{day.minimumC??'—'} / {day.maximumC??'—'} °C</span><span>降水 {day.precipitationPercent===null?'不明':`${day.precipitationPercent}%`}</span>
      </div>)}</div>:<>
        {!entry.content.items.length&&<p>この取得結果に表示できる予定はありません。すべての予定がないという意味ではありません。</p>}
        <ol className={styles.calendarEvents}>{entry.content.items.map(event=><li key={event.id}><strong>{event.title}</strong>
          <span>{when(event,entry.timeZone)}</span>{event.status==='tentative'&&<small>仮の予定</small>}</li>)}</ol>
      </>}
      {entry.content.partial&&<p className={styles.note}>一部の情報のみです。不明な項目や未掲載の予定があります。</p>}
      <p className={styles.note}>取得 {new Date(entry.content.fetchedAt).toLocaleTimeString('ja-JP')} · 保存期限 {new Date(entry.content.validUntil).toLocaleTimeString('ja-JP')}</p>
      <p className={styles.note}><a href={entry.content.providerUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" onClick={e=>{if(!controller.isReadable()){e.preventDefault();controller.clear();}}}>{entry.content.attribution}</a>
        {entry.content.kind==='weather'&&<> · <a href={entry.content.licenseUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">CC BY 4.0</a></>}</p>
    </article>)}</div>
    {!preview.length&&<p className={styles.empty}>天気・予定はまだ取得していないか、表示期限が切れています。設定後、上の取得欄から明示的に取得できます。</p>}
    <div className={styles.temporalActions}><button disabled={!sources.weatherAvailable||!canAdd} onClick={()=>{setEditing('weather');setDeleting(null);}}>天気の地域を追加</button>
      <button disabled={!sources.calendarAvailable||!sources.calendars.length||!canAdd} onClick={()=>{setEditing('calendar');setDeleting(null);}}>カレンダーを追加</button></div>
    <p className={styles.note}>{!sources.weatherAvailable?'天気の取得機能は未接続です。 ':''}{!sources.calendarAvailable?'Calendar連携は未接続です。Google認証はまだ開始できません。':sources.calendars.length?`接続済みカレンダー ${sources.calendars.length}件。本人に許可された接続だけ選べます。`:'接続済みカレンダーはありません。'}</p>
    <ul className={styles.sourceList}>{sources.sources.filter(e=>e.source).map(entry=><li key={entry.id}><div><strong>{entry.id}</strong>
      <span className={styles.sourceState}>{!entry.source!.enabled?'停止中':entry.source!.consentExpiresAt<=sources.servedAt?'同意期限切れ':'同意あり'}</span>
      <p>{entry.source!.kind==='weather'?`天気 · 緯度 ${entry.source!.latitudeTenth/10} / 経度 ${entry.source!.longitudeTenth/10}`:`Calendar · ${sources.calendars.find(c=>c.id===(entry.source as Extract<TemporalInput,{kind:'calendar'}>).bindingId)?.label??'接続を再確認してください'}`}</p>
      <p>{entry.source!.timeZone} · 同意期限 {new Date(entry.source!.consentExpiresAt).toLocaleString('ja-JP')}</p></div>
      <div className={styles.rowActions}><button aria-label={`${entry.id}を編集`} onClick={()=>{setEditing(entry);setDeleting(null);}}>編集</button>
        <button aria-label={`${entry.id}を削除`} onClick={()=>{setDeleting(entry.id);setEditing(null);}}>削除</button></div></li>)}</ul>
    {deleting&&<div className={styles.confirm} role="group" aria-label="天気・予定の削除確認"><p>{deleting} の設定と保存内容を削除します。IDと取得回数の履歴は残ります。</p>
      <button onClick={()=>void controller.revokeTemporal(deleting)}>天気・予定の設定を削除する</button><button onClick={()=>setDeleting(null)}>キャンセル</button></div>}
    {editing&&<TemporalEditor key={typeof editing==='string'?editing:editing.id} kind={typeof editing==='string'?editing:editing.source!.kind}
      entry={typeof editing==='string'?undefined:editing} choices={sources} onClose={()=>setEditing(null)} onSave={(id,value)=>void controller.saveTemporal(id,value)}/>}
  </section>;
}
function TemporalEditor({entry,kind,choices,onSave,onClose}:{entry?:TemporalEntry;kind:TemporalInput['kind'];choices:TemporalSources;onSave:(id:string,v:TemporalInput)=>void;onClose:()=>void}) {
  const source=entry?.source;
  const [id,setId]=useState(entry?.id??'');const [enabled,setEnabled]=useState(source?.enabled??false);
  const [until,setUntil]=useState(localDate(source?.consentExpiresAt??Date.now()+7*86400000));
  const [latitude,setLatitude]=useState(source?.kind==='weather'?String(source.latitudeTenth/10):'');
  const [longitude,setLongitude]=useState(source?.kind==='weather'?String(source.longitudeTenth/10):'');
  const [zone,setZone]=useState(source?.timeZone??'Asia/Tokyo');const [binding,setBinding]=useState(source?.kind==='calendar'?source.bindingId:'');
  const [days,setDays]=useState(source?.kind==='calendar'?source.days:3);const [error,setError]=useState('');
  const submit=(e:FormEvent)=>{e.preventDefault();setError('');try{
    const consentExpiresAt=Date.parse(until);if(!sourceIdValid(id)||consentExpiresAt<=Date.now()||consentExpiresAt>Date.now()+30*86400000)throw Error();
    const selected=choices.calendars.find(c=>c.id===binding);
    if(kind==='calendar'&&enabled&&!selected)throw Error();
    const coordinate=(v:string)=>{if(!v.trim())throw Error();const n=Number(v)*10;if(!Number.isFinite(n)||Math.abs(n-Math.round(n))>1e-7)throw Error();return Math.round(n);};
    const input=temporalInput({enabled,consentExpiresAt,timeZone:kind==='calendar'?(selected?.timeZone??zone):zone,
      ...(kind==='weather'?{kind,latitudeTenth:coordinate(latitude),longitudeTenth:coordinate(longitude)}:{kind,bindingId:binding,days})});
    onSave(id,input);
  }catch{setError('ID・0.1度刻みの地域・タイムゾーン・接続先・30日以内の同意期限を確認してください。');}};
  return <form className={styles.editor} onSubmit={submit} autoComplete="off"><div className={styles.sectionHeading}><h3>{kind==='weather'?'天気の地域設定':'カレンダー設定'}</h3><button type="button" onClick={onClose}>閉じる</button></div>
    <p>設定保存では取得しません。内容は本人専用で、Discordへ送信しません。</p>
    <div className={styles.fields}><label>設定ID<input required maxLength={128} disabled={!!entry} value={id} onChange={e=>setId(e.target.value)} placeholder={kind==='weather'?'my-weather':'my-calendar'}/></label>
      {kind==='weather'?<><label>地域のタイムゾーン<input required maxLength={100} value={zone} onChange={e=>setZone(e.target.value)}/></label>
        <label>緯度（0.1度刻み）<input required type="number" step="0.1" min={-90} max={90} value={latitude} onChange={e=>setLatitude(e.target.value)}/></label>
        <label>経度（0.1度刻み）<input required type="number" step="0.1" min={-180} max={180} value={longitude} onChange={e=>setLongitude(e.target.value)}/></label>
        <p className={styles.full}>位置情報は自動取得しません。明示した粗い座標が天気サービスへ送られます。住所は入力しないでください。</p></>:<>
        <label>接続済みカレンダー<select required value={binding} onChange={e=>{setBinding(e.target.value);const c=choices.calendars.find(c=>c.id===e.target.value);if(c)setZone(c.timeZone);}}>
          <option value="">選択してください</option>{binding&&!choices.calendars.some(c=>c.id===binding)&&<option value={binding}>現在の接続（再確認が必要）</option>}
          {choices.calendars.map(c=><option key={c.id} value={c.id}>{c.label} · {c.timeZone}</option>)}</select></label>
        <label>取得範囲<select value={days} onChange={e=>setDays(Number(e.target.value))}>{[1,2,3,4,5,6,7].map(n=><option key={n} value={n}>{n}日先まで</option>)}</select></label>
        <p className={styles.full}>読み取りのみ・最大20件。場所・参加者・説明は保存しません。Google権限の解除は設定削除とは別です。</p></>}
      <label>同意期限（端末の現地時刻）<input required type="datetime-local" value={until} onChange={e=>setUntil(e.target.value)}/></label></div>
    <label className={styles.consent}><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/>この設定を期限まで本人専用の情報取得に使うことに同意する</label>
    <p className={styles.note}>変更すると保存内容は消えます。取得回数は戻りません。自動取得・通知への同意ではありません。</p>
    {error&&<p role="alert" className={styles.error}>{error}</p>}<button type="submit" className={styles.primary}>天気・予定の設定を保存</button>
  </form>;
}
