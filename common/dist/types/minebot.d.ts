export interface MinebotOutput {
    success?: boolean | null;
    result?: string | null;
    failureType?: string | null;
    recoverable?: boolean | null;
    skillName?: string | null;
    senderName?: string | null;
    message?: string | null;
    senderPosition?: string | null;
    botPosition?: string | null;
    botHealth?: string | null;
    botFoodLevel?: string | null;
}
export type MinebotStartOrStopInput = {
    serverName?: string | null;
};
export type MinebotSkillInput = {
    skillName?: string | null;
    text?: string | null;
};
export type MinebotInput = MinebotStartOrStopInput | MinebotSkillInput;
/**
 * Known static minebot event types.
 * Dynamic skill events (e.g. 'minebot:move-to') still use the template literal fallback.
 */
export type MinebotStaticEventType = 'minebot:status' | 'minebot:bot:status' | 'minebot:spawned' | 'minebot:error' | 'minebot:stopped' | 'minebot:chat' | 'minebot:voice_chat' | 'minebot:voice_response' | 'minebot:loadSkills' | 'minebot:stopInstantSkill' | 'minebot:getInstantSkills';
export type MinebotEventType = MinebotStaticEventType | `minebot:${string}`;
export type SkillParameters = {
    skillParameters: unknown;
};
export type SkillResult = {
    success: boolean;
    result: string;
    failureType?: string;
    recoverable?: boolean;
};
export interface MinebotVoiceChatInput {
    userName: string;
    message: string;
    guildId: string;
    channelId: string;
}
export interface MinebotVoiceResponseOutput {
    guildId: string;
    channelId: string;
    responseText: string;
}
