import { useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { signInWithEmailAndPassword, signInWithPopup, GoogleAuthProvider, browserPopupRedirectResolver } from 'firebase/auth';
import styles from './Login.module.scss';
import { auth } from '../firebase';
import { useAuthSession } from '../features/auth/AuthSession';

export default function Login() {
  const { user, loading, error } = useAuthSession();
  const location = useLocation();
  const [loginError, setLoginError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  if (user) return <Navigate to={location.state?.from?.pathname === '/radar' || !user.isAdmin ? '/radar' : '/shannonUI'} replace />;
  const loginWithGoogle = async () => {
    setSigningIn(true); setLoginError(null);
    try { await signInWithPopup(auth, new GoogleAuthProvider(), browserPopupRedirectResolver); }
    catch { setLoginError('ログインに失敗しました'); }
    finally { setSigningIn(false); }
  };
  const loginWithPassword = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSigningIn(true); setLoginError(null);
    try { await signInWithEmailAndPassword(auth, email.trim(), password); }
    catch { setLoginError('メールアドレスまたはパスワードが正しくありません'); }
    finally { setPassword(''); setSigningIn(false); }
  };
  return <div className={styles.container}><div className={styles.form}>
    <h1>ShannonUI</h1>
    {loading && <p role="status">認証を確認しています…</p>}
    {(error || loginError) && <p role="alert">{loginError || error}</p>}
    <form onSubmit={loginWithPassword}>
      <label htmlFor="email">メールアドレス</label>
      <input id="email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} disabled={loading || signingIn} className={styles.input} />
      <label htmlFor="password">パスワード</label>
      <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} disabled={loading || signingIn} className={styles.input} />
      <button type="submit" disabled={loading || signingIn} className={styles.button}>メールアドレスでログイン</button>
    </form>
    <button type="button" onClick={loginWithGoogle} disabled={loading || signingIn} className={styles.googleButton}>Googleでログイン</button>
  </div></div>;
}
