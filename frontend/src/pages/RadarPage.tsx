import { useMemo, useState } from 'react';
import { signOut } from 'firebase/auth';
import { auth } from '../firebase';
import { useAuthSession } from '../features/auth/AuthSession';
import { authorizedFetch } from '../features/auth/authorizedFetch';
import { createRadarClient } from '../features/radar/radarClient';
import { RadarController } from '../features/radar/radarController';
import { RadarDashboard } from '../features/radar/RadarDashboard';

/** Separate from AgentProvider: opening Radar never starts operational WebSockets. */
export default function RadarPage() {
  const session = useAuthSession();
  if (session.loading || !session.user || !session.sessionKey || !session.expiresAt) return <p role="status">本人の認証を確認しています…</p>;
  return <SessionRadar key={session.sessionKey} expiresAt={session.expiresAt} isAdmin={session.user.isAdmin} />;
}
function SessionRadar({ expiresAt, isAdmin }: { expiresAt: number; isAdmin: boolean }) {
  const [logoutError, setLogoutError] = useState(false);
  const controller = useMemo(() => {
    const owner = auth.currentUser;
    const current = () => !!owner && auth.currentUser === owner && Date.now() < expiresAt;
    const client = createRadarClient(async (path, init) => {
      if (!current()) throw new Error('Session changed');
      const response = await authorizedFetch(path, init);
      if (!current()) throw new Error('Session changed');
      return response;
    });
    return new RadarController(client, current);
  }, [expiresAt]);
  return <>{logoutError && <p role="alert">ログアウトに失敗しました。表示は消去済みです。もう一度ログアウトしてください。</p>}
    <RadarDashboard controller={controller} isAdmin={isAdmin} onLogout={() => { setLogoutError(false); void signOut(auth).catch(() => setLogoutError(true)); }} /></>;
}
