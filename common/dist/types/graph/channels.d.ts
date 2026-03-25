/**
 * Shannon channel and mode type definitions.
 */
/** All interaction surfaces Shannon can operate on. */
export type ShannonChannel = 'discord' | 'x' | 'minecraft' | 'web' | 'youtube' | 'scheduler' | 'notion' | 'internal';
/** Execution mode that drives graph routing decisions. */
export type ShannonMode = 'conversational' | 'task_execution' | 'planning' | 'minecraft_action' | 'minecraft_emergency' | 'broadcast' | 'self_reflection' | 'voice_conversation';
