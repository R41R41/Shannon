import type { Express } from 'express';
import type { AccessService } from '../modules/access/index.js';
import type { ModelSettingsService } from '../modules/modelSettings/index.js';
import { authenticateRequest, sendAccessError } from './accessHttp.js';

export function registerModelRoutes(app: Express, access: AccessService, settings: ModelSettingsService): void {
  app.use('/api/models', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.get('/api/models', async (req, res) => {
    try { res.json(settings.read(await authenticateRequest(req, access))); }
    catch (error) { sendAccessError(res, error); }
  });
  app.put('/api/models/:key', async (req, res) => {
    try {
      const context = await authenticateRequest(req, access);
      settings.update(context, req.params.key, req.body?.model);
      res.json({ ok: true, key: req.params.key, model: req.body.model });
    } catch (error) { sendAccessError(res, error); }
  });
  app.post('/api/models/reset', async (req, res) => {
    try { res.json({ ok: true, models: settings.reset(await authenticateRequest(req, access)) }); }
    catch (error) { sendAccessError(res, error); }
  });
}
