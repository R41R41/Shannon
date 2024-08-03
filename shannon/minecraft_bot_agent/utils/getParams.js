const getChatResponse = require('./getChatResponse');
const { Vec3 } = require('vec3');

/**
 * @param {import('../types').CustomBot} bot
 * @param {object} data
 * @param {object[]} params
 * @param {string[]} args
 */
module.exports = async function getParams(bot, data, params, args) {
    const result = {};
    if (data == null) {
        for (const param of params) {
            let response;
            if(args.length > 0){
                response = args[0];
                args.shift();
            }else{
                response = await getChatResponse(bot, `${param.name}: ${param.type}の値を教えてください`);
            }
            if (response == "default") {
                result[param.name] = param.default;
            } else {
                const parsedValue = convertType(response, param.type);
                if (parsedValue.error) {
                    bot.chat(parsedValue.result);
                    return {"error": true, "result": parsedValue.result};
                }
                result[param.name] = parsedValue;
            }
        }
        return result;
    }
    if (data.length == 0) {
        return {"error": true, "result": "data is empty"};
    }
    for (const param of params) {
        if (data[param.name]) {
            const parsedValue = convertType(data[param.name], param.type);
            if (parsedValue.error) {
                bot.chat(parsedValue.result);
                return {"error": true, "result": parsedValue.result};
            }
            result[param.name] = parsedValue;
        } else {
            result[param.name] = param.default;
        }
    }
    return result;
}

/**
 * 指定された型に変換する関数
 * @param {string} value
 * @param {string} type
 * @returns {any}
 */
function convertType(value, type) {
    if (value == null || value == "null" || value == "none") {
        return "null";
    }
    switch (type) {
        case 'number':
            const parsedNumber = parseFloat(value);
            if (isNaN(parsedNumber)) {
            return {"error": true, "result": `${value}は無効な${type}です`};
            }
            return parsedNumber;
        case 'boolean':
            if (value.toLowerCase() === 'true') {
                return true;
            } else if (value.toLowerCase() === 'false') {
                return false;
            } else {
                return {"error": true, "result": `${value}は無効な${type}です`};
            }   
        case 'string':
            return value;
        case 'vec3':
            const vec3 = value.split(',');
            return new Vec3(Number(vec3[0]), Number(vec3[1]), Number(vec3[2]));
        default:
            return value;
    }
}