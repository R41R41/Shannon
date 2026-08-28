import express, { type Express, type Request, type Response } from 'express';
import type { AccessService } from '../modules/access/index.js';
import { authenticateRequest, sendAccessError } from './accessHttp.js';
import { PersonalRadarError, PersonalRadarService, personalRadarOwner } from '../services/radar/personalRadar.js';

/** Opt-in route factory, intentionally NOT registered by server/bootstrap yet. No collection or post endpoint. */
export function registerRadarRoutes(app: Express, access: AccessService, radar: PersonalRadarService): void {
  app.use('/api/radar', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Vary', 'Authorization'); next(); });
  const handler = (operation: 'sources' | 'preview' | 'configure' | 'revoke') => async (req: Request, res: Response) => {
    try {
      const context = await authenticateRequest(req, access);
      if (Object.keys(req.query).length) throw new PersonalRadarError('INVALID_INPUT');
      if (operation === 'revoke' && (!req.body || Object.keys(req.body).length !== 1 || !Object.prototype.hasOwnProperty.call(req.body, 'expectedRevision')))
        throw new PersonalRadarError('INVALID_INPUT');
      const reauthorize = () => authenticateRequest(req, access);
      const result = operation === 'configure' ? await radar.configure(context, req.params.id, req.body, reauthorize)
        : operation === 'revoke' ? await radar.revoke(context, req.params.id, req.body.expectedRevision, reauthorize)
          : await radar[operation](context);
      const latest = await authenticateRequest(req, access);
      if (personalRadarOwner(latest) !== personalRadarOwner(context)) throw new PersonalRadarError('CONFLICT');
      await radar.assertCurrent(latest, result.revision);
      if ('validUntil' in result && (typeof result.validUntil !== 'number' || result.validUntil <= Date.now())) throw new PersonalRadarError('CONFLICT');
      res.json(result);
    } catch (error) {
      if (error instanceof PersonalRadarError) {
        const status = { INVALID_INPUT: 400, CONFLICT: 409, NOT_FOUND: 404, LIMIT: 409, UNAVAILABLE: 503, CANCELLED: 409 }[error.code];
        res.status(status).json({ error: error.code });
      } else sendAccessError(res, error);
    }
  };
  app.get('/api/radar/sources', handler('sources'));
  app.get('/api/radar/preview', handler('preview'));
  app.put('/api/radar/sources/:id', express.json({ limit: '8kb' }), handler('configure'));
  app.delete('/api/radar/sources/:id', express.json({ limit: '1kb' }), handler('revoke'));
}
