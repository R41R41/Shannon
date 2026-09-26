import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import type { ClarificationSession } from './clarificationSessionStore.js';

export function buildClarificationEmbed(session: ClarificationSession, completed = false): EmbedBuilder {
  const lines = completed && session.answers
    ? session.questions.map(question => `**${question.label}**\n${session.answers?.[question.id] || '指定なし'}`)
    : session.questions.map((question, index) => {
      const options = question.options?.length
        ? `\n候補: ${question.options.map((option, optionIndex) => `${optionIndex + 1}. ${option}`).join(' / ')} / その他（自由入力）`
        : question.kind === 'number' ? '\n数値で入力（補足も可）' : '\n自由入力';
      return `**${index + 1}. ${question.label}**${question.description ? `\n${question.description}` : ''}${options}`;
    });
  if (completed && session.answers?.['推奨条件']) lines.unshift(`**承認した条件**\n${session.answers['推奨条件']}`);
  return new EmbedBuilder()
    .setColor(completed ? 0x57f287 : 0x5b8def)
    .setTitle(completed ? '要件を受け取りました' : '少しだけ確認させてください')
    .setDescription([
      !completed && session.proposal ? `**推奨条件**\n${session.proposal}` : null,
      ...lines,
      completed ? '\n回答は反映済みです。' : '\n選択肢に合わない場合は、そのまま自由に入力できます。',
    ].filter(Boolean).join('\n\n').slice(0, 4000))
    .setFooter({ text: completed ? 'Shannon • 回答反映済み' : 'Shannon • 回答待ち（24時間有効）' });
}

export function buildClarificationComponents(session: ClarificationSession): Array<ActionRowBuilder<any>> {
  const rows: Array<ActionRowBuilder<any>> = [];
  session.questions.forEach((question, index) => {
    if (rows.length >= 4 || !['single_select', 'multi_select', 'confirm'].includes(question.kind)) return;
    const sourceOptions = question.options?.length ? question.options : question.kind === 'confirm' ? ['はい', 'いいえ'] : [];
    const options = sourceOptions.slice(0, 7).map((option, optionIndex) => ({
      label: option.slice(0, 100), value: `option_${optionIndex}`,
      description: option.length > 100 ? option.slice(100, 200) : undefined,
    }));
    options.push({ label: 'その他（自由入力）', value: '__custom__', description: '選択肢にない内容を入力' });
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`shannon_clarify_select:${session.clarificationId}:${index}`)
        .setPlaceholder(question.label.slice(0, 150)).addOptions(options)
        .setMinValues(question.required === false ? 0 : 1)
        .setMaxValues(question.kind === 'multi_select' ? options.length : 1),
    ));
  });
  const buttons = new ActionRowBuilder<ButtonBuilder>();
  if (session.proposal) {
    buttons.addComponents(
      new ButtonBuilder().setCustomId(`shannon_clarify:accept:${session.clarificationId}`).setLabel('この条件で開始').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`shannon_clarify:edit:${session.clarificationId}`).setLabel('条件を変更').setStyle(ButtonStyle.Secondary),
    );
  } else {
    buttons.addComponents(new ButtonBuilder().setCustomId(`shannon_clarify:edit:${session.clarificationId}`).setLabel('回答を送信').setStyle(ButtonStyle.Primary));
  }
  rows.push(buttons);
  return rows;
}
