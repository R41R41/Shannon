const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');

class SkillExecutor {
    /**
     * @param {import('./types').CustomBot} bot
     */
    constructor(bot) {
        this.app = express();
        this.app.use(bodyParser.json());
        this.bot = bot;
        this.instantSkillDir = path.join(__dirname, 'instantSkills');
        this.constantSkillDir = path.join(__dirname, 'constantSkills');
    }

    async loadInstantSkills() {
        try {
            console.log("loadInstantSkills");
            const files = fs.readdirSync(this.instantSkillDir);
            for (const file of files) {
                try {
                    if (file.endsWith('.js') && !file.includes('instantSkill') && !file.includes('index')) {
                        const { default: skillClass } = await import(path.join(this.instantSkillDir, file));
                        const skillInstance = new skillClass(this.bot);
                        console.log(`\x1b[32m✓ ${skillInstance.skillName}\x1b[0m`);
                        this.bot.instantSkills[skillInstance.skillName] = skillInstance;
                    }
                } catch (error) {
                    return {"success": false, "result": `${file}の読み込みに失敗しました: ${error}`};
                }
            }
            return {"success": true, "result": "instantSkills loaded"};
        } catch (error) {
            return {"success": false, "result": `error: ${error}`};
        }
    }

    async loadConstantSkills() {
        try {
            console.log("loadConstantSkills");
            const files = fs.readdirSync(this.constantSkillDir);
            for (const file of files) {
                try {
                    if (file.endsWith('.js') && !file.includes('constantSkill') && !file.includes('index')) {
                        const { default: skillClass } = await import(path.join(this.constantSkillDir, file));
                        const skillInstance = new skillClass(this.bot);
                        console.log(`\x1b[32m✓ ${skillInstance.skillName}\x1b[0m`);
                        this.bot.constantSkills[skillInstance.skillName] = skillInstance;
                    }
                } catch (error) {
                    return {"success": false, "result": `${file}の読み込みに失敗しました: ${error}`};
                }
            }
            return {"success": true, "result": "constantSkills loaded"};
        } catch (error) {
            return {"success": false, "result": `error: ${error}`};
        }
    }

    async registerRoutes() {
        console.log("registering routes");
        Object.keys(this.bot.instantSkills).forEach(skillName => {
            console.log(`\x1b[32m✓ ${skillName}\x1b[0m`);
            this.app.post(`/${skillName}`, async (req, res) => {
            try {
                const data = req.body;
                const InstantSkill = this.bot.instantSkills[skillName];
                if (InstantSkill.status) {
                    res.status(200).send({ "success": false, "result": `${skillName} is already active` });
                    return;
                }
                const params = await this.bot.utils.getParams(this.bot, data, InstantSkill.params);
                InstantSkill.status = true;
                const response = await InstantSkill.run(...Object.values(params));
                InstantSkill.status = false;
                // console.log(`${skillName} ${response.result}`);
                if (response.success) {
                    res.status(200).send({ "success": true, "result": response.result });
                } else {
                    res.status(500).send({ "success": false, "result": response.result });
                }
            } catch (error) {
                    console.log(`${skillName} error: ${error}`);
                    res.status(500).send({ "success": false, "result": `error: ${error}` });
                }
            });
        });
    }

    async registerConstantSkills() {
        console.log("registering constant skills");
        Object.keys(this.bot.constantSkills).forEach(skillName => {
            const skillInstance = this.bot.constantSkills[skillName];
            if (skillInstance.interval && skillInstance.interval > 0) {
                console.log(`\x1b[32m✓ ${skillName} ${skillInstance.interval}ms\x1b[0m`);
                this.bot.on(`taskPer${skillInstance.interval}ms`, async () => {
                    if (skillInstance.status && !skillInstance.isLocked) {
                        try {
                            await skillInstance.run();
                        } catch (error) {
                            console.log(`${skillName} error: ${error}`);
                        }
                    }
                });
            }
        });
    }

    async setInterval() {
        setInterval(() => {
            this.bot.emit('taskPer100ms');
        }, 100);

        setInterval(() => {
            this.bot.emit('taskPer1000ms');
        }, 1000);

        setInterval(() => {
            this.bot.emit('taskPer10000ms');
        }, 10000);
    }

    async registerPost() {
        this.app.post('/stop-instant-skill', async (req, res) => {
            try {
                const data = req.body;
                const skill_name = data["skill_name"];
                this.bot.instantSkills[skill_name].status = false;
                res.status(200).send({ "success": true, "result": `${skill_name} stopped` });
            } catch (error) {
                res.status(500).send({ "success": false, "result": `error: ${error}` });
            }
        });
    
        this.app.post('/get-instant-skills', async (req, res) => {
            try {
                const formattedResponse = Object.keys(this.bot.instantSkills).map(skillName => {
                    const description = this.bot.instantSkills[skillName].description;
                    return `skill_name: ${skillName}, description: ${description}`;
                }).join('\n');
                console.log(formattedResponse);
                res.status(200).send({ "success": true, "result": formattedResponse });
            } catch (error) {
                res.status(500).send({ "success": false, "result": `error: ${error}` });
            }
        });

        this.app.post('/load-skills', async (req, res) => {
            try {
                const initSkillsResponse = await this.initSkills();
                if (!initSkillsResponse.success) {
                    console.log(`error: ${initSkillsResponse.result}`);
                    res.status(500).send({ "success": false, "result": initSkillsResponse.result });
                    return;
                }
                res.status(200).send({ "success": true, "result": initSkillsResponse.result });
            } catch (error) {
                res.status(500).send({ "success": false, "result": `error: ${error}` });
            }
        });
    }

    async initSkills() {
        this.bot.instantSkills = {};
        this.bot.constantSkills = {};
        const instantSkillsResponse = await this.loadInstantSkills();
        if (!instantSkillsResponse.success) {
            return {"success": false, "result": instantSkillsResponse.result};
        }
        const constantSkillsResponse = await this.loadConstantSkills();
        if (!constantSkillsResponse.success) {
            return {"success": false, "result": constantSkillsResponse.result};
        }
        await this.registerRoutes();
        await this.registerConstantSkills();
        return {"success": true, "result": "skills loaded"};
    }

    async botOnChat(){
        this.bot.on('chat', async (username, message) => {
            if (!this.bot.chatMode) {
                return;
            }
            if (username === "I_am_Sh4nnon") {
                return;
            }
            console.log(`[${username}] ${message}`);
            if (!message) {
                return;
            }
            if (message === "..") {
                try {
                    await this.bot.instantSkills["display-instant-skill-list"].run();
                } catch (error) {
                    console.log(`display-instant-skill-list error: ${error}`);
                    this.bot.chat(`display-instant-skill-list error: ${error}`);
                }
                return;
            }
            if (message === "...") {
                try {
                    await this.bot.instantSkills["display-constant-skill-list"].run();
                } catch (error) {
                    console.log(`display-constant-skill-list error: ${error}`);
                    this.bot.chat(`display-constant-skill-list error: ${error}`);
                }
                return;
            }
            if (message === ".../") {
                try {
                    await this.bot.instantSkills["display-inventory"].run();
                } catch (error) {
                    console.log(`display-inventory error: ${error}`);
                    this.bot.chat(`display-inventory error: ${error}`);
                }
                return;
            }
            if (message.startsWith("./")) {
                const [skillName, ...args] = message.slice(2).split(' ');
                if (!this.bot.instantSkills[skillName]){
                    this.bot.chat(`${skillName}は存在しません`);
                    return;
                }
                try {
                    const InstantSkill = this.bot.instantSkills[skillName];
                    if (InstantSkill.status) {
                        this.bot.chat(`${skillName}を停止します`);
                        InstantSkill.status = false;
                        return;
                    }
                    const params = await this.bot.utils.getParams(this.bot, null, InstantSkill.params, args);
                    if (params.error) {
                        this.bot.chat(`${skillName} error: ${params.result}`);
                        return;
                    }
                    InstantSkill.status = true;
                    const response = await InstantSkill.run(...Object.values(params));
                    InstantSkill.status = false;
                    console.log(`${skillName} ${response.result}`);
                    if (response.error) {
                        this.bot.chat(`${skillName} error: ${response.result}`);
                    } else {
                        this.bot.chat(response.result);
                    }
                } catch (error) {
                        console.log(`${skillName} error: ${error}`);
                        this.bot.chat(`${skillName} error: ${error}`);
                }
                return;
            }
            if (message.startsWith("../")) {
                const skillName = message.slice(3);
                if (!this.bot.constantSkills[skillName]){
                    this.bot.chat(`${skillName}は存在しません`);
                    return;
                }
                this.bot.constantSkills[skillName].status = !this.bot.constantSkills[skillName].status;
                this.bot.chat(`常時スキル${skillName}のステータスを${this.bot.constantSkills[skillName].status ? "オン" : "オフ"}にしました`);
                return;
            }
            const data = { 
                "chat_sender_name": username, 
                "chat_message": message, 
                "bot_position": this.bot.entity.position, 
                "bot_health": `${this.bot.health}/20`,
                "bot_food_level": `${this.bot.food}/20`
            };
            const response = await this.bot.utils.postRequestToLLM.run(data, "chat");
            if (response.success) {
                this.bot.chat(response.result);
            } else {
                this.bot.chat(`error: ${response.result}`);
            }
        });
    }

    async entitySpawn() {
        console.log(`\x1b[32m✓ entitySpawn\x1b[0m`);
        this.bot.on('entitySpawn', async (entity) => {
            if (this.bot.constantSkills.autoPickUpItem.status) {
                try {
                    this.bot.constantSkills.autoPickUpItem.run(entity);
                } catch (error) {
                    console.error("エラーが発生しました:", error);
                }
            }
        });
    }

    async entityHurt() {
        console.log(`\x1b[32m✓ entityHurt\x1b[0m`);
        this.bot.on('entityHurt', async (entity) => {
            console.log(entity.name);
            if (entity === this.bot.entity) {
                this.bot.chat(`ダメージを受けました: ${entity.health} 残りの体力`);
            }
        });
    }

    async health() {
        console.log(`\x1b[32m✓ health\x1b[0m`);
        this.bot.on('health', async () => {
            if (!this.bot.constantSkills.autoEat.status) return;
            if (this.bot.constantSkills.autoEat.isLocked) return;
            try {
                await this.bot.constantSkills.autoEat.run();
            } catch (error) {
                console.error("エラーが発生しました:", error);
            }
        })
    }

    async entityMoved() {
        console.log(`\x1b[32m✓ entityMoved\x1b[0m`);
        this.bot.on('entityMoved', async (entity) => {
            if (entity.type !== "projectile") return;
            if (!this.bot.constantSkills.autoAvoidProjectile.status) return;
            if (this.bot.constantSkills.autoAvoidProjectile.isLocked) return;
            try {
                await this.bot.constantSkills.autoAvoidProjectile.run(entity);
            } catch (error) {
                console.error("エラーが発生しました:", error);
            }
        })
    }

    async startServer() {
        try {
            const initSkillsResponse = await this.initSkills();
            if (!initSkillsResponse.success) {
                return {"success": false, "result": initSkillsResponse.result};
            }
            await this.setInterval();
            await this.registerPost();
            const serverPort = 3250 + this.bot.isTest;
            this.app.listen(serverPort, () => {
                console.log(`minecraft_bot_server is running on port ${serverPort}`);
            });
            await this.botOnChat();
            await this.entitySpawn();
            await this.entityMoved();
            await this.entityHurt();
            await this.health();
            return {"success": true, "result": "server started"};
        } catch (error) {
            console.log(`error: ${error}`);
            return {"success": false, "result": error};
        }
    }
}

module.exports = SkillExecutor;