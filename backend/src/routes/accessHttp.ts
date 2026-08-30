import type { Request, Response } from 'express';
import { AccessError, type AccessService } from '../modules/access/index.js';
import { ModelSettingsInputError } from '../modules/modelSettings/index.js';

export function authenticateRequest(req: Request, access: AccessService) {
  const match = /^Bearer ([^\s]+)$/i.exec(req.get('authorization') ?? '');
  return access.authenticate(match?.[1]);
}
export function sendAccessError(res: Response, error: unknown): void {
  res.setHeader('Cache-Control', 'no-store');
  if (error instanceof AccessError) {
    const status = error.code === 'UNAUTHENTICATED' ? 401 : error.code === 'FORBIDDEN' ? 403 : 503;
    res.status(status).json({ error: error.code });
  } else if (error instanceof ModelSettingsInputError) {
    res.status(400).json({ error: error.message });
  } else {
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
}
