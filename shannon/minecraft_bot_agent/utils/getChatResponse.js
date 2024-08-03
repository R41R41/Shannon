/**
 * @param {import('../types').CustomBot} bot - The bot instance from mineflayer
 * @param {string} question - The question to ask the bot
 * @returns {string} - The response from the bot
 */
module.exports = async function getChatResponse(bot, question) {
    return new Promise((resolve, reject) => {
        bot.chat(question);
        bot.chatMode = false;

        const responseListener = (username, message) => {
            if (username !== bot.username) {
                bot.removeListener('chat', responseListener);
                resolve(message);
                bot.chatMode = true;
            }
        };

        bot.on('chat', responseListener);

        setTimeout(() => {
            bot.removeListener('chat', responseListener);
            reject(new Error('No response'));
            bot.chatMode = true;
        }, 180000); // 3分間
    });
}