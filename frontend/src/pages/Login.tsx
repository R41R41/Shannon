import React, { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import styles from "./Login.module.scss";
import { auth } from "../firebase";
import {
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  browserPopupRedirectResolver
} from "firebase/auth";
import { AuthAgent } from "@/services/agents/authAgent";
import { UserInfo } from "@common/types/web";

const Login: React.FC = () => {
  const navigate = useNavigate();
  const provider = new GoogleAuthProvider();
  const authAgent = AuthAgent.getInstance();

  useEffect(() => {
    // WebSocket接続を確立
    authAgent.connect();

    // 認証結果のコールバックを設定
    const unsubAuth = authAgent.onAuthResponse((success, userData) => {
      if (success && auth.currentUser && userData) {
        const userInfo: UserInfo = {
          name: userData.name,
          email: userData.email,
          isAdmin: userData.isAdmin,
        };
        localStorage.setItem("userInfo", JSON.stringify(userInfo));
        localStorage.setItem("isAuthenticated", "true");
        navigate("/shannonUI");
      } else {
        auth.signOut();
        alert("アクセス権限がありません");
      }
    });

    // Google認証の状態監視
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user?.email) {
        try {
          authAgent.checkAuth(user.email);
        } catch (error) {
          console.error("Auth check error:", error);
          auth.signOut();
          alert("認証エラーが発生しました");
        }
      }
    });

    return () => {
      unsubAuth();
      unsubscribe();
      authAgent.disconnect();
    };
  }, [navigate, authAgent]);

  const handleGoogleLogin = async () => {
    try {
      await signInWithPopup(auth, provider, browserPopupRedirectResolver);
    } catch (error) {
      console.error("Google login error:", error);
      alert("ログインに失敗しました");
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.form}>
        <h1>ShannonUI</h1>
        <button
          type="button"
          onClick={handleGoogleLogin}
          className={styles.googleButton}
        >
          Googleでログイン
        </button>
      </div>
    </div>
  );
};

export default Login;
