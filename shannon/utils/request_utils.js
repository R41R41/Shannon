const sendMessage = async (message) => {
    const data = {
        text: message,
        embed_image_url: "",
        file_path: "",
        channel_id: "1240656484640100453"
    };
    await sendRequest(data, "discord_bot", "chat");
}

const destinationToPort = (destination, isTest) => {
    const switcher = isTest ? {
        "shannon": "3001",
        "shannon_voice_client": "3051",
        "minecraft_server": "3101",
        "minecraft_bot": "3201",
        "mineflayer": "3251",
        "discord_bot": "3301",
        "discord_voice_client": "3341",
        "voice_receiver": "3351",
        "twitter_bot": "3401",
        "youtube_bot": "3501",
    } : {
        "shannon": "3000",
        "shannon_voice_client": "3050",
        "minecraft_server": "3100",
        "minecraft_bot": "3200",
        "mineflayer": "3250",
        "discord_bot": "3300",
        "discord_voice_client": "3340",
        "voice_receiver": "3350",
        "twitter_bot": "3400",
        "youtube_bot": "3500",
    };
    return switcher[destination] || null;
};

const sendRequest = async (data, destination, endpoint, isTest) => {
    const port = destinationToPort(destination, isTest);
    if (!port) {
        console.error(`Destination ${destination} not found`);
        return;
    }
    const url = `http://localhost:${port}/${endpoint}`;
    console.log("url", url);
    const requestOptions = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    };
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
    return result;
}

module.exports = {
    sendMessage,
    destinationToPort,
    sendRequest
};