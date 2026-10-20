import { actionDelay } from '../execution/observedWait.js';
import { potionIn } from '../utils/potionContents.js';
import minecraftData from 'minecraft-data';
import { CustomBot, InstantSkill } from '../types.js';

/** What is drunk rather than eaten: used the same way (held until it is gone), whatever the hunger bar says. */
const DRINKS = new Set(['potion', 'milk_bucket', 'ominous_bottle']);

/** Food the game lets be eaten at a full bar. */
const ALWAYS_EDIBLE = new Set(['golden_apple', 'enchanted_golden_apple', 'chorus_fruit']);

const CONSUMABLE_ITEMS = new Set([
  'apple', 'baked_potato', 'beef', 'beetroot', 'beetroot_soup', 'bread',
  'carrot', 'chicken', 'chorus_fruit', 'cod', 'cookie', 'cooked_beef',
  'cooked_chicken', 'cooked_cod', 'cooked_mutton', 'cooked_porkchop',
  'cooked_rabbit', 'cooked_salmon', 'dried_kelp', 'enchanted_golden_apple',
  'glow_berries', 'golden_apple', 'golden_carrot', 'honey_bottle',
  'melon_slice', 'mushroom_stew', 'mutton', 'poisonous_potato', 'porkchop',
  'potato', 'pufferfish', 'pumpkin_pie', 'rabbit', 'rabbit_stew',
  'rotten_flesh', 'salmon', 'spider_eye', 'steak', 'suspicious_stew',
  'sweet_berries', 'tropical_fish',
]);

/**
 * 原子的スキル: アイテムを使用（右クリック）
 */
class UseItem extends InstantSkill {
  private mcData: any;

  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'use-item';
    this.description = '指定したアイテムを装備して使用します（右クリック）。食べ物を食べる・ポーションを飲む場合にも使用します（満腹なら食べずに成功で返す。体の食事が先に食べている時はその終わりを待つ）。ender_eyeは投げて、目玉の飛んだ方位を測って返します（要塞の三角測量）。';
    this.mcData = minecraftData(this.bot.version);
    this.params = [
      {
        name: 'itemName',
        type: 'string',
        description: 'アイテム名（例: bread, apple, potion）。空の場合は手に持っているアイテムを使用',
        default: null,
      },
      {
        name: 'contents',
        type: 'string',
        description: 'ポーションの中身（例: fire_resistance）。持ち物の観測の contents と同じ名前。指定すると、その中身のポーションを選んで使う（省略時は最初に見つかったもの）',
        default: null,
      },
    ];
  }

  async runImpl(itemName: string | null = null, contents: string | null = null) {
    try {
      // アイテム名が指定されている場合、装備する
      if (itemName) {
        const wanted = contents ? String(contents).replace(/^minecraft:/, '').trim() : '';
        const inventoryItem = this.bot.inventory.items().find(
          (item) => item.name === itemName && (!wanted || potionIn(item as any) === wanted)
        );

        if (!inventoryItem) {
          const kinds = [...new Set(this.bot.inventory.items().filter((item) => item.name === itemName).map((item) => potionIn(item as any) ?? '中身なし'))];
          return {
            success: false,
            result: wanted && kinds.length ? `${itemName}はありますが、中身が${wanted}のものはありません（持っているのは: ${kinds.join('、')}）` : `インベントリに${itemName}がありません`,
            failureType: 'missing_item', recoverable: true,
          };
        }

        // Full: the item is not even taken into the hand (the hand may hold the tool the next step needs).
        if (CONSUMABLE_ITEMS.has(itemName) && !ALWAYS_EDIBLE.has(itemName) && this.bot.food >= 20 && !(this.bot as any).usingHeldItem) return this.notHungry(itemName);
        await this.bot.equip(inventoryItem, 'hand');
      }

      const heldItem = this.bot.heldItem;

      if (!heldItem) {
        return {
          success: false,
          result: '手に何も持っていません',
        };
      }

      // アイテムが使用可能かチェック
      const item = this.mcData.itemsByName[heldItem.name];
      if (!item) {
        return {
          success: false,
          result: `${heldItem.name}は使用できません`,
        };
      }

      // activateItem() は「使用開始」だけで即時に戻る。食料はサーバーが
      // 消費を確定するまで押し続ける必要があるため consume() を使う。
      if (CONSUMABLE_ITEMS.has(heldItem.name)) {
        return await this.eat(heldItem.name);
      } else if (DRINKS.has(heldItem.name)) {
        // A drink is held to the lips until it is gone, like food: begun and let go at once, the potion stayed
        // in the hand and nothing came of it (lab: "used", no effect, the bottle still full).
        const name = heldItem.name;
        const contents = potionIn(heldItem as any);
        const label = contents ? `${name}（${contents}）` : name;
        const count = () => this.bot.inventory.items().filter((entry) => entry.name === name).reduce((sum, entry) => sum + entry.count, 0);
        const before = count();
        let failure: string | null = null;
        try { await this.bot.consume(); } catch (error: any) { failure = String(error?.message ?? error); }
        // The pack is told of the empty bottle a moment after the drinking is done.
        for (const deadline = Date.now() + 1500; Date.now() < deadline && count() >= before;) await actionDelay(this.bot, 100);
        if (count() >= before) {
          return { success: false, result: `${label}を飲めませんでした（${failure ?? '所持数が変わっていません'}）`, failureType: 'not_consumed', recoverable: true };
        }
        await actionDelay(this.bot, 300);
        const effects = Object.values((this.bot.entity as any)?.effects ?? {}).map((effect: any) =>
          `${String((this.bot as any).registry?.effects?.[effect.id]?.name ?? `effect_${effect.id}`)}（残り約${Math.round((effect.duration ?? 0) / 20)}秒）`);
        return { success: true, result: `${label}を飲みました。いま付いている効果: ${effects.length ? effects.join('、') : 'なし'}` };
      } else if (heldItem.name === 'splash_potion' || heldItem.name === 'lingering_potion') {
        // Thrown where the body looks: at its own feet, so that what it is a potion of lands on the body.
        const contents = potionIn(heldItem as any);
        await this.bot.look(this.bot.entity.yaw, -Math.PI / 2, true);
        await this.bot.activateItem();
        await actionDelay(this.bot, 900);
        const effects = Object.values((this.bot.entity as any)?.effects ?? {}).map((effect: any) =>
          `${String((this.bot as any).registry?.effects?.[effect.id]?.name ?? `effect_${effect.id}`)}（残り約${Math.round((effect.duration ?? 0) / 20)}秒）`);
        return { success: true, result: `${heldItem.name}${contents ? `（${contents}）` : ''}を足元に投げました。いま付いている効果: ${effects.length ? effects.join('、') : 'なし'}` };
      } else if (heldItem.name === 'ender_eye') {
        return await this.throwEnderEye();
      } else {
        await this.bot.activateItem();
      }

      return {
        success: true,
        result: `${heldItem.name}を使用しました`,
      };
    } catch (error: any) {
      return {
        success: false,
        result: `アイテム使用エラー: ${error.message}`,
      };
    }
  }

  /** How long the pack and the hunger bar are given to show a meal; the server tells of both a moment after the chewing ends. */
  private settleMs = 2500;

  /** Full: nothing is eaten, and that is no failure (a procedure's upkeep that fails once is not tried again in the run). */
  private notHungry(name: string) {
    return { success: true, result: `満腹度 ${this.bot.food}/20のため${name}は食べませんでした（食べる必要はありません。手順はこのまま続けてよい）` };
  }

  /**
   * Eating, judged by what the pack and the hunger bar say afterwards (the library's own answer is a wait for one packet).
   * - A meal already under way (the floor's eating reflex, auto-eat) is waited for, not cut by a second consume(): the library keeps one
   *   meal task, so a second call cancels the first caller's wait ("Consuming cancelled due to calling bot.consume() again"). That is how
   *   a meal begun by the body and one begun by the procedure ended as "could not eat" at food 12 (run 20, +663 s).
   * - Whoever cancelled whose wait, the chewing goes on in the server: the pack and the bar are given a moment to show it.
   * - Full needs no meal; that is said as such, not as a failure.
   * - Taken out of the hand, or cut by a reflex: said so, with `interrupted_by_reflex`, so the procedure tries again once.
   */
  private async eat(name: string) {
    const bot = this.bot as any;
    const count = () => this.bot.inventory.items().filter((entry) => entry.name === name).reduce((sum, entry) => sum + entry.count, 0);
    const interrupted = () => ({ success: false, failureType: 'interrupted', recoverable: true, result: `${name}を食べている途中で中断されました（満腹度 ${bot.food}/20）` });
    try {
      const startFood = bot.food as number;
      if (bot.usingHeldItem) {
        for (const until = Date.now() + 3000; Date.now() < until && bot.usingHeldItem;) await actionDelay(this.bot, 100);
        await actionDelay(this.bot, 200);
        if (bot.food > startFood && bot.food >= 18 && !ALWAYS_EDIBLE.has(name)) {
          return { success: true, result: `${name}は、体の食事（反射・自動の食事）が先に食べ終えたので、追加では食べませんでした（満腹度 ${startFood}→${bot.food}/20、残り${count()}個）` };
        }
      }
      if (bot.food >= 20 && !ALWAYS_EDIBLE.has(name)) return this.notHungry(name);
      if (this.bot.heldItem?.name !== name) {
        const again = this.bot.inventory.items().find((entry) => entry.name === name);
        if (!again) return { success: false, result: `インベントリに${name}がありません`, failureType: 'missing_item', recoverable: true };
        await this.bot.equip(again, 'hand');
      }
      const before = { count: count(), food: bot.food as number };
      let failure: string | null = null, attempts = 0;
      let changed = false;
      while (attempts < 2 && !changed) {
        attempts++;
        failure = null;
        try { await bot.consume(); } catch (error: any) { failure = String(error?.message ?? error); }
        if (this.shouldInterrupt()) return interrupted();
        changed = await this.mealShown(count, before);
        if (changed || this.bot.heldItem?.name !== name || (bot.food >= 20 && !ALWAYS_EDIBLE.has(name))) break;
      }
      if (changed) {
        const rose = bot.food > before.food || before.food >= 20;
        return { success: true, result: `${name}を食べました（満腹度 ${before.food}→${bot.food}/20、残り${count()}個）${rose ? '' : '。満腹度は上がっていません（すでに満腹に近いか、先に別の食事で上がっていた）'}` };
      }
      const held = this.bot.heldItem?.name;
      if (held !== name) {
        return { success: false, failureType: 'interrupted_by_reflex', recoverable: true,
          result: `${name}を食べている途中で手持ちが${held ?? 'なし'}に変わりました（戦闘や逃走などの体の反射が持ち替えて、食事が中断されました）。反射が終わってから、もう一度食べてください（満腹度 ${bot.food}/20）` };
      }
      if (bot.food >= 20 && !ALWAYS_EDIBLE.has(name)) return this.notHungry(name);
      if (failure && /cancelled due to calling bot\.consume/u.test(failure)) {
        return { success: false, failureType: 'interrupted_by_reflex', recoverable: true,
          result: `${name}を食べている途中で、体の別の食事（反射・自動の食事）が割り込んで中断されました（満腹度 ${bot.food}/20、残り${count()}個）。少し待ってから、満腹度を見てもう一度食べてください` };
      }
      return { success: false, failureType: 'not_consumed', recoverable: true,
        result: `${name}を食べられませんでした（${failure ?? '所持数も満腹度も変わっていません'}。満腹度 ${bot.food}/20、手持ち ${held}、食事中=${bot.usingHeldItem ? 'はい' : 'いいえ'}、${attempts}回試しました）` };
    } catch (error: any) {
      if (this.shouldInterrupt() || /Action interrupted/u.test(String(error?.message))) return interrupted();
      throw error;
    }
  }

  /** The pack has lost one, or the bar has risen: within settleMs, longer while the server is still chewing; a lost one without a rise is waited on for 0.7 s. */
  private async mealShown(count: () => number, before: { count: number; food: number }): Promise<boolean> {
    const bot = this.bot as any;
    const started = Date.now();
    let droppedAt = 0;
    for (;;) {
      const dropped = count() < before.count;
      if (bot.food > before.food) return true;
      if (dropped) { droppedAt ||= Date.now(); if (Date.now() - droppedAt >= 700) return true; }
      const elapsed = Date.now() - started;
      if (elapsed >= this.settleMs && !(bot.usingHeldItem && elapsed < this.settleMs + 1500)) return dropped;
      await actionDelay(this.bot, 100);
    }
  }

  /**
   * The thrown eye flies toward the nearest stronghold: its course, read over about a second of flight, is one line of
   * a triangulation. Two throws some hundreds of blocks apart cross near the stronghold; the crossing is worked out
   * by whoever reads the two results, not here.
   */
  private async throwEnderEye() {
    const eyes = () => Object.values(this.bot.entities).filter((entity: any) =>
      entity?.name === 'eye_of_ender' && entity.position?.distanceTo(this.bot.entity.position) < 6);
    const before = new Set(eyes().map((entity: any) => entity.id));
    const from = this.bot.entity.position.floored();
    await this.bot.activateItem();
    let eye: any = null;
    // Up to two seconds for the server's word of the eye: under lag a thrown eye was answered "not thrown".
    for (const deadline = Date.now() + 2000; !eye && Date.now() < deadline;) {
      await actionDelay(this.bot, 50);
      eye = eyes().find((entity: any) => !before.has(entity.id)) ?? null;
    }
    // No eye leaves the hand where there is no stronghold to lead to (the Nether, the End), or when the look is on a frame.
    if (!eye) return { success: false, result: 'エンダーアイは飛びませんでした（要塞の無い次元にいるか、エンドポータルの枠を見ています）', failureType: 'eye_not_thrown', recoverable: true };
    const start = eye.position.clone();
    let end = start;
    for (const deadline = Date.now() + 1000; Date.now() < deadline && this.bot.entities[eye.id];) {
      await actionDelay(this.bot, 50);
      if (this.bot.entities[eye.id]) end = this.bot.entities[eye.id].position.clone();
    }
    const dx = end.x - start.x, dy = end.y - start.y, dz = end.z - start.z, flat = Math.hypot(dx, dz);
    if (flat < 0.3) return { success: true, result: `エンダーアイを${from.x}, ${from.y}, ${from.z}で投げましたが、目玉は横にほとんど動かず、向きは読めませんでした（真上なら要塞はほぼ真下です）` };
    // North (−z) is 0° and east (+x) is 90°, the way a map is read.
    const bearing = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;
    const elevation = Math.atan2(dy, flat) * 180 / Math.PI;
    const compass = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'][Math.round(bearing / 45) % 8];
    return { success: true, result: `エンダーアイを(${from.x}, ${from.y}, ${from.z})で投げました。目玉は方位${bearing.toFixed(1)}°（北=0°、東=90°。${compass}）、`
      + `仰角${elevation.toFixed(0)}°へ飛びました（水平の向き x=${(dx / flat).toFixed(3)}, z=${(dz / flat).toFixed(3)}）。`
      + '数百ブロック離れた2地点で投げた線の交わる所が要塞の目安です。目玉は数秒後に落ちる（拾える）か、割れて消えます' };
  }
}

export default UseItem;
