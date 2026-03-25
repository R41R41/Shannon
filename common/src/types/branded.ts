/**
 * Branded types for common IDs.
 *
 * Branded types use an intersection with a phantom readonly property so that
 * plain strings cannot be assigned to an ID slot without going through the
 * constructor function.  This prevents accidental mixing of unrelated IDs at
 * compile time while keeping zero runtime overhead (the brand property is
 * erased by the compiler).
 */

// ---------------------------------------------------------------------------
// Brand helper
// ---------------------------------------------------------------------------

type Brand<T, B extends string> = T & { readonly __brand: B };

// ---------------------------------------------------------------------------
// ID types
// ---------------------------------------------------------------------------

export type RequestId = Brand<string, 'RequestId'>;
export type ConversationId = Brand<string, 'ConversationId'>;
export type TaskId = Brand<string, 'TaskId'>;
export type ChannelId = Brand<string, 'ChannelId'>;
export type GuildId = Brand<string, 'GuildId'>;
export type UserId = Brand<string, 'UserId'>;
export type MemoryId = Brand<string, 'MemoryId'>;

// ---------------------------------------------------------------------------
// Constructor functions
// ---------------------------------------------------------------------------

export function createRequestId(id: string): RequestId {
  return id as RequestId;
}

export function createConversationId(id: string): ConversationId {
  return id as ConversationId;
}

export function createTaskId(id: string): TaskId {
  return id as TaskId;
}

export function createChannelId(id: string): ChannelId {
  return id as ChannelId;
}

export function createGuildId(id: string): GuildId {
  return id as GuildId;
}

export function createUserId(id: string): UserId {
  return id as UserId;
}

export function createMemoryId(id: string): MemoryId {
  return id as MemoryId;
}
