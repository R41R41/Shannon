/** Operator-assigned world generations, never inferred from a host, port or display name. */
export interface MinecraftWorldIdentity { readonly serverId: string; readonly worldId: string; }
export interface MinecraftMemoryContext extends MinecraftWorldIdentity { readonly dimension: string; }
export interface MinecraftConnection { readonly name: string; readonly host: string; readonly port: number; }
interface Binding extends MinecraftConnection, MinecraftWorldIdentity {}
export interface MinecraftWorldRegistry { resolve(connection: MinecraftConnection): MinecraftWorldIdentity | null; }
const identifier = (x: unknown): x is string => typeof x === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(x) && !['default', 'unknown'].includes(x);
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const fail = (): never => { throw new Error('INVALID_MINECRAFT_MEMORY_IDENTITIES'); };

/** Empty configuration deliberately disables memory. A supplied but invalid mapping fails before connection. */
export function parseMinecraftWorldRegistry(raw: string | undefined, environment: 'dev' | 'prod'): MinecraftWorldRegistry {
  let bindings: Binding[] = [];
  if (raw !== undefined && raw !== '') {
    let data: unknown;
    try { data = JSON.parse(raw); } catch { return fail(); }
    if (!object(data) || data.version !== 1 || data.environment !== environment || !Array.isArray(data.bindings)) return fail();
    const names = new Set<string>(); const identities = new Set<string>(); const endpoints = new Set<string>();
    for (const value of data.bindings) {
      if (!object(value) || !identifier(value.name) || typeof value.host !== 'string' || !value.host.trim()
          || value.host !== value.host.trim() || /[\s/\x00-\x1f]/.test(value.host)
          || !Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535
          || !identifier(value.serverId) || !identifier(`${environment}:${value.serverId}`) || !identifier(value.worldId)) return fail();
      const endpoint = JSON.stringify([value.host, value.port]); const identity = JSON.stringify([value.serverId, value.worldId]);
      // Multiple aliases/endpoints cannot silently collapse into the same audience in this first version.
      if (names.has(value.name) || identities.has(identity) || endpoints.has(endpoint)) return fail();
      names.add(value.name); identities.add(identity); endpoints.add(endpoint);
      bindings.push(Object.freeze({ name: value.name, host: value.host, port: Number(value.port),
        serverId: `${environment}:${value.serverId}`, worldId: value.worldId }));
    }
  }
  return Object.freeze({ resolve(connection: MinecraftConnection) {
    const binding = bindings.find(row => row.name === connection.name && row.host === connection.host && row.port === connection.port);
    return binding ? Object.freeze({ serverId: binding.serverId, worldId: binding.worldId }) : null;
  } });
}

export function normalizeMinecraftDimension(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = ['overworld', 'the_nether', 'the_end'].includes(value) ? `minecraft:${value}`
    : value === 'nether' ? 'minecraft:the_nether' : value === 'end' ? 'minecraft:the_end' : value;
  return /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(normalized) ? normalized : null;
}
export function minecraftContextKey(context?: Partial<MinecraftMemoryContext> | null): string | null {
  if (!context || !identifier(context.serverId) || !identifier(context.worldId)) return null;
  const dimension = normalizeMinecraftDimension(context.dimension);
  return dimension ? JSON.stringify([context.serverId, context.worldId, dimension]) : null;
}
export function minecraftConversationKeys(context: Partial<MinecraftMemoryContext> | null | undefined, userId: string): { conversationId: string; threadId: string } | null {
  const key = minecraftContextKey(context);
  return key ? { threadId: `minecraft:${key}`, conversationId: `minecraft:${JSON.stringify([key, userId])}` } : null;
}
