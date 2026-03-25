/**
 * Action Formatter Node
 *
 * Converts the generic finalAnswer from the Shannon core graph
 * into a channel-specific ShannonActionPlan.
 *
 * This node sits between the responder and the output dispatch:
 * - The responder produces Shannon's persona & content (finalAnswer)
 * - The action_formatter translates that into channel-native actions
 * - Minecraft gets physical actions inferred from the answer
 * - Discord/X/Web get appropriate message actions
 */

import {
  ShannonGraphState,
  ShannonActionPlan,
  MinecraftAction,
  DiscordAction,
  XAction,
} from '@shannon/common';

/**
 * Graph node: format the final answer into a channel-specific action plan.
 *
 * This is a pure function (no LLM calls). For Minecraft, a future version
 * may use an LLM to infer physical actions from the plan/finalAnswer,
 * but for Phase 1 this extracts actions from the existing plan structure.
 */
export async function actionFormatterNode(
  state: ShannonGraphState,
): Promise<Partial<ShannonGraphState>> {
  const channel = state.envelope.channel;
  const message = state.finalAnswer ?? '';

  if (channel === 'minecraft') {
    return {
      actionPlan: formatMinecraftPlan(state, message),
    };
  }

  if (channel === 'discord') {
    return {
      actionPlan: formatDiscordPlan(state, message),
    };
  }

  if (channel === 'x') {
    return {
      actionPlan: formatXPlan(state, message),
    };
  }

  // Default (web, youtube, etc.): just the text message
  return {
    actionPlan: {
      channel,
      message,
    },
  };
}

// ---------------------------------------------------------------------------
// Minecraft
// ---------------------------------------------------------------------------

function formatMinecraftPlan(
  state: ShannonGraphState,
  message: string,
): ShannonActionPlan {
  const actions: MinecraftAction[] = [];
  const actionSequence =
    state.plan?.nextActions
    ?? state.taskTree?.nextActionSequence
    ?? state.taskTree?.actionSequence
    ?? [];

  // NOTE: Don't create 'say' actions from finalAnswer for Minecraft.
  // The FCA already sends chat messages directly via the 'chat' tool during execution.
  // Adding a 'say' here would cause duplicate messages.

  for (const action of actionSequence) {
    const mapped = mapToolToMinecraftAction(action.toolName, action.args);
    if (mapped) {
      actions.push(mapped);
    }
  }

  return {
    channel: 'minecraft',
    message: '',
    minecraftActions: actions.length > 0 ? actions : undefined,
  };
}

/**
 * Map a tool call (from existing skill system) to a typed MinecraftAction.
 * Falls back to use_skill for unknown tools.
 */
function mapToolToMinecraftAction(
  toolName: string,
  args: Record<string, unknown>,
): MinecraftAction | null {
  switch (toolName) {
    case 'goToPosition':
    case 'go_to_position':
      return {
        type: 'move_to',
        x: Number(args.x ?? 0),
        y: Number(args.y ?? 0),
        z: Number(args.z ?? 0),
      };
    case 'followPlayer':
    case 'follow_player':
      return {
        type: 'follow',
        target: String(args.playerName ?? args.target ?? ''),
      };
    case 'mineBlock':
    case 'mine_block':
    case 'collectBlock':
    case 'collect_block':
      return {
        type: 'mine',
        block: String(args.blockName ?? args.block ?? ''),
        count: args.count != null ? Number(args.count) : undefined,
      };
    case 'craftItem':
    case 'craft_item':
      return {
        type: 'craft',
        item: String(args.itemName ?? args.item ?? ''),
        count: args.count != null ? Number(args.count) : undefined,
      };
    case 'placeBlock':
    case 'place_block':
      return {
        type: 'place',
        item: String(args.blockName ?? args.item ?? ''),
        x: Number(args.x ?? 0),
        y: Number(args.y ?? 0),
        z: Number(args.z ?? 0),
      };
    case 'attackEntity':
    case 'attack_entity':
    case 'attackNearest':
    case 'attack_nearest':
      return {
        type: 'attack',
        target: String(args.entityName ?? args.target ?? 'nearest'),
      };
    case 'lookAround':
    case 'look_around':
    case 'observeEnvironment':
      return {
        type: 'observe',
        radius: args.radius != null ? Number(args.radius) : undefined,
      };
    default:
      // Fallback: wrap as use_skill to preserve existing InstantSkill compat
      return {
        type: 'use_skill',
        skillName: toolName,
        args: args as Record<string, unknown>,
      };
  }
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

function formatDiscordPlan(
  state: ShannonGraphState,
  message: string,
): ShannonActionPlan {
  const actions: DiscordAction[] = [];

  if (message) {
    // Check if the envelope indicates voice channel
    if (state.envelope.discord?.isVoiceChannel) {
      actions.push({ type: 'voice_speak', text: message });
    } else {
      actions.push({ type: 'reply', text: message });
    }
  }

  return {
    channel: 'discord',
    message,
    discordActions: actions.length > 0 ? actions : undefined,
  };
}

// ---------------------------------------------------------------------------
// X (Twitter)
// ---------------------------------------------------------------------------

function formatXPlan(
  state: ShannonGraphState,
  message: string,
): ShannonActionPlan {
  const actions: XAction[] = [];

  if (message) {
    const isReply = state.envelope.x?.isReply ?? state.envelope.x?.tweetId != null;
    if (isReply) {
      actions.push({ type: 'reply', text: message });
    } else {
      actions.push({ type: 'post', text: message });
    }
  }

  return {
    channel: 'x',
    message,
    xActions: actions.length > 0 ? actions : undefined,
  };
}
