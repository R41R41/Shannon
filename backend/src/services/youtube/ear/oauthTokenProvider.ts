import type { OAuth2Client } from 'google-auth-library';
import type { TokenProvider } from './youtubeLiveApi.js';

/**
 * A token provider over an OAuth client that holds the refresh token (google-auth-library, as the runtime's YouTube client does).
 * `forceRefresh` is asked for after YouTube refused a token: the cached one is marked expired so the next call refreshes it.
 */
export function oauthTokenProvider(client: OAuth2Client): TokenProvider {
  return async (forceRefresh = false) => {
    if (forceRefresh) client.credentials = { ...client.credentials, expiry_date: Date.now() - 1 };
    const { token } = await client.getAccessToken();
    if (!token) throw new Error('no access token');
    return token;
  };
}
