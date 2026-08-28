import express, { type Express, type Request, type Response } from 'express';
import type { RadarSessionRunner } from '../services/radar/sessionRunner.js';
import type { AccessService } from '../modules/access/index.js';
import { authenticateRequest, sendAccessError } from './accessHttp.js';
import { PersonalRadarError, PersonalRadarService, personalRadarOwner } from '../services/radar/personalRadar.js';

/** Opt-in route factory, intentionally NOT registered by server/bootstrap yet. Collection is absent unless an explicit runner is injected; no publication endpoint. */
export function registerRadarRoutes(app: Express, access: AccessService, radar: PersonalRadarService, runner?: Pick<RadarSessionRunner, 'run'>): void {
  app.use('/api/radar', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Vary', 'Authorization'); next(); });
  const handler = (operation: 'sources' | 'preview' | 'audit' | 'collect' | 'configure' | 'revoke') => async (req: Request, res: Response) => {
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', cancel); res.once('close', cancel);
    try {
      const context = await authenticateRequest(req, access);
      if (Object.keys(req.query).length) throw new PersonalRadarError('INVALID_INPUT');
      if (operation === 'revoke' && (!req.body || Object.keys(req.body).length !== 1 || !Object.prototype.hasOwnProperty.call(req.body, 'expectedRevision')))
        throw new PersonalRadarError('INVALID_INPUT');
      const reauthorize = () => authenticateRequest(req, access);
      if (controller.signal.aborted) throw new PersonalRadarError('CANCELLED');
      const result = operation === 'collect' ? await runner!.run(/^Bearer ([^\s]+)$/i.exec(req.get('authorization') ?? '')?.[1], req.body, controller.signal)
        : operation === 'configure' ? await radar.configure(context, req.params.id, req.body, reauthorize)
        : operation === 'revoke' ? await radar.revoke(context, req.params.id, req.body.expectedRevision, reauthorize)
          : operation === 'audit' ? await radar.audit(context, reauthorize) : await radar[operation](context);
      if (controller.signal.aborted) throw new PersonalRadarError('CANCELLED');
      const latest = await authenticateRequest(req, access);
      if (personalRadarOwner(latest) !== personalRadarOwner(context)) throw new PersonalRadarError('CONFLICT');
      await radar.assertCurrent(latest, result.revision);
      if ('validUntil' in result && (typeof result.validUntil !== 'number' || result.validUntil <= Date.now())) throw new PersonalRadarError('CONFLICT');
      if (controller.signal.aborted) throw new PersonalRadarError('CANCELLED');
      res.json('validUntil' in result ? { ...result, servedAt: Date.now() }
        : operation === 'sources' ? { ...result, collectionAvailable: !!runner } : result);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (error instanceof PersonalRadarError) {
        const status = { INVALID_INPUT: 400, CONFLICT: 409, NOT_FOUND: 404, LIMIT: 409, UNAVAILABLE: 503, CANCELLED: 409 }[error.code];
        res.status(status).json({ error: error.code });
      } else sendAccessError(res, error);
    } finally { req.removeListener('aborted', cancel); res.removeListener('close', cancel); }
  };
  if (runner) app.post('/api/radar/collect', express.json({ limit: '1kb' }), handler('collect'));
  app.get('/api/radar/sources', handler('sources'));
  app.get('/api/radar/audit', handler('audit'));
  app.get('/api/radar/preview', handler('preview'));
  app.put('/api/radar/sources/:id', express.json({ limit: '8kb' }), handler('configure'));
  app.delete('/api/radar/sources/:id', express.json({ limit: '1kb' }), handler('revoke'));
}
