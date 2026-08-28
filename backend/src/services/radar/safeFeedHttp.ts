import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';

export class FeedReadError extends Error {
  constructor(readonly code: 'target' | 'dns' | 'timeout' | 'aborted' | 'http' | 'format' | 'size' | 'network') { super(`RADAR_FEED_${code.toUpperCase()}`); }
}
export interface FeedHttpPort { get(url: string, signal: AbortSignal): Promise<string>; }
export const MAX_FEED_BYTES = 256 * 1024;
const TIMEOUT_MS = 8000;
/** Exact public HTTPS URL. Redirects and non-default ports are deliberately unsupported. */
export function publicFeedUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new FeedReadError('target'); }
  if (typeof input !== 'string' || input.length > 2048 || /[\s\\\x00-\x1f]/.test(input)
    || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
    || isIP(url.hostname) || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,63}$/.test(url.hostname)
    || /\.(?:localhost|local|internal|test|invalid)$/.test(url.hostname)) throw new FeedReadError('target');
  return url;
}
/** Conservative IPv4-only transport. Reject mixed public/private DNS answers and Azure's platform VIP. */
export function publicIPv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return a !== 0 && a !== 10 && a !== 127 && a < 224
    && !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254)
    && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
    && !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    && !(a === 203 && b === 0 && c === 113) && address !== '168.63.129.16';
}
type RequestFactory = (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
const abortError = (signal: AbortSignal) => signal.reason instanceof FeedReadError ? signal.reason : new FeedReadError('aborted');
function whileActive<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    if (signal.aborted) { reject(abortError(signal)); return; }
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
/** No I/O at construction. No cookies, OAuth, inherited agent, redirect, retry or decompression. */
export class SafeFeedHttp implements FeedHttpPort {
  constructor(
    private readonly resolveIPv4: (host: string) => Promise<readonly string[]> = async host => (await lookup(host, { family: 4, all: true })).map(a => a.address),
    private readonly makeRequest: RequestFactory = request,
    private readonly representation: 'xml' | 'json' = 'xml',
  ) {}
  async get(input: string, caller: AbortSignal): Promise<string> {
    const url = publicFeedUrl(input);
    if (!['xml', 'json'].includes(this.representation)) throw new FeedReadError('format');
    const types = this.representation === 'json' ? ['application/json']
      : ['application/atom+xml', 'application/rss+xml', 'application/xml', 'text/xml'];
    if (caller.aborted) throw new FeedReadError('aborted');
    const control = new AbortController();
    const cancel = () => control.abort(new FeedReadError('aborted'));
    caller.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => control.abort(new FeedReadError('timeout')), TIMEOUT_MS);
    try {
      const addresses = await whileActive(this.resolveIPv4(url.hostname), control.signal);
      if (!addresses.length || !addresses.every(publicIPv4)) throw new FeedReadError('dns');
      if (control.signal.aborted) throw abortError(control.signal);
      // Pin the checked address in the actual socket lookup, preserving original hostname/SNI/TLS verification.
      return await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = []; let bytes = 0; let settled = false;
        let req: ClientRequest | undefined;
        const finish = (error?: Error, body?: string) => {
          if (settled) return;
          settled = true; control.signal.removeEventListener('abort', abort);
          if (error) { reject(error); req?.destroy(); } else resolve(body ?? '');
        };
        const abort = () => finish(abortError(control.signal));
        control.signal.addEventListener('abort', abort, { once: true });
        req = this.makeRequest(url, { method: 'GET', agent: false, family: 4, servername: url.hostname,
          rejectUnauthorized: true, maxHeaderSize: 8192,
          lookup: (_host, _options, done) => done(null, addresses[0], 4),
          headers: { accept: types.join(', '),
            'accept-encoding': 'identity', 'user-agent': 'ShannonRadar/0.1 (read-only)' } }, response => {
          if (response.statusCode !== 200) { response.destroy(); finish(new FeedReadError('http')); return; }
          const type = response.headers['content-type']?.split(';')[0].trim().toLowerCase();
          const encoding = response.headers['content-encoding'];
          if (!types.includes(type ?? '')
            || (encoding && encoding !== 'identity')) { response.destroy(); finish(new FeedReadError('format')); return; }
          const length = Number(response.headers['content-length']);
          if (Number.isFinite(length) && length > MAX_FEED_BYTES) { response.destroy(); finish(new FeedReadError('size')); return; }
          response.on('data', (chunk: Buffer) => {
            if (settled) return;
            bytes += chunk.length;
            if (bytes > MAX_FEED_BYTES) { response.destroy(); finish(new FeedReadError('size')); return; }
            chunks.push(Buffer.from(chunk));
          });
          response.on('end', () => {
            if (!response.complete) { finish(new FeedReadError('network')); return; }
            try { finish(undefined, new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
            catch { finish(new FeedReadError('format')); }
          });
          response.on('error', () => finish(new FeedReadError('network')));
          response.on('aborted', () => finish(new FeedReadError('network')));
          response.on('close', () => { if (!response.complete) finish(new FeedReadError('network')); });
        });
        req.on('error', () => finish(new FeedReadError('network')));
        if (settled) req.destroy(); else if (control.signal.aborted) abort(); else req.end();
      });
    } catch (error) {
      throw error instanceof FeedReadError ? error : new FeedReadError('network');
    } finally { clearTimeout(timer); caller.removeEventListener('abort', cancel); }
  }
}

/** Same public DNS-pinned GET limits as feeds, but JSON only; never accepts auth headers. */
export class SafePublicJsonHttp extends SafeFeedHttp {
  constructor(resolveIPv4?: (host: string) => Promise<readonly string[]>, makeRequest?: RequestFactory) {
    super(resolveIPv4, makeRequest, 'json');
  }
}
