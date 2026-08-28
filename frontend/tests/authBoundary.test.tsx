import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
const mocks = vi.hoisted(() => ({ auth: { currentUser: null as null | { uid: string; getIdToken: () => Promise<string> } }, session: { user: null as null | { name: string; email: string; isAdmin: boolean }, loading: false, error: null } }));
vi.mock('../src/firebase', () => ({ auth: mocks.auth }));
vi.mock('../src/features/auth/AuthSession', () => ({ useAuthSession: () => mocks.session }));
import { verifyWebSession } from '../src/features/auth/authClient';
import { authorizedFetch } from '../src/features/auth/authorizedFetch';
import AuthGuard from '../src/components/AuthGuard/AuthGuard';
import { WebSocketClientBase } from '../src/services/common/WebSocketClient';

class FakeSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = FakeSocket.CONNECTING;
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(public url: string) { FakeSocket.instances.push(this); }
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; this.readyState = FakeSocket.CLOSED; this.onclose?.(); }
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
beforeEach(() => {
  FakeSocket.instances = []; mocks.auth.currentUser = null; mocks.session.user = null; mocks.session.loading = false;
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('window', { location: { protocol: 'https:', hostname: 'shannon.example.test' } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('auth client', () => {
  it('sends the token only after open and accepts only a validated profile response', async () => {
    const promise = verifyWebSession('wss://shannon.example.test/ws/auth', 'id-token', new AbortController().signal);
    const socket = FakeSocket.instances[0]; expect(socket.sent).toEqual([]);
    socket.onopen?.(); expect(JSON.parse(socket.sent[0])).toEqual({ type: 'auth:check', idToken: 'id-token' });
    socket.message({ type: 'auth:response', success: true, userData: { name: 'Test', email: 'test@example.test', isAdmin: false } });
    expect(await promise).toEqual({ name: 'Test', email: 'test@example.test', isAdmin: false }); expect(socket.closed).toBe(true);
  });
  it('abort closes a pending socket and a late callback cannot complete the old login', async () => {
    const controller = new AbortController(); const promise = verifyWebSession('ws://127.0.0.1/auth', 'token', controller.signal);
    const socket = FakeSocket.instances[0]; const rejected = expect(promise).rejects.toThrow('中断'); controller.abort(); await rejected;
    expect(socket.closed).toBe(true); expect(socket.onmessage).toBeNull();
  });
  it.each([false, 'true'])('does not treat a rejected or malformed success field as authorization', async success => {
    const promise = verifyWebSession('wss://example.test/auth', 'token', new AbortController().signal);
    const rejected = expect(promise).rejects.toThrow('アクセス権限');
    FakeSocket.instances[0].message({ type: 'auth:response', success, userData: { name: 'X', email: 'x', isAdmin: true } }); await rejected;
  });
  it('times out without reconnecting or retaining the credential', async () => {
    vi.useFakeTimers(); const promise = verifyWebSession('wss://example.test/auth', 'token', new AbortController().signal);
    const rejected = expect(promise).rejects.toThrow('接続'); await vi.advanceTimersByTimeAsync(15000); await rejected;
    expect(FakeSocket.instances).toHaveLength(1); expect(FakeSocket.instances[0].closed).toBe(true);
  });
  it('does not send credentials over a non-loopback plaintext connection', async () => {
    await expect(verifyWebSession('ws://example.test/auth', 'token', new AbortController().signal)).rejects.toThrow('HTTPS');
    expect(FakeSocket.instances).toHaveLength(0);
  });
});

describe('authenticated HTTP client', () => {
  it('sends the current ID token and rejects unsuccessful operations', async () => {
    mocks.auth.currentUser = { uid: 'uid', getIdToken: async () => 'signed-token' };
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 403 })); vi.stubGlobal('fetch', fetcher);
    await expect(authorizedFetch('/api/models/chat', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).rejects.toThrow('403');
    const init = fetcher.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer signed-token'); expect(init.redirect).toBe('error');
  });
  it('refuses token exfiltration paths and refuses logged-out requests', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(authorizedFetch('https://other.test/api/models')).rejects.toThrow('Invalid');
    await expect(authorizedFetch('//other.test/api/models')).rejects.toThrow('Invalid');
    await expect(authorizedFetch('/api/models')).rejects.toThrow('Login required'); expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not send a stale token after logout while token retrieval is pending', async () => {
    let done!: (token: string) => void; const token = new Promise<string>(resolve => { done = resolve; });
    mocks.auth.currentUser = { uid: 'uid', getIdToken: () => token }; const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const request = authorizedFetch('/api/models'); const rejected = expect(request).rejects.toThrow('Session changed');
    mocks.auth.currentUser = null; done('stale'); await rejected; expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['before-fetch', 'after-fetch'] as const)('rejects a different login object with the same UID: %s', async when => {
    let finish!: (value: string) => void; let respond!: (value: Response) => void;
    const token = new Promise<string>(r => { finish = r; }); const response = new Promise<Response>(r => { respond = r; });
    mocks.auth.currentUser = { uid: 'same', getIdToken: () => token };
    const fetcher = vi.fn(() => response); vi.stubGlobal('fetch', fetcher);
    const request = authorizedFetch('/api/radar/preview'); const rejected = expect(request).rejects.toThrow('Session changed');
    if (when === 'before-fetch') { mocks.auth.currentUser = { uid: 'same', getIdToken: async () => 'new' }; finish('old'); }
    else { finish('old'); await Promise.resolve(); mocks.auth.currentUser = { uid: 'same', getIdToken: async () => 'new' }; respond(new Response('{}')); }
    await rejected; if (when === 'before-fetch') expect(fetcher).not.toHaveBeenCalled();
  });
  it('honors an already aborted request before retrieving any token', async () => {
    const getIdToken = vi.fn(async () => 'token'); mocks.auth.currentUser = { uid: 'same', getIdToken };
    const abort = new AbortController(); abort.abort();
    await expect(authorizedFetch('/api/radar/preview', { signal: abort.signal })).rejects.toThrow('cancelled'); expect(getIdToken).not.toHaveBeenCalled();
  });
});

describe('UI route guard', () => {
  it('does not render protected UI based on forged localStorage flags', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'true' }); vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(renderToString(<MemoryRouter><AuthGuard><span>PRIVATE CONTENT</span></AuthGuard></MemoryRouter>)).not.toContain('PRIVATE CONTENT');
  });
  it('renders protected UI only with a server-verified session', () => {
    mocks.session.user = { name: 'Test', email: 'test@example.test', isAdmin: false }; vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(renderToString(<MemoryRouter><AuthGuard><span>PRIVATE CONTENT</span></AuthGuard></MemoryRouter>)).toContain('PRIVATE CONTENT');
  });
});


describe('operational socket teardown', () => {
  class Client extends WebSocketClientBase { constructor() { super('wss://example.test/ws'); } protected handleMessage() {} }
  function timers() {
    vi.useFakeTimers();
    vi.stubGlobal('window', { setTimeout, setInterval, location: { protocol: 'https:', hostname: 'example.test' } });
  }
  it('does not reconnect after an explicit logout/disconnect', async () => {
    timers(); const client = new Client(); client.connect(); const socket = FakeSocket.instances[0];
    socket.readyState = FakeSocket.OPEN; socket.onopen?.(); client.disconnect();
    await vi.advanceTimersByTimeAsync(60000);
    expect(FakeSocket.instances).toHaveLength(1); expect(client.status).toBe('disconnected'); expect(vi.getTimerCount()).toBe(0);
  });
  it('ignores late close events from a previous socket after a new connection', () => {
    timers(); const client = new Client(); client.connect(); const old = FakeSocket.instances[0]; const lateClose = old.onclose;
    client.disconnect(); client.connect(); const current = FakeSocket.instances[1]; current.readyState = FakeSocket.OPEN; current.onopen?.();
    lateClose?.(); expect(client.status).toBe('connected'); expect(current.closed).toBe(false); client.disconnect();
  });
  it('still reconnects on an unexpected network disconnect', async () => {
    timers(); const client = new Client(); client.connect(); FakeSocket.instances[0].close();
    await vi.advanceTimersByTimeAsync(2100); expect(FakeSocket.instances).toHaveLength(2); client.disconnect();
  });
});

describe('operational socket authentication', () => {
  class Client extends WebSocketClientBase { seen: string[]=[]; constructor(url='wss://example.test/ws'){super(url)} protected handleMessage(data:string){this.seen.push(data)} }
  function prepare(){vi.useFakeTimers();vi.stubGlobal('window',{setTimeout,setInterval,location:{protocol:'https:',hostname:'example.test'}});}
  it('does not send operations or expose data before server acknowledgement',async()=>{
    prepare();const client=new Client();client.setTokenProvider(async()=> 'signed-token');client.connect();const socket=FakeSocket.instances[0];socket.readyState=FakeSocket.OPEN;
    await socket.onopen?.();client.send('{"type":"operation"}');expect(socket.sent.map(x=>JSON.parse(x).type)).toEqual(['auth:check']);expect(client.status).toBe('connecting');
    socket.message({type:'private'});expect(client.seen).toEqual([]);
    socket.message({type:'auth:ready'});expect(client.status).toBe('connected');client.send('{"type":"operation"}');expect(socket.sent).toHaveLength(2);client.disconnect();
  });
  it('does not transmit a token obtained after disconnect',async()=>{
    prepare();let resolve!:(x:string)=>void;const token=new Promise<string>(r=>resolve=r);const client=new Client();client.setTokenProvider(()=>token);client.connect();const socket=FakeSocket.instances[0];socket.readyState=FakeSocket.OPEN;
    const opened=socket.onopen?.();client.disconnect();resolve('old-token');await opened;expect(socket.sent).toEqual([]);expect(vi.getTimerCount()).toBe(0);
  });
  it('obtains a new token on reconnect rather than retaining the previous credential',async()=>{
    prepare();const getToken=vi.fn(async()=> 'current');const client=new Client();client.setTokenProvider(getToken);client.connect();const a=FakeSocket.instances[0];a.readyState=FakeSocket.OPEN;await a.onopen?.();a.message({type:'auth:ready'});a.close();
    await vi.advanceTimersByTimeAsync(2100);const b=FakeSocket.instances[1];b.readyState=FakeSocket.OPEN;await b.onopen?.();expect(getToken).toHaveBeenCalledTimes(2);expect(client.status).toBe('connecting');client.disconnect();
  });
  it('rejects plaintext endpoints before retrieving credentials',()=>{
    prepare();vi.spyOn(console,'error').mockImplementation(()=>{});const getToken=vi.fn(async()=> 'token');const client=new Client('ws://remote.test/ws');client.setTokenProvider(getToken);client.connect();expect(FakeSocket.instances).toEqual([]);expect(getToken).not.toHaveBeenCalled();client.disconnect();
  });
});
