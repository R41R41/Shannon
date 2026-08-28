import { StrictMode, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RadarDashboard } from '../../../src/features/radar/RadarDashboard';
import { RadarController } from '../../../src/features/radar/radarController';
import { createRadarClient } from '../../../src/features/radar/radarClient';
import '../../../src/styles/global.scss';

/** Synthetic fixture entry, outside production src. No Firebase, secrets, storage, real connector or app providers. */
function Fixture() {
  const [user, setUser] = useState<string | null>('alice'); const [mode, setMode] = useState('normal');
  return <><aside style={{ padding: '10px 18px', background: '#253d38', color: 'white', font: '12px system-ui', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
    <strong>隔離テスト · 架空データのみ · {user ?? 'ログアウト中'} · {mode}</strong>
    <button onClick={() => { setMode('normal'); setUser('alice'); }}>テストA</button><button onClick={() => { setMode('normal'); setUser('bob'); }}>テストB</button>
    <button onClick={() => setMode('expiry')}>期限切れを再現</button><button onClick={() => setMode('conflict')}>競合を再現</button>
    <button onClick={() => setMode('slow')}>遅い応答を再現</button><button onClick={() => setMode('unavailable')}>API未登録を再現</button>
  </aside>{user ? <FixtureSession key={`${user}:${mode}`} user={user} mode={mode} logout={() => setUser(null)} /> : <p role="status">ログアウトしました。本人データは表示しません。</p>}</>;
}
function FixtureSession({ user, mode, logout }: { user: string; mode: string; logout: () => void }) {
  const controller = useMemo(() => new RadarController(createRadarClient(async (path, init) => {
    if (mode === 'unavailable') return new Response('{}', { status: 404 });
    if (mode === 'conflict' && init.method !== 'GET') return new Response('{}', { status: 409 });
    const response = await fetch(path, { ...init, headers: { ...init.headers, Authorization: `Bearer fixture-${user}` } });
    if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 2500));
    if (mode === 'expiry' && path.endsWith('/preview') && response.ok) {
      const body = await response.json(); return new Response(JSON.stringify({ ...body, validUntil: body.servedAt + 2000 }));
    }
    return response;
  }), () => true), [user, mode]);
  return <RadarDashboard controller={controller} onLogout={logout} />;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>);
