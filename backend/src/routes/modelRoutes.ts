import type { Express } from 'express';
import { modelManager } from '../config/modelManager.js';

export function registerModelRoutes(app: Express): void {
  app.get('/api/models', (_req, res) => {
    res.json({
      current: modelManager.getAll(),
      overrides: modelManager.getOverrides(),
    });
  });

  app.put('/api/models/:key', (req, res) => {
    const { key } = req.params;
    const { model } = req.body as { model?: string };
    if (!model || typeof model !== 'string') {
      res.status(400).json({ error: 'model is required' });
      return;
    }
    try {
      if (key.startsWith('minebot.')) {
        modelManager.setMinebotModel(key.replace('minebot.', '') as Parameters<typeof modelManager.setMinebotModel>[0], model);
      } else {
        modelManager.set(key as Parameters<typeof modelManager.set>[0], model);
      }
      res.json({ ok: true, key, model });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.post('/api/models/reset', (_req, res) => {
    modelManager.resetAll();
    res.json({ ok: true, models: modelManager.getAll() });
  });
}
