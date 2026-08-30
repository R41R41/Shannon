import { createRoot } from 'react-dom/client';
import { initializeApp } from 'firebase/app';
import { initializeAuth, inMemoryPersistence, onIdTokenChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { StandaloneRadarApp } from './features/radar/StandaloneRadarApp';
import './styles/global.scss';

async function boot() {
  if (location.protocol !== 'https:' && location.hostname !== '127.0.0.1') throw Error();
  const response = await fetch('/api/radar/runtime', { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10000) });
  const value = await response.json(); const f = value?.firebase;
  if (!response.ok || value.version !== 1 || !f || typeof f.projectId !== 'string' || f.projectId === 'shannonui'
    || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(f.projectId) || typeof f.apiKey !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(f.apiKey)
    || typeof f.appId !== 'string' || !/^1:\d+:web:[a-f0-9]+$/.test(f.appId)) throw Error();
  const app = initializeApp({ projectId: f.projectId, apiKey: f.apiKey, appId: f.appId }, 'shannon-radar-standalone');
  const auth = initializeAuth(app, { persistence: inMemoryPersistence });
  createRoot(document.getElementById('root')!).render(<StandaloneRadarApp identity={{
    projectId: f.projectId, currentUser: () => auth.currentUser, observe: callback => onIdTokenChanged(auth, callback),
    signIn: async (email, password) => { await signInWithEmailAndPassword(auth, email, password); }, signOut: () => signOut(auth),
  }} />);
}
void boot().catch(() => { createRoot(document.getElementById('root')!).render(<main><h1>Radar</h1><p role="alert">開発用の接続設定を確認できませんでした。管理者へ確認してください。</p></main>); });
