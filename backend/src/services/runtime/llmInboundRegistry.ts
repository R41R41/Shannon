import type { EventRouter } from '../llm/routing/EventRouter.js';

let router: EventRouter | null = null;

export function registerLlmInbound(next: EventRouter): void {
  router = next;
}

export function getLlmInbound(): EventRouter {
  if (!router) throw new Error('LlmInbound is not registered');
  return router;
}

export function clearLlmInbound(): void {
  router = null;
}
