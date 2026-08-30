import type { Client } from 'discord.js';
import type { HierarchicalSubTask, TaskTreeState } from '@shannon/common';
import type { DiscordConversationBinding } from '../../modules/conversation/discordConversation.js';
import { ConversationDeniedError, hasDiscordConversation } from '../../modules/conversation/discordConversation.js';

type LegacyPlanSubTask = NonNullable<TaskTreeState['subTasks']>[number];

function statusEmoji(status: string): string {
  switch (status) {
    case 'completed': return '🟢';
    case 'in_progress': return '🔵';
    case 'pending': return '🟡';
    case 'error': return '🔴';
    default: return '⚪';
  }
}

export async function deliverDiscordPlanning(
  client: Client,
  binding: DiscordConversationBinding,
  planning: TaskTreeState,
  taskId: string,
  isRunning: () => boolean,
): Promise<void> {
  if (!hasDiscordConversation(binding) || !isRunning() || !client.user) throw new ConversationDeniedError();
  const channel = client.channels.cache.get(binding.channelId);
  if (!channel?.isTextBased() || !('send' in channel) || !('messages' in channel)) throw new ConversationDeniedError();
  const messages = await channel.messages.fetch({ limit: 10 });
  const existingMessage = messages.find(
    (msg: { author: { id: string }; content: string }) => msg.author.id === client.user?.id && msg.content.includes(`TaskID: ${taskId}`),
  );
  const legend = '🟢:完了, 🔵:進行中, 🟡:保留, 🔴:エラー, ⚪:その他';
  if (planning.status === 'completed') {
    if (existingMessage) await existingMessage.delete();
    return;
  }
  let formattedContent = `TaskID: ${taskId}\n\n${statusEmoji(planning.status)} ${planning.goal}\n${planning.strategy}\n`;
  if (planning.hierarchicalSubTasks?.length) {
    for (const subTask of planning.hierarchicalSubTasks as HierarchicalSubTask[]) {
      const depth = subTask.depth ?? 0;
      const indent = '  '.repeat(depth + 1);
      formattedContent += `${indent}${statusEmoji(subTask.status)} ${subTask.goal}\n`;
      if (subTask.result) formattedContent += `${indent}  → ${subTask.result.substring(0, 100)}\n`;
      if (subTask.failureReason) formattedContent += `${indent}  ✗ ${subTask.failureReason.substring(0, 100)}\n`;
    }
  }
  if (planning.subTasks?.length) {
    for (const subTask of planning.subTasks as LegacyPlanSubTask[]) {
      formattedContent += `  ${statusEmoji(subTask.subTaskStatus)} ${subTask.subTaskGoal}\n`;
      formattedContent += `  ${subTask.subTaskStrategy}\n`;
    }
  }
  const payload = `\`\`\`\n${formattedContent}\n\n${legend}\n\`\`\``;
  if (existingMessage) await existingMessage.edit(payload);
  else await channel.send(payload);
}

export async function listGuildEmojis(client: Client, guildId: string): Promise<string[]> {
  const guild = client.guilds.cache.get(guildId);
  return guild ? guild.emojis.cache.map(emoji => emoji.toString()) : [];
}

export async function reactToMessage(
  client: Client,
  binding: DiscordConversationBinding,
  messageId: string,
  emojiId: string,
): Promise<{ isSuccess: boolean; errorMessage: string }> {
  try {
    if (!hasDiscordConversation(binding)) return { isSuccess: false, errorMessage: 'conversation denied' };
    const channel = client.channels.cache.get(binding.channelId);
    if (!channel?.isTextBased() || !('messages' in channel)) return { isSuccess: false, errorMessage: 'channel unavailable' };
    const message = await channel.messages.fetch(messageId);
    if (!message || message.channelId !== binding.channelId) return { isSuccess: false, errorMessage: 'message unavailable' };
    const guild = binding.guildId ? client.guilds.cache.get(binding.guildId) : undefined;
    const serverEmoji = guild?.emojis.cache.get(emojiId);
    await message.react(serverEmoji ?? emojiId);
    return { isSuccess: true, errorMessage: '' };
  } catch (error) {
    return { isSuccess: false, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}
