import { Vec3 } from 'vec3';
import { CustomBot, Param } from '../types.js';
import { getChatResponse } from './getChatResponse.js';

export async function getParams(
  bot: CustomBot,
  params: Param[]
): Promise<{ success: boolean; result: Record<string, unknown> | string }> {
  const result: Record<string, unknown> = {};
  for (const param of params) {
    let response: string;
    response = await getChatResponse(
      bot,
      `${param.name}（型：${param.type}）の値を教えてください`
    );
    if (response == '.') {
      bot.chat('キャンセルしました');
      return { success: false, result: 'キャンセル' };
    }
    if (response == 'default') {
      result[param.name] = param.default;
    } else {
      const parsedValue = convertType(response, param.type);
      if (parsedValue.result !== null && parsedValue.error) {
        return { success: false, result: 'エラーが発生しました' };
      }
      result[param.name] = parsedValue.result;
    }
  }
  return { success: true, result };
}

/**
 * 指定された型に変換する関数
 * @param {string} value
 * @param {string} type
 * @returns {any}
 */
function convertType(
  value: string,
  type: string
): { error: boolean; result: number | boolean | Vec3 | string | null } {
  if (value == null || value === 'null' || value === 'none') {
    return { error: true, result: null };
  }
  switch (type) {
    case 'number':
      const parsedNumber = parseFloat(value);
      if (isNaN(parsedNumber)) {
        return { error: true, result: `${value}は無効な${type}です` };
      }
      return { error: false, result: parsedNumber };
    case 'boolean':
      const boolStr = String(value).toLowerCase();
      if (boolStr === 'true') {
        return { error: false, result: true };
      } else if (boolStr === 'false') {
        return { error: false, result: false };
      } else {
        return { error: true, result: `${value}は無効な${type}です` };
      }
    case 'string':
      return { error: false, result: String(value) };
    case 'Vec3':
      const vec3 = String(value).split(',');
      return {
        error: false,
        result: new Vec3(Number(vec3[0]), Number(vec3[1]), Number(vec3[2])),
      };
    default:
      return { error: false, result: value };
  }
}
