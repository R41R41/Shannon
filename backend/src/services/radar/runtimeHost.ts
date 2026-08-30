import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import type { Express } from 'express';

/** Own only this listener/resources. Stopping Radar never stops Shannon's other processes. */
export async function listenRadarHost(application: { app: Express; stopAccepting(): void }, port: number,
  closeResources: () => Promise<void>, permitUntil: number) {
  const server: Server = createServer(application.app);
  const sockets = new Set<Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.requestTimeout = 45000; server.headersTimeout = 10000; server.keepAliveTimeout = 1000;
  let stopped: Promise<void> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const stop = (): Promise<void> => stopped ??= (async () => {
    application.stopAccepting(); clearTimeout(expiry);
    // Closing sockets propagates cancellation to the route's request ownership.
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await closeResources();
  })();
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      server.once('error', failed);
      server.listen(port, '127.0.0.1', () => { server.removeListener('error', failed); resolve(); });
    });
    server.on('error', () => { void stop().catch(() => undefined); });
    expiry = setTimeout(() => { void stop().catch(() => undefined); }, Math.max(0, permitUntil - Date.now()));
    return { server, stop };
  } catch {
    await stop(); throw new Error('RADAR_LISTEN_FAILED');
  }
}
