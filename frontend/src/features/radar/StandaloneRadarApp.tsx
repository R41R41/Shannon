import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from 'react';
import { StandaloneRadarSession, type RadarIdentityClient } from './standaloneSession';
import { RadarDashboard } from './RadarDashboard';
import styles from './RadarDashboard.module.scss';

export function StandaloneRadarApp({ identity }: { identity: RadarIdentityClient }) {
  const session = useMemo(() => new StandaloneRadarSession(identity), [identity]);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  useEffect(() => { session.start(); return () => session.stop(); }, [session]);
  if (state.kind === 'ready') return <RadarDashboard controller={state.controller} onLogout={() => { void session.logout(); }} />;
  return <main className={styles.page}><p>SHANNON / PERSONAL</p><h1>Radar にログイン</h1>
    <p>個人Radar専用です。Bot・会話・自動投稿は起動しません。</p>
    {state.kind === 'verifying' ? <p role="status">本人の利用許可を確認しています…</p> : <LoginForm session={session} />}
    {state.kind === 'error' && <p role="alert">{state.error}</p>}
    <p>許可済みの開発アカウントを使用してください。ログイン情報はブラウザの永続ストレージへ保存しません。</p>
  </main>;
}
function LoginForm({ session }: { session: StandaloneRadarSession }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const submit = (event: FormEvent) => { event.preventDefault(); const value = password; setPassword(''); void session.login(email, value); };
  return <form onSubmit={submit} className={styles.editor}><div className={styles.fields}>
    <label>メールアドレス<input type="email" required maxLength={254} autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} /></label>
    <label>パスワード<input type="password" required maxLength={256} autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
  </div><button type="submit" className={styles.primary}>ログイン</button></form>;
}
