const ConstantSkill = require('./constantSkill.js');
const EatFood = require('../instantSkills/eatFood.js');

class AutoEat extends ConstantSkill{
    constructor(bot){
        super(bot);
        this.skillName = "autoEat";
        this.description = "自動で食べる";
        this.isLocked = false;
        this.eatFood = new EatFood(this.bot);
        this.bannedFood = [
            this.bot.registry.foodsByName['pufferfish'].id,
            this.bot.registry.foodsByName['spider_eye'].id,
            this.bot.registry.foodsByName['poisonous_potato'].id,
            this.bot.registry.foodsByName['rotten_flesh'].id,
            this.bot.registry.foodsByName['chorus_fruit'].id,
            this.bot.registry.foodsByName['chicken'].id,
            this.bot.registry.foodsByName['suspicious_stew'].id,
            this.bot.registry.foodsByName['golden_apple'].id
        ]
    }

    async run(){
        if(this.bot.food < 20){
            this.lock();
            console.log("food is not enough");
            const food = this.bot.registry.foodsByName;
            const bestChoices = this.bot.inventory.items().filter((item) => item.name in food).filter((item) => !this.bannedFood.includes(item.id));
            const foodItem = bestChoices[0];
            if(foodItem){
                await this.eatFood.run(foodItem.name);
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
            this.unlock();
        }
    }
}

module.exports = AutoEat;