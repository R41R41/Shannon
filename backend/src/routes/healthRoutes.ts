import type { Express } from 'express';

export function registerHealthRoutes(app: Express, isReady: () => boolean = () => false): void {
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });
  app.get('/api/ready', (_req, res) => {
    let ready = false;
    try { ready = isReady(); } catch { /* readiness is fail closed */ }
    res.setHeader('Cache-Control', 'no-store');
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
  });
}
