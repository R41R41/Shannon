import { useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { signInWithPopup, GoogleAuthProvider, browserPopupRedirectResolver } from 'firebase/auth';
import styles from './Login.module.scss';
import { auth } from '../firebase';
import { useAuthSession } from '../features/auth/AuthSession';

export default function Login() {
  const { user, loading, error } = useAuthSession();
  const location = useLocation();
  const [loginError, setLoginError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  if (user) return <Navigate to={location.state?.from?.pathname === '/radar' || !user.isAdmin ? '/radar' : '/shannonUI'} replace />;
  const login = async () => {
    setSigningIn(true); setLoginError(null);
    try { await signInWithPopup(auth, new GoogleAuthProvider(), browserPopupRedirectResolver); }
    catch { setLoginError('ログインに失敗しました'); }
    finally { setSigningIn(false); }
  };
  return <div className={styles.container}><div className={styles.form}>
    <h1>ShannonUI</h1>
    {loading && <p role="status">認証を確認しています…</p>}
    {(error || loginError) && <p role="alert">{loginError || error}</p>}
    <button type="button" onClick={login} disabled={loading || signingIn} className={styles.googleButton}>Googleでログイン</button>
  </div></div>;
}
