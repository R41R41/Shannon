import { auth } from '../../firebase';

export class ApiRequestError extends Error {
  constructor(readonly status: number) { super(`API request failed (${status})`); }
}

/** Bearer tokens are only sent to this app's API, never to arbitrary URLs. */
export async function authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!path.startsWith('/api/') || /[\\\r\n]/.test(path)) throw new Error('Invalid API path');
  if (window.location.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)) {
    throw new Error('HTTPS or loopback is required');
  }
  const user = auth.currentUser;
  if (!user) throw new Error('Login required');
  const request = { ...init, headers: new Headers(init.headers) };
  if (request.signal?.aborted) throw new Error('Request cancelled');
  const token = await user.getIdToken();
  if (auth.currentUser !== user) throw new Error('Session changed');
  if (request.signal?.aborted) throw new Error('Request cancelled');
  const headers = request.headers;
  headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(path, { ...request, headers, cache: 'no-store', credentials: 'omit', redirect: 'error' });
  if (auth.currentUser !== user) throw new Error('Session changed');
  if (request.signal?.aborted) throw new Error('Request cancelled');
  if (!response.ok) throw new ApiRequestError(response.status);
  return response;
}
