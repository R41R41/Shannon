/**
 * Memory types: items, queries, namespaces, and write events.
 */
import type { ShannonChannel } from './channels.js';
import type { ShannonMode } from './channels.js';
/** Memory visibility scope determines who can access a memory item. */
export type MemoryVisibilityScope = 'private_user' | 'shared_project' | 'shared_channel' | 'shared_world' | 'global_generalized' | 'self_model';
/** Memory category. */
export type MemoryKind = 'preference' | 'project' | 'relationship' | 'history' | 'creative' | 'task' | 'generalized_knowledge' | 'world_state' | 'self_model';
/**
 * Unified memory item stored in the shared memory store.
 *
 * Replaces the split between ShannonMemory (experience/knowledge)
 * and PersonMemory with a single scoped structure.
 */
export interface MemoryItem {
    id: string;
    kind: MemoryKind;
    /** Human-readable summary of this memory. */
    summary: string;
    /** Optional detailed content. */
    content?: string;
    /** Shannon's feeling/emotion when this was stored. */
    feeling?: string;
    /** User who "owns" this memory (for private_user scope). */
    ownerUserId?: string;
    /** All users involved in creating this memory. */
    sourceUserIds: string[];
    /** Channel where this memory originated. */
    sourceChannel: ShannonChannel;
    visibilityScope: MemoryVisibilityScope;
    worldTags?: string[];
    projectTags?: string[];
    channelTags?: string[];
    relationTags?: string[];
    sensitivityLevel: 'low' | 'mid' | 'high';
    /** Whether this has been distilled into general knowledge. */
    generalized: boolean;
    importance: number;
    relevanceScore?: number;
    embedding?: number[];
    createdAt: string;
    updatedAt?: string;
    sourceRefs?: string[];
}
/** Query structure for memory recall. */
export interface MemoryQuery {
    currentUserId: string;
    channel: ShannonChannel;
    mode?: ShannonMode;
    text: string;
    tags: string[];
    minecraftWorldId?: string;
    projectTags?: string[];
    limit?: number;
}
/** Memory namespace for organizing storage. */
export type MemoryNamespace = `private_user/${string}` | `shared_project/${string}` | `shared_channel/${string}` | `shared_world/${string}` | 'generalized/global' | 'self_model/shannon';
/** An append-only memory write event produced by graph invocations. */
export interface MemoryWriteEvent {
    eventId: string;
    timestamp: string;
    sourceRequestId: string;
    operation: 'create' | 'update_signal' | 'delete_signal';
    item: Partial<MemoryItem> & {
        id: string;
    };
}
