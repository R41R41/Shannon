/**
 * First-person renderer in its own process (ADR-0011 §6.1/§6.3): drawing and JPEG encoding block an event loop for
 * up to 1.55 s, so they never run beside the body's physics. The body streams the world it already has (chunks,
 * entities, block changes) over IPC; this process owns WebGL and answers one capture at a time.
 * Started by imageCapture.ts under xvfb-run (headless GL needs an X display); exits when the body disconnects.
 */
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

export type RenderRequest =
  | { type: 'init'; id: number; version: string; width: number; height: number }
  | { type: 'event'; name: string; data: unknown }
  | { type: 'capture'; id: number; pose: { x: number; y: number; z: number; yaw: number; pitch: number }; geometryWaitMs: number };
export type RenderReply =
  | { type: 'ready'; id: number }
  | { type: 'captured'; id: number; dataUrl: string; capturedAt: string; waitGeometryMs: number; renderMs: number; jpegMs: number }
  | { type: 'failed'; id: number; error: string };

export const RENDER_EVENTS = new Set(['entity', 'loadChunk', 'unloadChunk', 'blockUpdate']);
const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const message = (error: unknown) => String((error as Error)?.message ?? error).slice(0, 300);

function start(root: string) {
  const rendererRequire = createRequire(path.join(root, 'package.json'));
  const events = new EventEmitter();
  let session: { viewer: any; renderer: any; canvas: any } | null = null;
  const reply = (value: RenderReply) => { if (process.connected) process.send!(value); };
  const init = (request: Extract<RenderRequest, { type: 'init' }>) => {
    if (session) throw Error('RENDER_ALREADY_INITIALIZED');
    const THREE = rendererRequire('three');
    (globalThis as any).THREE = THREE;
    (globalThis as any).Worker = Worker;
    const { createCanvas } = rendererRequire('node-canvas-webgl/lib');
    const { Viewer } = rendererRequire('./viewer/index.js');
    const canvas = createCanvas(request.width, request.height);
    const renderer = new THREE.WebGLRenderer({ canvas });
    const viewer = new Viewer(renderer);
    viewer.setVersion(request.version);
    viewer.listen(events);
    session = { viewer, renderer, canvas };
  };
  const capture = async (request: Extract<RenderRequest, { type: 'capture' }>) => {
    if (!session) throw Error('RENDER_NOT_INITIALIZED');
    const { viewer, renderer, canvas } = session, started = performance.now(), deadline = Date.now() + request.geometryWaitMs;
    while (viewer.world.sectionsOutstanding.size || !viewer.world.material.map) {
      if (Date.now() >= deadline) throw Error('BODY_CAPTURE_GEOMETRY_PENDING');
      await delay(10);
    }
    const ready = performance.now();
    // Direct pose avoids the viewer's 50ms camera tween returning the preceding viewpoint.
    viewer.camera.position.set(request.pose.x, request.pose.y, request.pose.z);
    viewer.camera.rotation.set(request.pose.pitch, request.pose.yaw, 0, 'ZYX');
    viewer.update(); renderer.render(viewer.scene, viewer.camera);
    const rendered = performance.now(), capturedAt = new Date().toISOString();
    const bytes: Buffer = canvas.toBuffer('image/jpeg', { quality: 0.65, progressive: false });
    if (bytes.length > 512 * 1024) throw Error('BODY_CAPTURE_TOO_LARGE');
    reply({ type: 'captured', id: request.id, dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`, capturedAt,
      waitGeometryMs: ready - started, renderMs: rendered - ready, jpegMs: performance.now() - rendered });
  };
  const close = async () => {
    if (session) {
      try { session.viewer.resetAll(); await Promise.all(session.viewer.world.workers.map((worker: Worker) => worker.terminate())); } catch { /* exiting */ }
    }
    process.exit(0);
  };
  process.on('disconnect', () => { void close(); });
  process.on('message', (request: RenderRequest) => {
    if (request.type === 'event') { if (session && RENDER_EVENTS.has(request.name)) events.emit(request.name, request.data); return; }
    if (request.type === 'init') {
      try { init(request); reply({ type: 'ready', id: request.id }); } catch (error) { reply({ type: 'failed', id: request.id, error: message(error) }); }
      return;
    }
    if (request.type === 'capture') capture(request).catch(error => reply({ type: 'failed', id: request.id, error: message(error) }));
  });
}

if (process.send && process.argv[2]) start(path.resolve(process.argv[2]));
