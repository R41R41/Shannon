import type { ServiceCommand, ServiceInput } from '@shannon/common';

export type ServiceCommandHandler = (
  command: ServiceCommand,
  input?: Pick<ServiceInput, 'serverName'>,
) => void | Promise<void>;

const handlers = new Map<string, ServiceCommandHandler>();

export function registerServiceCommandHandler(service: string, handler: ServiceCommandHandler): void {
  if (handlers.has(service)) throw new Error(`Service command handler already registered: ${service}`);
  handlers.set(service, handler);
}

export async function dispatchServiceCommand(
  service: string,
  command: ServiceCommand,
  serverName?: string | null,
): Promise<void> {
  const handler = handlers.get(service);
  if (!handler) return;
  await handler(command, serverName ? { serverName } : undefined);
}

export function clearServiceCommandHandlers(): void {
  handlers.clear();
}
