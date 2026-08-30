import type { RequestHandler } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { requireCapability, type AccessService } from '../modules/access/index.js';
import { authenticateRequest, sendAccessError } from './accessHttp.js';

/** Default-deny HTTP perimeter. Only liveness and the independently authenticated webhook bypass it. */
export function protectHttpSurface(access: AccessService): RequestHandler {
  return (req, res, next) => {
    const path = req.path.toLowerCase().replace(/\/+$/, '') || '/';
    if ((path === '/api/health' || path === '/api/ready') && (req.method === 'GET' || req.method === 'HEAD')) return next();
    if (path === '/api/webhook/twitter' && ['GET', 'HEAD', 'POST'].includes(req.method)) return next();
    res.setHeader('Cache-Control', 'no-store');
    // The old public graph shares private memory and broadcasts. No flag can reopen it.
    // Re-enable only through a separately tested, scoped public conversation module.
    if (path === '/api/public' || path.startsWith('/api/public/')) {
      res.status(503).json({ error: 'PUBLIC_CHAT_UNAVAILABLE' }); return;
    }
    if (!path.startsWith('/api/')) { res.status(404).json({ error: 'NOT_FOUND' }); return; }
    void authenticateRequest(req, access).then(context => {
      requireCapability(context, 'console:access');
      res.locals.requestContext = context;
      next();
    }).catch(error => sendAccessError(res, error));
  };
}

/** Dedicated machine credential; browser origins and shared external-service API keys are not accepted. */
export function requireMachineToken(getToken: () => string): RequestHandler {
  return (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const expected = getToken();
    if (expected.length < 32 || /\s/.test(expected)) { res.status(503).json({ error: 'MACHINE_AUTH_UNCONFIGURED' }); return; }
    const received = /^Bearer ([^\s]+)$/.exec(req.get('authorization') ?? '')?.[1] ?? '';
    if (req.get('origin') || received.length > 512 || Buffer.byteLength(received) !== Buffer.byteLength(expected) ||
        !timingSafeEqual(Buffer.from(received), Buffer.from(expected))) {
      res.status(401).json({ error: 'UNAUTHENTICATED' }); return;
    }
    next();
  };
}
