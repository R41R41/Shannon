import type { Express } from 'express';
import type { AccessService } from '../modules/access/index.js';
import type {
  IdentityBindingWriteService,
  IdentityManifestReviewService,
  IdentityStatusService,
} from '../modules/identity/index.js';
import { IdentityInputError } from '../modules/identity/index.js';
import { authenticateRequest, sendAccessError } from './accessHttp.js';

export function registerIdentityRoutes(
  app: Express,
  access: AccessService,
  status: IdentityStatusService,
  bindingWrite: IdentityBindingWriteService,
  manifestReview: IdentityManifestReviewService,
): void {
  app.use('/api/identity', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  app.get('/api/identity/status', async (req, res) => {
    try {
      const context = await authenticateRequest(req, access);
      res.json(await status.read(context));
    } catch (error) {
      sendAccessError(res, error);
    }
  });

  app.put('/api/identity/bindings/:channel', async (req, res) => {
    try {
      const context = await authenticateRequest(req, access);
      res.json(await bindingWrite.link(context, req.params.channel, req.body));
    } catch (error) {
      if (error instanceof IdentityInputError) {
        res.status(400).json({ error: error.message });
        return;
      }
      sendAccessError(res, error);
    }
  });

  app.post('/api/identity/bindings/:channel/unlink', async (req, res) => {
    try {
      const context = await authenticateRequest(req, access);
      res.json(await bindingWrite.unlink(context, req.params.channel, req.body));
    } catch (error) {
      if (error instanceof IdentityInputError) {
        res.status(400).json({ error: error.message });
        return;
      }
      sendAccessError(res, error);
    }
  });

  app.put('/api/identity/audience', async (req, res) => {
    try {
      const context = await authenticateRequest(req, access);
      res.json(await bindingWrite.updateAudience(context, req.body));
    } catch (error) {
      if (error instanceof IdentityInputError) {
        res.status(400).json({ error: error.message });
        return;
      }
      sendAccessError(res, error);
    }
  });

  app.post('/api/identity/validate-manifest', async (req, res) => {
    try {
      const context = await authenticateRequest(req, access);
      res.json(await manifestReview.review(context, req.body));
    } catch (error) {
      if (error instanceof IdentityInputError) {
        res.status(400).json({ error: error.message });
        return;
      }
      sendAccessError(res, error);
    }
  });
}
