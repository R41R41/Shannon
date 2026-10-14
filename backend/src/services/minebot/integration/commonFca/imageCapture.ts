import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { RenderReply, RenderRequest } from './renderProcess.js';

interface RenderSession {
  capture(signal: AbortSignal): Promise<{ dataUrl: string; capturedAt: string }>;
  dispose(): Promise<void>;
}
/** The renderer process's IPC end, as `child_process.spawn` with an `ipc` stdio returns it. */
export type RenderChild = Pick<ChildProcess, 'send' | 'disconnect' | 'kill' | 'on' | 'once' | 'connected'>;
const WIDTH = 512, HEIGHT = 288, INIT_MS = 30_000, GEOMETRY_WAIT_MS = 2000, REPLY_MARGIN_MS = 1500;
/** Same connected bot and world. No bot login, HTTP listener, remote screenshot, model, or file journal. */
export function createBodyImageCapture(bot: any, options: { rendererDirectory?: string; create?: (bot: any) => Promise<RenderSession> } = {}) {
  let session: Promise<RenderSession> | undefined;
  let busy = false;
  let closed = false;
  // A renderer that cannot be resolved, or whose session failed to start, will not give a picture on this connection.
  let configured = options.create ? true : rendererResolvable(options.rendererDirectory);
  const open = () => {
    if (session) return session;
    const opening = (options.create ?? (bot => createRenderProcessSession(bot, options.rendererDirectory)))(bot);
    session = opening;
    opening.catch(error => {
      if (session !== opening) return;
      if (/BODY_CAPTURE_NOT_SPAWNED/.test(String(error?.message))) session = undefined; else configured = false;
    });
    return opening;
  };
  return {
    get configured() { return configured && !closed; },
    /** Starts the renderer ahead of the first capture: it takes seconds, and a capture that misses holds vision back. */
    prepare() { if (!closed && configured) void open().catch(() => undefined); },
    async capture(signal: AbortSignal) {
      signal.throwIfAborted();
      if (closed || busy || !configured) throw Error('BODY_CAPTURE_UNAVAILABLE');
      busy = true;
      try {
        const renderer = await open();
        signal.throwIfAborted();
        const result = await renderer.capture(signal); signal.throwIfAborted();
        if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(result.dataUrl) || result.dataUrl.length > 700_000
          || !Number.isFinite(Date.parse(result.capturedAt))) throw Error('BODY_CAPTURE_INVALID');
        return result;
      } finally { busy = false; }
    },
    async dispose() { closed = true; if (session) { try { await (await session).dispose(); } catch { /* initialization failed */ } } },
  };
}

/**
 * Whether the renderer resolves from here with its native WebGL and canvas bindings built, without loading them.
 * A release whose dependencies were installed without those builds has the JavaScript but can never draw, and
 * headless GL also needs an X display, which the renderer process gets from xvfb-run.
 */
export function rendererResolvable(rendererDirectory?: string): boolean {
  try {
    if (!['xvfb-run', 'nice'].every(onPath)) return false;
    const require = createRequire(import.meta.url);
    const root = rendererDirectory ? path.resolve(rendererDirectory) : path.dirname(require.resolve('prismarine-viewer/package.json'));
    const rendererRequire = createRequire(path.join(root, 'package.json'));
    for (const name of ['./viewer/lib/version.js', './viewer/index.js', 'three', 'node-canvas-webgl/lib']) rendererRequire.resolve(name);
    // node-canvas-webgl draws with its own gl and canvas; the viewer's entity labels load canvas from the renderer root.
    const canvasRequire = createRequire(rendererRequire.resolve('node-canvas-webgl/package.json'));
    const built = (from: NodeRequire, name: string, binding: string) =>
      existsSync(path.join(path.dirname(from.resolve(`${name}/package.json`)), 'build', 'Release', binding));
    return built(canvasRequire, 'gl', 'webgl.node') && built(canvasRequire, 'canvas', 'canvas.node') && built(rendererRequire, 'canvas', 'canvas.node');
  } catch { return false; }
}

function onPath(command: string): boolean {
  return (process.env.PATH ?? '').split(path.delimiter).some(directory => directory && existsSync(path.join(directory, command)));
}

function launchRenderProcess(root: string): RenderChild {
  const entry = fileURLToPath(new URL('./renderProcess.js', import.meta.url));
  // Lower priority than the body: on a two-core VM a frame must never delay a physics tick. Its own process group, so
  // a kill reaches xvfb-run, the renderer and Xvfb together (killing xvfb-run alone leaves Xvfb running).
  const child = spawn('nice', ['-n', '10', 'xvfb-run', '-a', '-s', '-screen 0 640x480x24', process.execPath, entry, root],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: true });
  const kill = child.kill.bind(child);
  child.kill = (signal?: NodeJS.Signals | number) => {
    try { if (child.pid) { process.kill(-child.pid, signal ?? 'SIGTERM'); return true; } } catch { /* group gone */ }
    return kill(signal);
  };
  return child;
}

/**
 * The body keeps the world it already holds and streams it to a renderer process; drawing and encoding happen there
 * (ADR-0011 §6.1/§6.3). Same connected bot and world: no second login.
 */
export async function createRenderProcessSession(bot: any, rendererDirectory?: string,
  launch: (root: string) => RenderChild = launchRenderProcess): Promise<RenderSession> {
  if (!bot.entity || !bot.world || !bot.version) throw Error('BODY_CAPTURE_NOT_SPAWNED');
  const require = createRequire(import.meta.url);
  const root = rendererDirectory ? path.resolve(rendererDirectory) : path.dirname(require.resolve('prismarine-viewer/package.json'));
  const rendererRequire = createRequire(path.join(root, 'package.json'));
  // Stock viewer aliases minor versions. Wrong block state IDs would produce misleading images.
  const { supportedVersions } = rendererRequire('./viewer/lib/version.js');
  if (!supportedVersions.includes(bot.version)) throw Error('BODY_CAPTURE_EXACT_VERSION_ASSETS_REQUIRED');
  const { WorldView } = rendererRequire('./viewer/lib/worldView.js');
  const child = launch(root);
  const pending = new Map<number, { resolve(reply: RenderReply): void; reject(error: Error): void }>();
  let nextId = 0, ended: Error | null = null;
  const end = (error: Error) => {
    ended ??= error;
    for (const waiter of pending.values()) waiter.reject(ended);
    pending.clear();
  };
  child.on('message', (reply: RenderReply) => {
    const waiter = pending.get(reply.id); if (!waiter) return;
    pending.delete(reply.id);
    if (reply.type === 'failed') waiter.reject(Error(reply.error)); else waiter.resolve(reply);
  });
  child.on('exit', () => end(Error('BODY_CAPTURE_RENDERER_EXITED')));
  child.on('error', () => end(Error('BODY_CAPTURE_RENDERER_UNAVAILABLE')));
  const post = (request: RenderRequest) => { if (!ended && child.connected) child.send(request); };
  const request = (make: (id: number) => RenderRequest, milliseconds: number, signal?: AbortSignal) => new Promise<RenderReply>((resolve, reject) => {
    if (ended) return reject(ended);
    const id = ++nextId;
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); pending.delete(id); };
    const timer = setTimeout(() => { finish(); reject(Error('BODY_CAPTURE_RENDERER_TIMEOUT')); }, milliseconds);
    const aborted = () => { finish(); reject(signal!.reason ?? Error('aborted')); };
    signal?.addEventListener('abort', aborted, { once: true });
    pending.set(id, { resolve: reply => { finish(); resolve(reply); }, reject: error => { finish(); reject(error); } });
    post(make(id));
  });
  let exited = false;
  child.once('exit', () => { exited = true; });
  // A renderer that disconnects exits by itself and xvfb-run then stops Xvfb; one that hangs is killed as a group.
  const close = () => {
    try { if (child.connected) child.disconnect(); } catch { /* already gone */ }
    setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 5000).unref();
  };
  try {
    await request(id => ({ type: 'init', id, version: bot.version, width: WIDTH, height: HEIGHT }), INIT_MS);
  } catch (error) { close(); throw error; }
  // WorldView reads the bot's world here and emits plain chunk/entity data; only those events cross to the renderer.
  const forward = new EventEmitter();
  const emit = forward.emit.bind(forward);
  forward.emit = (name: string | symbol, ...args: unknown[]) => {
    if (typeof name === 'string' && ['entity', 'loadChunk', 'unloadChunk', 'blockUpdate'].includes(name)) post({ type: 'event', name, data: args[0] });
    return emit(name, ...args);
  };
  const world = new WorldView(bot.world, 3, bot.entity.position, forward);
  world.listenToBot(bot);
  await world.init(bot.entity.position);
  const update = () => { void world.updatePosition(bot.entity.position); };
  bot.on('move', update);
  let closed = false;
  return {
    async capture(signal) {
      signal.throwIfAborted();
      if (closed || ended || !bot.entity) throw Error('BODY_CAPTURE_DISCONNECTED');
      await world.updatePosition(bot.entity.position); signal.throwIfAborted();
      const position = bot.entity.position;
      const pose = { x: position.x, y: position.y + (bot.entity.height ?? 1.8) * 0.9, z: position.z, yaw: bot.entity.yaw, pitch: bot.entity.pitch };
      const reply = await request(id => ({ type: 'capture', id, pose, geometryWaitMs: GEOMETRY_WAIT_MS }), GEOMETRY_WAIT_MS + REPLY_MARGIN_MS, signal);
      if (reply.type !== 'captured') throw Error('BODY_CAPTURE_INVALID');
      return { dataUrl: reply.dataUrl, capturedAt: reply.capturedAt };
    },
    async dispose() {
      if (closed) return; closed = true;
      bot.removeListener('move', update); world.removeListenersFromBot(bot); world.removeAllListeners();
      end(Error('BODY_CAPTURE_DISCONNECTED')); close();
    },
  };
}
