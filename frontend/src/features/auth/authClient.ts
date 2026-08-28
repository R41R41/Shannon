import type { UserInfo } from '@common/types/web';

/** One socket per verification. No token persistence, shared mutable login or reconnect loop. */
export function verifyWebSession(url: string, idToken: string, signal: AbortSignal): Promise<UserInfo> {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(url);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
    if (endpoint.protocol !== 'wss:' && !(endpoint.protocol === 'ws:' && loopback)) {
      reject(new Error('認証にはHTTPS/WSSまたはlocalhost接続が必要です')); return;
    }
    if (signal.aborted) { reject(new Error('認証を中断しました')); return; }
    const socket = new WebSocket(url);
    let finished = false;
    const finish = (error?: Error, user?: UserInfo) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      socket.close();
      if (error) reject(error); else resolve(user!);
    };
    const abort = () => finish(new Error('認証を中断しました'));
    const timer = setTimeout(() => finish(new Error('認証サーバーに接続できません')), 15_000);
    signal.addEventListener('abort', abort, { once: true });
    socket.onopen = () => socket.send(JSON.stringify({ type: 'auth:check', idToken }));
    socket.onerror = () => finish(new Error('認証サーバーに接続できません'));
    socket.onclose = () => finish(new Error('認証接続が切断されました'));
    socket.onmessage = event => {
      try {
        const data = JSON.parse(String(event.data));
        if (data.type !== 'auth:response') return;
        const user = data.userData;
        if (data.success !== true || !user || typeof user.name !== 'string' || typeof user.email !== 'string' || typeof user.isAdmin !== 'boolean') {
          finish(new Error(data.error === 'AUTH_UNAVAILABLE' ? '認証サーバーの設定または接続を確認してください' : 'アクセス権限がありません'));
          return;
        }
        finish(undefined, { name: user.name, email: user.email, isAdmin: user.isAdmin });
      } catch { finish(new Error('認証応答が不正です')); }
    };
  });
}
