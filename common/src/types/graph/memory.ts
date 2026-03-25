/**
 * Memory types: items, queries, namespaces, and write events.
 */

import type { ShannonChannel } from './channels.js';
import type { ShannonMode } from './channels.js';

/** Memory visibility scope determines who can access a memory item. */
export type MemoryVisibilityScope =
  | 'private_user'            // Only the owning user
  | 'shared_project'          // Project collaborators
  | 'shared_channel'          // Same channel space
  | 'shared_world'            // Same Minecraft world
  | 'global_generalized'      // Anyone (distilled knowledge)
  | 'self_model';             // Shannon's self-knowledge

/** Memory category. */
export type MemoryKind =
  | 'preference'              // User preference
  | 'project'                 // Project-related fact
  | 'relationship'            // Interpersonal knowledge
  | 'history'                 // Past interaction or event
  | 'creative'                // Creative work or idea
  | 'task'                    // Ongoing or completed task
  | 'generalized_knowledge'   // Distilled general knowledge
  | 'world_state'             // Minecraft world state
  | 'self_model';             // Shannon's self-knowledge

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

  // -- ownership & source --
  /** User who "owns" this memory (for private_user scope). */
  ownerUserId?: string;
  /** All users involved in creating this memory. */
  sourceUserIds: string[];
  /** Channel where this memory originated. */
  sourceChannel: ShannonChannel;

  // -- scoping --
  visibilityScope: MemoryVisibilityScope;

  // -- tags (used for recall filtering) --
  worldTags?: string[];       // e.g. ["survival_main", "overworld"]
  projectTags?: string[];     // e.g. ["website_redesign"]
  channelTags?: string[];     // e.g. ["discord", "friend_server"]
  relationTags?: string[];    // e.g. ["rai", "close_friend"]

  // -- sensitivity & generalization --
  sensitivityLevel: 'low' | 'mid' | 'high';
  /** Whether this has been distilled into general knowledge. */
  generalized: boolean;

  // -- scoring --
  importance: number;         // 1-10, compatible with existing ShannonMemory
  relevanceScore?: number;    // Computed at recall time

  // -- embedding --
  embedding?: number[];

  // -- timestamps --
  createdAt: string;
  updatedAt?: string;

  // -- provenance --
  sourceRefs?: string[];      // IDs of source memories / conversations
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
export type MemoryNamespace =
  | `private_user/${string}`
  | `shared_project/${string}`
  | `shared_channel/${string}`
  | `shared_world/${string}`
  | 'generalized/global'
  | 'self_model/shannon';

/** An append-only memory write event produced by graph invocations. */
export interface MemoryWriteEvent {
  eventId: string;
  timestamp: string;
  sourceRequestId: string;     // Links back to the RequestEnvelope
  operation: 'create' | 'update_signal' | 'delete_signal';
  item: Partial<MemoryItem> & { id: string };
}
