import { CONFIG } from '../config/MinebotConfig.js';
import { notifyUiModChat } from '../uiMod/uiModChat.js';
import { CustomBot, InstantSkill } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { SkillParam } from '../types/skillParams.js';
import { sendGameChatLimited } from '../utils/sendGameChatLimited.js';

const log = createLogger('Minebot:Skill:chat');

class Chat extends InstantSkill {
    skillName = 'chat';
    description =
        'Minecraftのチャットに短いメッセージを1通だけ送る（長文は自動で省略。詳細は task-complete 等に書く）';
    params: SkillParam[] = [
        {
            name: 'message',
            type: 'string' as const,
            description: `ゲーム内に出す一言。${CONFIG.MINECRAFT_CHAT_MAX_CHARS}文字以内に自分で要約すること（改行・長文禁止）`,
            required: true,
        },
    ];
    isToolForLLM = true;

    private static lastSentNormalized: string = '';
    private static lastSentTime: number = 0;
    private static readonly DEDUP_WINDOW_MS = 5000;

    constructor(bot: CustomBot) {
        super(bot);
    }

    async runImpl(message: string) {
        if (!message) {
            return { success: false, result: 'メッセージが指定されていません' };
        }

        if (this.bot.suppressMinebotGameChat) {
            await notifyUiModChat(message).catch((err) => {
                log.error('Failed to notify UI Mod', err);
            });
            return {
                success: true,
                result:
                    '緊急モードのためゲーム内チャットは送信していません（UI Mod のみ通知）。生存行動を優先してください。',
            };
        }

        const max = CONFIG.MINECRAFT_CHAT_MAX_CHARS;
        const singleLine = message
            .replace(/\r\n/g, ' ')
            .replace(/\n/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        const now = Date.now();
        if (
            singleLine === Chat.lastSentNormalized &&
            now - Chat.lastSentTime < Chat.DEDUP_WINDOW_MS
        ) {
            log.info(`💬 重複チャットスキップ (${now - Chat.lastSentTime}ms前に同一送信済): ${singleLine.slice(0, 60)}`, 'yellow');
            return { success: true, result: '(同一メッセージが直前に送信済のためスキップ)' };
        }

        const sent = sendGameChatLimited(this.bot, message, max);
        Chat.lastSentNormalized = singleLine;
        Chat.lastSentTime = now;
        const truncated = singleLine.length > max;

        if (truncated) {
            log.info(
                `💬 チャット送信: ${sent}（省略あり・元${message.length}文字→ゲーム内${sent.length}文字・上限${max}）`,
                'magenta',
            );
        } else {
            log.info(`💬 チャット送信: ${sent}`, 'magenta');
        }

        notifyUiModChat(message).catch(err => {
            log.error('Failed to notify UI Mod', err);
        });

        const detail = truncated
            ? `ゲーム内には短く送信しました（${sent.length}文字）。長い内容は task-complete の summary 等に書くこと。送信文: ${sent}`
            : `メッセージを送信しました: ${sent}`;
        return { success: true, result: detail };
    }

}

export default Chat;
