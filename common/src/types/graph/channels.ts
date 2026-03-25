/**
 * Shannon channel and mode type definitions.
 */

/** All interaction surfaces Shannon can operate on. */
export type ShannonChannel =
  | 'discord'
  | 'x'
  | 'minecraft'
  | 'web'
  | 'youtube'
  | 'scheduler'
  | 'notion'
  | 'internal';

/** Execution mode that drives graph routing decisions. */
export type ShannonMode =
  | 'conversational'        // Normal conversation (Discord, Web, etc.)
  | 'task_execution'        // Tool-using task
  | 'planning'              // Complex multi-step planning
  | 'minecraft_action'      // Minecraft physical actions (move, mine, craft)
  | 'minecraft_emergency'   // Minecraft emergency (under attack, death, etc.)
  | 'broadcast'             // Publishing content (X post, auto-tweet, etc.)
  | 'self_reflection'       // Self-evaluation & model update
  | 'voice_conversation';   // Voice channel interaction
