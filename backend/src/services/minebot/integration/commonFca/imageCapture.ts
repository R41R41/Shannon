import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import path from 'node:path';

interface RenderSession {
  capture(signal: AbortSignal): Promise<{ dataUrl: string; capturedAt: string }>;
  dispose(): Promise<void>;
}
/** Same connected bot and world. No bot login, HTTP listener, remote screenshot, model, or file journal. */
export function createBodyImageCapture(bot: any, options: { rendererDirectory?: string; create?: (bot: any) => Promise<RenderSession> } = {}) {
  let session: Promise<RenderSession> | undefined;
  let busy = false;
  let closed = false;
  return {
    async capture(signal: AbortSignal) {
      signal.throwIfAborted();
      if (closed || busy) throw Error('BODY_CAPTURE_UNAVAILABLE');
      busy = true;
      try {
        session ??= (options.create ?? (bot => createPrismarineSession(bot, options.rendererDirectory)))(bot);
        const renderer = await session; signal.throwIfAborted();
        const result = await renderer.capture(signal); signal.throwIfAborted();
        if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(result.dataUrl) || result.dataUrl.length > 700_000
          || !Number.isFinite(Date.parse(result.capturedAt))) throw Error('BODY_CAPTURE_INVALID');
        return result;
      } finally { busy = false; }
    },
    async dispose() { closed = true; if (session) { try { await (await session).dispose(); } catch { /* initialization failed */ } } },
  };
}

async function createPrismarineSession(bot: any, rendererDirectory?: string): Promise<RenderSession> {
  if (!bot.entity || !bot.world || !bot.version) throw Error('BODY_CAPTURE_NOT_SPAWNED');
  const require = createRequire(import.meta.url);
  const root = rendererDirectory ? path.resolve(rendererDirectory) : path.dirname(require.resolve('prismarine-viewer/package.json'));
  const rendererRequire = createRequire(path.join(root, 'package.json'));
  // Stock viewer aliases minor versions. Wrong block state IDs would produce misleading images.
  const { supportedVersions } = rendererRequire('./viewer/lib/version.js');
  if (!supportedVersions.includes(bot.version)) throw Error('BODY_CAPTURE_EXACT_VERSION_ASSETS_REQUIRED');
  const THREE = rendererRequire('three');
  (globalThis as any).THREE = THREE;
  (globalThis as any).Worker = Worker;
  const { createCanvas } = rendererRequire('node-canvas-webgl/lib');
  const { Viewer, WorldView } = rendererRequire('./viewer/index.js');
  const canvas = createCanvas(512, 288);
  const renderer = new THREE.WebGLRenderer({ canvas });
  const viewer = new Viewer(renderer);
  viewer.setVersion(bot.version);
  const world = new WorldView(bot.world, 3, bot.entity.position);
  viewer.listen(world); world.listenToBot(bot);
  await world.init(bot.entity.position);
  const update = () => { void world.updatePosition(bot.entity.position); };
  bot.on('move', update);
  let closed = false;
  return {
    async capture(signal) {
      signal.throwIfAborted();
      if (closed || !bot.entity) throw Error('BODY_CAPTURE_DISCONNECTED');
      await world.updatePosition(bot.entity.position); signal.throwIfAborted();
      const deadline = Date.now() + 2000;
      while (viewer.world.sectionsOutstanding.size || !viewer.world.material.map) {
        signal.throwIfAborted();
        if (Date.now() >= deadline) throw Error('BODY_CAPTURE_GEOMETRY_PENDING');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      // Render + encode in the same turn, as the vision benchmark capture hook does.
      // Direct pose avoids the viewer's 50ms camera tween returning the preceding viewpoint.
      viewer.camera.position.set(bot.entity.position.x, bot.entity.position.y + (bot.entity.height ?? 1.8) * 0.9, bot.entity.position.z);
      viewer.camera.rotation.set(bot.entity.pitch, bot.entity.yaw, 0, 'ZYX');
      viewer.update(); renderer.render(viewer.scene, viewer.camera);
      const capturedAt = new Date().toISOString();
      const bytes: Buffer = canvas.toBuffer('image/jpeg', { quality: 0.65, progressive: false });
      signal.throwIfAborted();
      if (bytes.length > 512 * 1024) throw Error('BODY_CAPTURE_TOO_LARGE');
      return { dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`, capturedAt };
    },
    async dispose() {
      if (closed) return; closed = true;
      bot.removeListener('move', update); world.removeListenersFromBot(bot); world.removeAllListeners();
      viewer.resetAll(); await Promise.all(viewer.world.workers.map((worker: Worker) => worker.terminate()));
      renderer.dispose(); renderer.forceContextLoss?.();
    },
  };
}
