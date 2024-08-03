const sodium = require('libsodium-wrappers');
const dotenv = require('dotenv');
const { Client, GatewayIntentBits } = require("discord.js");
const { joinVoiceChannel, EndBehaviorType, VoiceConnectionStatus, createAudioPlayer, createAudioResource, AudioPlayerStatus, generateDependencyReport } = require('@discordjs/voice');
const fs = require('fs');
const prism = require('prism-media');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const { OpenAI } = require('openai');
const { sendMessage, destinationToPort } = require('../utils/request_utils');
const { execFile } = require('child_process');
const { getEmotionParameters } = require('../utils/emotion');
const { Worker, isMainThread, parentPort } = require('worker_threads');
const { default: axios } = require("axios");

dotenv.config();

const SAMPLE_RATE = 8000;
const SILENCE_DURATION = 500; // 0.5秒

class VoiceReceiver {
    constructor() {
        this.voiceMode = process.argv[4] || "OpenAi";
        this.isTest = process.argv[5] === "test";
        console.log("isTest", this.isTest);
        console.log("voiceMode", this.voiceMode);

        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.GuildVoiceStates,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildMessageReactions,
                GatewayIntentBits.GuildMembers,
            ]
        });

        this.guildId = process.argv[2];
        this.channelId = process.argv[3];
        this.ws = null;
        this.player = createAudioPlayer();
        this.playQueue = [];
        this.isPlaying = false;
        this.isMusic = false;
        this.pausedResource = null;
        this.pausedTime = 0;
        this.filePath = null;
        this.voicePeakWorker = new Worker(path.join(__dirname, 'voice_peak_worker.js'));
        this.playQueueCheckCount = 0;
        this.openai = new OpenAI(process.env.OPENAI_API_KEY);
        this.rpc = axios.create({ baseURL: "http://localhost:50021", proxy: false });
        this.connection = null;

        this.setupEventListeners();
        this.connectWebSocket();
        this.setupExpressServer();
        this.client.login(process.env.TOKEN).catch(error => {
            sendMessage(`エラーが発生しました: ${error}`);
        });

        setInterval(this.processPlayQueue.bind(this), 1000); // 1秒ごとにチェック
    }

    setupEventListeners() {
        this.client.on('ready', this.onReady.bind(this));
        this.player.on(AudioPlayerStatus.Playing, () => {
            console.log(`再生を開始しました: ${this.filePath}`);
            this.isPlaying = true;
        });
        this.player.on(AudioPlayerStatus.Idle, this.onIdle.bind(this));
        this.player.on('error', (error) => this.handleError(error, this.filePath));
    }

    connectWebSocket() {
        this.ws = new WebSocket(`ws://localhost:${destinationToPort("shannon_voice_client", this.isTest)}`);

        this.ws.on('open', () => {
            console.log('WebSocket connection established');
        });

        this.ws.on('message', (message) => {
            console.log('Received message:', message);
        });

        this.ws.on('close', () => {
            console.log('WebSocket connection closed, attempting to reconnect...');
            setTimeout(this.connectWebSocket.bind(this), 1000); // 1秒後に再接続を試みる
        });

        this.ws.on('error', (error) => {
            console.error('WebSocket error:', error);
        });
    }

    onReady() {
        console.log('ready!');
        console.log(generateDependencyReport());

        if (!this.guildId || !this.channelId) {
            console.error('Guild id or channel id not provided');
            return;
        }

        const guild = this.client.guilds.cache.find(g => g.id === this.guildId);
        if (!guild) {
            console.error(`Guild ${this.guildId} not found`);
            return;
        }

        const voiceChannel = guild.channels.cache.find(channel => channel.id === this.channelId && channel.type === 2);
        if (!voiceChannel) {
            console.error(`Channel ${this.channelId} not found in guild ${this.guildId}`);
            return;
        }

        try {
            this.connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: guild.id,
                adapterCreator: guild.voiceAdapterCreator,
                selfDeaf: false,
                selfMute: false
            });

            this.connection.subscribe(this.player);

            this.connection.receiver.speaking.on('start', async userId => {
                const user = await guild.members.fetch(userId);
                if (user) {
                    const nickname = user.nickname || user.user.username;
                    console.log(`ボイスチャンネルに接続しました: ${nickname}`);

                    const audioStream = this.connection.receiver.subscribe(userId, {
                        end: {
                            behavior: EndBehaviorType.AfterSilence,
                            duration: SILENCE_DURATION
                        }
                    });
                    const pcmStream = audioStream.pipe(new prism.opus.Decoder({ rate: SAMPLE_RATE, channels: 1, frameSize: 960 }));

                    pcmStream.on('data', (chunk) => {
                        this.ws.send(chunk); // WebSocketを通じてPCMデータを送信
                    });

                    const jstTime = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }).replace(/[:.]/g, '-').replace(/\//g, '-').replace(/ /g, '_');

                    pcmStream.on('end', () => {
                        this.ws.send(JSON.stringify({ type: 'end', nickname, jstTime }));
                    });
                }
            });
        } catch (error) {
            console.error(error);
            sendMessage(`エラーが発生しました: ${error}`);
        }
    }

    onIdle() {
        console.log("player.on(AudioPlayerStatus.Idle)");
        if (fs.existsSync(this.filePath)) {
            console.log(`再生が終了しました: ${this.filePath}`);
            this.isPlaying = false;
            if (!this.isMusic) {
                fs.unlinkSync(this.filePath);
            }
        } else {
            console.log(`ファイルが存在しません: ${this.filePath}`);
        }
    }

    handleError(error, filePath) {
        console.error(`再生中にエラーが発生しました: ${error.message}`);
    }

    processPlayQueue() {
        if (this.isPlaying || this.playQueue.length === 0) {
            return;
        }
        if (this.playQueueCheckCount >= 10) {
            console.log("ファイルパスが設定されなかったため、先頭のキューアイテムを無視します");
            this.playQueue.shift(); // 先頭のアイテムを無視
            this.playQueueCheckCount = 0;
            this.isPlaying = false;
        } else {
            const { id, filePath, res, isMusic } = this.playQueue[0];
            if (filePath) {
                this.filePath = filePath;
                this.isMusic = isMusic || false;

                if (this.filePath) {
                    const resource = createAudioResource(fs.createReadStream(this.filePath));
                    this.player.play(resource);
                }

                if (res && !res.headersSent) {
                    res.status(200).send({ success: true, result: "Message sent" });
                }

                this.playQueue.shift(); // 再生を開始したので先頭のアイテムを削除
            } else {
                this.playQueueCheckCount++;
            }
        }
    }

    setupExpressServer() {
        const app = express();
        app.use(bodyParser.json());

        app.post('/discord_voice_chat_send', this.handleVoiceChatSend.bind(this));
        app.post('/discord_play_music', this.handlePlayMusic.bind(this));
        app.post('/discord_stop_music', this.handleStopMusic.bind(this));
        app.post('/discord_replay_music', this.handleReplayMusic.bind(this));
        app.post('/discord_voice_chat_logout', this.handleVoiceChatLogout.bind(this));

        const PORT = Number(destinationToPort("voice_receiver", this.isTest));
        app.listen(PORT, () => {
            console.log(`Server is running on port ${PORT}`);
        });
    }

    async handleVoiceChatLogout(req, res) {
        console.log("discord_voice_chat_logout");
        if (!this.guildId || !this.channelId) {
            console.error('Guild id or channel id not provided');
            res.status(400).send({ success: false, result: "Guild id or channel id not provided" });
            return;
        }

        const guild = this.client.guilds.cache.find(g => g.id === this.guildId);
        if (!guild) {
            console.error(`Guild ${this.guildId} not found`);
            res.status(404).send({ success: false, result: `Guild ${this.guildId} not found` });
            return;
        }

        const voiceChannel = guild.channels.cache.find(channel => channel.id === this.channelId && channel.type === 2);
        if (!voiceChannel) {
            console.error(`Channel ${this.channelId} not found in guild ${this.guildId}`);
            res.status(404).send({ success: false, result: `Channel ${this.channelId} not found in guild ${this.guildId}` });
            return;
        }

        if (this.connection) {
            this.connection.disconnect();
            res.status(200).send({ success: true, result: "Disconnected from voice channel" });
        } else {
            res.status(400).send({ success: false, result: "Not connected to any voice channel" });
        }
    }

    async createOpenAISpeech(message, actor) {
        try {
            const speech = await this.openai.audio.speech.create({
                model: "tts-1",
                voice: actor,
                input: message
            });
            console.log("message,actor", message, actor);
            console.log("speech", speech);
            const buffer = await speech.arrayBuffer(); // 追加: ArrayBufferを取得
            return buffer;
        } catch (error) {
            console.error('Error creating speech:', error);
            throw error;
        }
    }

    async createVoiceVoxSpeech(message) {
        try {
            const audio_query = await this.rpc.post('audio_query?text=' + encodeURI(message) + '&speaker=2');

            const synthesis = await this.rpc.post("synthesis?speaker=2", JSON.stringify(audio_query.data), {
                responseType: 'arraybuffer',
                headers: {
                    "accept": "audio/wav",
                    "Content-Type": "application/json"
                }
            });

            // 音声データを返す
            return synthesis.data;
        } catch (error) {
            console.error('Error creating speech:', error);
            throw error;
        }
    }

    async createVoicePeakSpeech(message, emotion) {
        const { happy, sad, angry, fun, pitch, speed } = getEmotionParameters(emotion);
        const args = {
            message,
            narrator: "Japanese Female 4",
            happy,
            sad,
            angry,
            fun,
            pitch,
            speed
        };

        return new Promise((resolve, reject) => {
            this.voicePeakWorker.postMessage(args);
            this.voicePeakWorker.once('message', (data) => {
                if (data.error) {
                    reject(data.error);
                } else {
                    resolve(data.buffer);
                }
            });
        });
    }

    async handleVoiceChatSend(req, res) {
        console.log("discord_voice_chat_send");
        const { emotion, message } = req.body;
        const id = Math.random().toString(36).substring(7);
        this.playQueue.push({ id, filePath: null, res, isMusic: false });
        try {
            let speechData;
            const tempFilePath = path.join(__dirname, 'temp_audio.wav');
            if (this.voiceMode === "VoicePeak") {
                speechData = await this.createVoicePeakSpeech(message, emotion);
                await fs.promises.writeFile(tempFilePath, Buffer.from(speechData));
            } else if (this.voiceMode === "VoiceVox") {
                speechData = await this.createVoiceVoxSpeech(message);
                // fs.writeFileSync(filepath, new Buffer.from(synthesis.data), 'binary');
                await fs.promises.writeFile(tempFilePath, Buffer.from(speechData));
            } else {
                speechData = await this.createOpenAISpeech(message, "nova");
                await fs.promises.writeFile(tempFilePath, Buffer.from(speechData));
            }

            const queueItem = this.playQueue.find(item => item.id === id);
            if (queueItem) {
                queueItem.filePath = tempFilePath;
            } else {
                console.error('指定されたIDのキューアイテムが見つかりません');
            }
        } catch (error) {
            console.error('Error sending message:', error);
            if (!res.headersSent) {
                res.status(500).send({ success: false, result: `Error: ${error.message}` });
            }
        }
    }

    async handlePlayMusic(req, res) {
        console.log("discord_play_music");
        const { music_name } = req.body;
        const id = Math.random().toString(36).substring(7);
        this.playQueue.push({ id, filePath: null, res, isMusic: true });
        try {
            const currentDir = process.cwd();
            const musicDir = path.join(currentDir, '../../', 'saves', 'music');
            const musicFilePath = path.join(musicDir, `${music_name}.wav`);

            if (fs.existsSync(musicFilePath)) {
                const queueItem = this.playQueue.find(item => item.id === id);
                if (queueItem) {
                    queueItem.filePath = musicFilePath;
                } else {
                    console.error('指定されたIDのキューアイテムが見つかりません');
                }
            } else {
                res.status(404).send({ success: false, result: `${music_name}が見つかりません` });
            }
        } catch (error) {
            console.error('音楽の再生中にエラーが発生しました:', error);
            if (!res.headersSent) {
                res.status(500).send({ success: false, result: `エラー: ${error.message}` });
            }
        }
    }

    async handleStopMusic(req, res) {
        console.log("discord_stop_music");
        if (this.isPlaying) {
            this.pausedResource = this.player.state.resource;
            this.pausedTime = this.player.state.playbackDuration;
            this.player.stop();
            this.pausedResource = null;
            this.isPlaying = false;
            if (!res.headersSent) {
                res.status(200).send({ success: true, result: "再生を一時停止しました" });
            }
        } else {
            if (!res.headersSent) {
                res.status(400).send({ success: false, result: "再生中の音楽がありません" });
            }
        }
    }

    async handleReplayMusic(req, res) {
        console.log("discord_replay_music");
        if (this.pausedResource) {
            const resource = createAudioResource(fs.createReadStream(this.filePath), {
                inputType: this.pausedResource.metadata.inputType,
                inlineVolume: this.pausedResource.metadata.inlineVolume,
                seek: this.pausedTime / 1000
            });
            this.player.play(resource);

            this.pausedResource = null;
            this.pausedTime = 0;
            if (!res.headersSent) {
                res.status(200).send({ success: true, result: "再生を再開しました" });
            }
        } else {
            if (!res.headersSent) {
                res.status(400).send({ success: false, result: "再開する音楽がありません" });
            }
        }
    }
}

new VoiceReceiver();