/**
 * Branded types for common IDs.
 *
 * Branded types use an intersection with a phantom readonly property so that
 * plain strings cannot be assigned to an ID slot without going through the
 * constructor function.  This prevents accidental mixing of unrelated IDs at
 * compile time while keeping zero runtime overhead (the brand property is
 * erased by the compiler).
 */
type Brand<T, B extends string> = T & {
    readonly __brand: B;
};
export type RequestId = Brand<string, 'RequestId'>;
export type ConversationId = Brand<string, 'ConversationId'>;
export type TaskId = Brand<string, 'TaskId'>;
export type ChannelId = Brand<string, 'ChannelId'>;
export type GuildId = Brand<string, 'GuildId'>;
export type UserId = Brand<string, 'UserId'>;
export type MemoryId = Brand<string, 'MemoryId'>;
export declare function createRequestId(id: string): RequestId;
export declare function createConversationId(id: string): ConversationId;
export declare function createTaskId(id: string): TaskId;
export declare function createChannelId(id: string): ChannelId;
export declare function createGuildId(id: string): GuildId;
export declare function createUserId(id: string): UserId;
export declare function createMemoryId(id: string): MemoryId;
export {};
