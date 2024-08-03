
module.exports = class PostRequestToLLM {
    /**
     * @param {import('../types').CustomBot} bot - The bot instance from mineflayer
     */
    constructor(bot) {
        this.bot = bot;
    }
    /**
     * @param {object} data - The data to send to the LLM
     * @param {string} endpoint - The endpoint to send the request to
     * @returns {Promise<object>} - The response from the LLM
     */
    async run(data, endpoint) {
        try{
            const port = this.bot.isTest ? 3001 : 3000;
            const url = `http://localhost:${port}/minecraft/${endpoint}`;
            const requestOptions = {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            };
            console.log(`Sending request to: ${url}`);
            const response = await fetch(url, requestOptions)
                        .catch(error => console.error('Error sending message:', error));
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                throw new Error(`Expected JSON response but got ${contentType}`);
            }

            const result = await response.json(); // テキストをJSONにパース
            console.log("result", result);
            if (result.success){
                return { "success": true, "result": result.result };
            } else {
                return { "success": false, "result": result.result };
            }
        } catch (error) {
            console.error('Error parsing response:', error); // エラーをログに出力
            return { "success": false, "result": error.message };
        }
    }   
}
