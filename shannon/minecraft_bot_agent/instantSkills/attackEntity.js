const InstantSkill = require('./instantSkill.js');
const HoldItem = require('./holdItem.js');

class AttackEntity extends InstantSkill {
    /**
     * @param {import('../types.js').CustomBot} bot
     */
    constructor(bot) {
        super(bot);
        this.skillName = "attack-entity";
        this.description = "指定したエンティティを攻撃します。";
        this.params = [
            {
                "name": "num",
                "type": "number",
                "description": "倒すエンティティの数を指定します。nullの場合は近くの全てのエンティティを倒します。",
                "default": null
            },
            {
                "name": "entityName",
                "type": "string",
                "description": "エンティティの名前を指定します。",
                "default": null
            },
            {
                "name": "toolName",
                "type": "string",
                "description": "倒すのに使用するツールの名前を指定します。nullの場合は自動でツールを取得します。",
                "default": null
            }
        ]
        this.entities = [];
        this.entities_length = 0;
        this.holdItem = new HoldItem(this.bot);
    }

    /**
     * @param {number} num
     * @param {string} entityName
     * @param {string} toolName
     */
    async run(num, entityName, toolName) {
        console.log("attackEntity:", num, entityName, toolName);
        try{
            if (toolName !== "null"){
                const response = await this.holdItem.run(toolName, "hand");
                if (!response.success) return response;
            }
            this.entities = await this.bot.utils.getNearestEntitiesByName(this.bot, entityName);
            this.entities_length = this.entities.length;
            if (num === "null") num = this.entities_length;
            this.bot.on('entityHurt', (entity) => {
                if (entity.health <= 0) {
                    num--;
                }
            });
            this.status = true;
            while (this.status && num > 0 && this.entities_length > 0) {
                const entity = this.entities[0];
                if (entity.name === 'creeper') {
                    await this.attackCreeper(entity, toolName);
                } else if (['skeleton', 'stray', 'blaze', 'ghast', 'witch', 'wither_skelton', 'pillager'].includes(entity.name)) {
                    await this.attackRangedEntity(entity, toolName);
                } else if (['zombified_piglin', 'enderman'].includes(entity.name)) {
                    await this.attackNormalEntity(entity, toolName);
                } else {
                    await this.attackNormalEntity(entity, toolName);
                }
                await new Promise(resolve => setTimeout(resolve, 500));
                this.entities = await this.bot.utils.getNearestEntitiesByName(this.bot, entityName);
                this.entities_length = this.entities.length;
            }   
            this.status = false;
            if(num === 0 || this.entities_length === 0) {
                return {"success": true, "result": "エンティティをやっつけました"};
            }else{
                return {"success": true, "result": "攻撃を終了します"};
            }
        }catch(error){
            return {"success": false, "result": `${error.message} in ${error.stack}`};
        }
    }

    async attackCreeper(entity, toolName) {
        const heldItem = await this.bot.utils.getHoldingItem.run("hand");
        if (toolName !== "null"){
            if (heldItem.result.includes("bow")){
                if (this.bot.entity.position.distanceTo(entity.position) < 8) {
                    await this.bot.utils.runFromEntities(this.bot, [entity], 16);
                }else{  
                    this.bot.hawkEye.oneShot(entity, heldItem.result);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }else{
                if (this.bot.entity.position.distanceTo(entity.position) < 4) {
                    await this.bot.utils.runFromEntities(this.bot, [entity], 8);
                }else{  
                    await this.attackEntityOnce(entity);
                }
            }
        }else{
            const axe = this.bot.inventory.items().find(item => item.name.includes("axe"));
            const sword = this.bot.inventory.items().find(item => item.name.includes("sword"));
            const bow = this.bot.inventory.items().find(item => item.name.includes("bow"));
            const arrow = this.bot.inventory.items().find(item => item.name.includes("arrow"));
            if (bow && arrow) {
                if (!heldItem.result.includes("bow")) await this.holdItem.run(bow.name, "hand");
                if (this.bot.entity.position.distanceTo(entity.position) < 8) {
                    await this.bot.utils.runFromEntities(this.bot, [entity], 16);
                }else{  
                    this.bot.hawkEye.oneShot(entity, bow.name);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }else{
                if (axe) {
                    if (!heldItem.result.includes("axe")) await this.holdItem.run(axe.name, "hand");
                }else if (sword) {
                    if (!heldItem.result.includes("sword")) await this.holdItem.run(sword.name, "hand");
                }
                if (this.bot.entity.position.distanceTo(entity.position) < 4) {
                    await this.bot.utils.runFromEntities(this.bot, [entity], 8);
                }else{  
                    await this.attackEntityOnce(entity);
                }
            }
        }
    }

    async attackRangedEntity(entity, toolName) {
        await this.bot.lookAt(entity.position.offset(0, entity.height * 0.85, 0));
        const distance = this.bot.entity.position.distanceTo(entity.position);
        const heldItem = await this.bot.utils.getHoldingItem.run("hand");
        if (toolName !== "null"){
            if (heldItem.result.includes("bow")){
                if (distance > 16) {
                    this.bot.hawkEye.oneShot(entity, heldItem.result);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } else if (distance <= 5) {
                    await this.attackEntityOnce(entity);
                }else{
                    await this.bot.utils.runFromEntities(this.bot, [entity], 16);
                }
            }else{
                await this.attackEntityOnce(entity);
            }
        }else{
            const axe = this.bot.inventory.items().find(item => item.name.includes("axe"));
            const sword = this.bot.inventory.items().find(item => item.name.includes("sword"));
            const bow = this.bot.inventory.items().find(item => item.name.includes("bow"));
            const arrow = this.bot.inventory.items().find(item => item.name.includes("arrow"));
            if (bow && arrow) {
                if (!heldItem.result.includes("bow")) await this.holdItem.run(bow.name, "hand");
                if (distance > 16) {
                    this.bot.hawkEye.oneShot(entity, bow.name);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } else if (distance <= 5) {
                    await this.attackEntityOnce(entity);
                }else{
                    await this.bot.utils.runFromEntities(this.bot, [entity], 16);
                }
            }else{
                if (axe) {
                    if (!heldItem.result.includes("axe")) await this.holdItem.run(axe.name, "hand");
                }else if (sword) {
                    if (!heldItem.result.includes("sword")) await this.holdItem.run(sword.name, "hand");
                }
                await this.attackEntityOnce(entity);
            }
        }
    }

    //通常の敵モブへの攻撃関数
    async attackNormalEntity(entity, toolName) {
        await this.bot.lookAt(entity.position.offset(0, entity.height * 0.85, 0));
        const distance = this.bot.entity.position.distanceTo(entity.position);
        const heldItem = await this.bot.utils.getHoldingItem.run("hand");
        if (toolName !== "null"){
            if (heldItem.result.includes("bow")){
                if (distance > 8) {
                    this.bot.hawkEye.oneShot(entity, heldItem.result);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } else if (distance <= 3) {
                    await this.attackEntityOnce(entity);
                }else{
                    await this.bot.utils.runFromEntities(this.bot, [entity], 8);
                }
            }else{
                await this.attackEntityOnce(entity);
            }
        }else{
            const axe = this.bot.inventory.items().find(item => item.name.includes("axe"));
            const sword = this.bot.inventory.items().find(item => item.name.includes("sword"));
            const bow = this.bot.inventory.items().find(item => item.name.includes("bow"));
            const arrow = this.bot.inventory.items().find(item => item.name.includes("arrow"));
            if (bow && arrow) {
                if (!heldItem.result.includes("bow")) await this.holdItem.run(bow.name, "hand");
                if (distance > 8) { 
                    this.bot.hawkEye.oneShot(entity, bow.name);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } else if (distance <= 5) {
                    await this.attackEntityOnce(entity);
                }else{
                    await this.bot.utils.runFromEntities(this.bot, [entity], 8);
                }
            }else{
                if (axe) {
                    if (!heldItem.result.includes("axe")) await this.holdItem.run(axe.name, "hand");
                }else if (sword) {
                    if (!heldItem.result.includes("sword")) await this.holdItem.run(sword.name, "hand");
                }
                await this.attackEntityOnce(entity);
            }
        }
    }

    async attackEntityOnce(entity) {
        await this.bot.lookAt(entity.position.offset(0, entity.height * 0.85, 0));
        const distance = this.bot.entity.position.distanceTo(entity.position);
        if (distance > 8) {
            await this.bot.utils.goalDistanceEntity.run(entity, 3);
        } else if (distance <= 4) {
            await this.bot.utils.goalDistanceEntity.run(entity, 8);
        }
        await this.bot.attack(entity);
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

module.exports = AttackEntity;
