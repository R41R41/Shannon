import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { onIdTokenChanged } from 'firebase/auth';
import type { UserInfo } from '@common/types/web';
import { auth } from '../../firebase';
import { URLS } from '../../services/config/ports';
import { verifyWebSession } from './authClient';

type Session = { user: UserInfo | null; loading: boolean; error: string | null };
const AuthSessionContext = createContext<Session | null>(null);
export function AuthSessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>({ user: null, loading: true, error: null });
  useEffect(() => {
    localStorage.removeItem('isAuthenticated');
    localStorage.removeItem('userInfo');
    let pending: AbortController | undefined;
    const unsubscribe = onIdTokenChanged(auth, user => {
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      if (!user) { setSession({ user: null, loading: false, error: null }); return; }
      setSession({ user: null, loading: true, error: null });
      void (async () => {
        try {
          const idToken = await user.getIdToken();
          if (controller.signal.aborted) return;
          const profile = await verifyWebSession(URLS.WEBSOCKET.AUTH, idToken, controller.signal);
          if (!controller.signal.aborted && auth.currentUser?.uid === user.uid) {
            setSession({ user: profile, loading: false, error: null });
          }
        } catch (error) {
          if (!controller.signal.aborted) setSession({ user: null, loading: false,
            error: error instanceof Error ? error.message : '認証できませんでした' });
        }
      })();
    });
    return () => { pending?.abort(); unsubscribe(); };
  }, []);
  return <AuthSessionContext.Provider value={session}>{children}</AuthSessionContext.Provider>;
}
export function useAuthSession(): Session {
  const session = useContext(AuthSessionContext);
  if (!session) throw new Error('AuthSessionProvider is required');
  return session;
}
