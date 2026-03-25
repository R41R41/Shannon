/**
 * Channel-specific action types and the unified ShannonActionPlan.
 */

import type { ShannonChannel } from './channels.js';
import type { RequestEnvelope } from './envelope.js';

/** Minecraft physical action. */
export type MinecraftAction =
  | { type: 'say'; text: string }
  | { type: 'move_to'; x: number; y: number; z: number }
  | { type: 'follow'; target: string; distance?: number }
  | { type: 'mine'; block: string; count?: number }
  | { type: 'craft'; item: string; count?: number }
  | { type: 'place'; item: string; x: number; y: number; z: number }
  | { type: 'attack'; target: string }
  | { type: 'defend'; strategy?: string }
  | { type: 'observe'; target?: string; radius?: number }
  | { type: 'use_skill'; skillName: string; args: Record<string, unknown> };

/** X (Twitter) action. */
export type XAction =
  | { type: 'reply'; text: string }
  | { type: 'post'; text: string }
  | { type: 'quote'; text: string; targetTweetId: string }
  | { type: 'draft'; text: string };

/** Discord action. */
export type DiscordAction =
  | { type: 'reply'; text: string }
  | { type: 'react'; emoji: string }
  | { type: 'send_embed'; title: string; body: string; color?: number }
  | { type: 'voice_speak'; text: string };

/**
 * Channel-specific action plan produced by action_formatter.
 *
 * The message field is the generic text response.
 * Channel-specific arrays contain platform-native actions.
 */
export interface ShannonActionPlan {
  channel: ShannonChannel;

  /** Generic text response (works on any channel). */
  message?: string;

  /** Minecraft physical actions (ordered). */
  minecraftActions?: MinecraftAction[];

  /** X (Twitter) actions. */
  xActions?: XAction[];

  /** Discord actions. */
  discordActions?: DiscordAction[];
}

// ---------------------------------------------------------------------------
// Adapter & Dispatcher contracts
// ---------------------------------------------------------------------------

/**
 * Input adapter: converts channel-native events into RequestEnvelopes.
 *
 * Adapters are intentionally input-only. Output dispatch is handled
 * by ActionDispatcher, which receives the original envelope alongside
 * the plan so it has full context (channel IDs, user IDs, etc.).
 */
export interface ChannelAdapter<TNativeEvent = unknown> {
  readonly channel: ShannonChannel;

  /** Convert a native channel event into a RequestEnvelope. */
  toEnvelope(event: TNativeEvent): RequestEnvelope;
}

/**
 * Output dispatcher: sends ShannonActionPlans back to the originating channel.
 *
 * Receives the original envelope so it can extract any channel-specific
 * routing info (Discord channelId, X tweetId, etc.) without hacks.
 */
export interface ActionDispatcher {
  readonly channel: ShannonChannel;

  /** Send the action plan back to the channel. */
  dispatch(envelope: RequestEnvelope, plan: ShannonActionPlan): Promise<void>;
}
