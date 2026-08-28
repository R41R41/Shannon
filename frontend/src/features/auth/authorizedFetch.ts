import { auth } from '../../firebase';

/** Bearer tokens are only sent to this app's API, never to arbitrary URLs. */
export async function authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!path.startsWith('/api/') || /[\\\r\n]/.test(path)) throw new Error('Invalid API path');
  if (window.location.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)) {
    throw new Error('HTTPS or loopback is required');
  }
  const user = auth.currentUser;
  if (!user) throw new Error('Login required');
  const token = await user.getIdToken();
  if (auth.currentUser?.uid !== user.uid) throw new Error('Session changed');
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(path, { ...init, headers, cache: 'no-store', credentials: 'omit', redirect: 'error' });
  if (!response.ok) throw new Error(`API request failed (${response.status})`);
  return response;
}
