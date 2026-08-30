import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { onIdTokenChanged } from 'firebase/auth';
import type { UserInfo } from '@common/types/web';
import { auth } from '../../firebase';
import { URLS } from '../../services/config/ports';
import { verifyWebSession } from './authClient';

type Session = { user: UserInfo | null; loading: boolean; error: string | null; sessionKey?: string; expiresAt?: number };
const AuthSessionContext = createContext<Session | null>(null);
export function AuthSessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>({ user: null, loading: true, error: null });
  useEffect(() => {
    localStorage.removeItem('isAuthenticated');
    localStorage.removeItem('userInfo');
    let pending: AbortController | undefined;
    let generation = 0;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = onIdTokenChanged(auth, user => {
      pending?.abort();
      clearTimeout(expiry);
      const epoch = ++generation;
      const controller = new AbortController();
      pending = controller;
      if (!user) { setSession({ user: null, loading: false, error: null }); return; }
      setSession({ user: null, loading: true, error: null });
      void (async () => {
        try {
          const token = await user.getIdTokenResult();
          const expiresAt = Date.parse(token.expirationTime);
          if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('認証期限が切れました');
          if (controller.signal.aborted) return;
          const profile = await verifyWebSession(URLS.WEBSOCKET.AUTH, token.token, controller.signal);
          if (!controller.signal.aborted && auth.currentUser === user) {
            if (expiresAt <= Date.now()) throw new Error('認証期限が切れました');
            setSession({ user: profile, loading: false, error: null, expiresAt,
              sessionKey: JSON.stringify([auth.app.options.projectId, user.uid, epoch]) });
            expiry = setTimeout(() => {
              controller.abort();
              setSession({ user: null, loading: false, error: '認証期限が切れました。再ログインしてください' });
            }, Math.min(2147483647, expiresAt - Date.now()));
          }
        } catch (error) {
          if (!controller.signal.aborted) setSession({ user: null, loading: false,
            error: error instanceof Error ? error.message : '認証できませんでした' });
        }
      })();
    });
    return () => { pending?.abort(); clearTimeout(expiry); unsubscribe(); };
  }, []);
  return <AuthSessionContext.Provider value={session}>{children}</AuthSessionContext.Provider>;
}
export function useAuthSession(): Session {
  const session = useContext(AuthSessionContext);
  if (!session) throw new Error('AuthSessionProvider is required');
  return session;
}
