import type { Express } from 'express';

export function registerHealthRoutes(app: Express): void {
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });
}
