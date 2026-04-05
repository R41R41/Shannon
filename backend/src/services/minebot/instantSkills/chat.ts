import { CONFIG } from '../config/MinebotConfig.js';
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

    constructor(bot: CustomBot) {
        super(bot);
    }

    async runImpl(message: string) {
        if (!message) {
            return { success: false, result: 'メッセージが指定されていません' };
        }

        if (this.bot.suppressMinebotGameChat) {
            await this.notifyUIMod(message).catch((err) => {
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
        const sent = sendGameChatLimited(this.bot, message, max);
        const truncated = singleLine.length > max;

        if (truncated) {
            log.info(
                `💬 チャット送信: ${sent}（省略あり・元${message.length}文字→ゲーム内${sent.length}文字・上限${max}）`,
                'magenta',
            );
        } else {
            log.info(`💬 チャット送信: ${sent}`, 'magenta');
        }

        this.notifyUIMod(message).catch(err => {
            log.error('Failed to notify UI Mod', err);
        });

        const detail = truncated
            ? `ゲーム内には短く送信しました（${sent.length}文字）。長い内容は task-complete の summary 等に書くこと。送信文: ${sent}`
            : `メッセージを送信しました: ${sent}`;
        return { success: true, result: detail };
    }

    /**
     * UI Modのチャットタブにボットのメッセージを通知
     */
    private async notifyUIMod(message: string): Promise<void> {
        try {
            const response = await fetch(`${CONFIG.UI_MOD_BASE_URL}/bot_chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message }),
            });

            if (!response.ok) {
                log.warn(`UI Mod notification failed: ${response.status}`);
            }
        } catch (error) {
            // UI Modが起動していない場合など、エラーは無視
        }
    }
}

export default Chat;
