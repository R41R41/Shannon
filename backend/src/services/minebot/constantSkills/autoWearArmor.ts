import { createLogger } from '../../../utils/logger.js';
import { ConstantSkill, CustomBot } from '../types.js';
import { activeActionCapabilities } from '../execution/ActionExecution.js';
import { skillCategory } from '../execution/SkillExecutor.js';

const log = createLogger('Minebot:Skill:autoWearArmor');

/** The body's places for armour, and the ending of the item that goes in each. */
const PLACES: Array<{ destination: 'head' | 'torso' | 'legs' | 'feet' | 'off-hand'; ending: string }> = [
  { destination: 'head', ending: '_helmet' }, { destination: 'torso', ending: '_chestplate' },
  { destination: 'legs', ending: '_leggings' }, { destination: 'feet', ending: '_boots' },
  // A shield is worn on the arm: in the off hand it is there to be raised (see utils/shieldBlock).
  { destination: 'off-hand', ending: 'shield' },
];
/** Weakest first: of two pieces carried for an empty place, the later one is put on. */
const MATERIALS = ['leather', 'golden', 'chainmail', 'turtle', 'iron', 'diamond', 'netherite'];

/** The piece to put on in each empty place: the best carried. A place already filled is left as it is. */
export function armourToWear(worn: Record<string, string | null | undefined>, carried: string[]): Array<{ destination: string; name: string }> {
  const wear: Array<{ destination: string; name: string }> = [];
  for (const place of PLACES) {
    if (worn[place.destination]) continue;
    const pieces = carried.filter(name => name.endsWith(place.ending))
      .sort((a, b) => MATERIALS.indexOf(b.slice(0, -place.ending.length)) - MATERIALS.indexOf(a.slice(0, -place.ending.length)));
    if (pieces[0]) wear.push({ destination: place.destination, name: pieces[0] });
  }
  return wear;
}

/**
 * Armour carried is armour worn.
 *
 * Putting armour on was left to the planner, as one more tool call among its others. It made an iron chestplate
 * and carried it: a body restored with one in its pack took sixteen minutes of arrows and fireballs before the
 * planner put it on (paid run L77k), and every run before it had gone through the same stretch bare. A person
 * does not decide to wear the armour they have just made. This is that habit: an empty place gets the best
 * piece carried for it. What is already worn is left alone, so a piece the planner chose to wear (gold among
 * piglins) stays.
 *
 * It does not ask for the body. A constant skill waits for the body to be free, and a planner that has just
 * arrived somewhere walks on at once: the armour would stay in the pack for the whole walk into the fortress
 * (lab continuation L77m). Putting armour on needs no legs and no look, so it is done while walking as well.
 * What it must not cross is another use of the pack: it holds off while a window is open or anything but
 * walking is running, and every equip of the body, this one and the skills', goes through one queue.
 */
class AutoWearArmor extends ConstantSkill {
  constructor(bot: CustomBot) {
    super(bot);
    this.skillName = 'auto-wear-armor';
    this.description = '持っている防具を、空いている部位に自動で身に着ける';
    this.interval = 5000;
    this.priority = 3;
    this.status = true;
    this.containMovement = false;
    this.isCritical = false;
    // And as soon as something new is in the pack, not only on the five-second round: a body that has just
    // picked up or made a piece is seconds from the next arrow.
    try {
      (this.rootBot as any).inventory?.on?.('updateSlot', () => {
        if (this.pending || !this.status) return;
        this.pending = setTimeout(() => { this.pending = null; void this.run(); }, 400);
        this.pending.unref?.();
      });
    } catch { /* a body without a pack to listen to */ }
  }

  private pending: NodeJS.Timeout | null = null;

  /** One equip at a time for the whole body: two running together leave an item on the cursor. */
  private queueEquips(): void {
    const bot = this.rootBot as any;
    if (bot.equipQueued || typeof bot.equip !== 'function') return;
    bot.equipQueued = true;
    const equip = bot.equip.bind(bot);
    let last: Promise<unknown> = Promise.resolve();
    bot.equip = (...args: unknown[]) => {
      const run = last.then(() => equip(...args));
      last = run.catch(() => undefined);
      return run;
    };
  }

  /**
   * Run when asked, not from the queue of constant skills: that queue hands out the body one skill at a time,
   * and behind the ones that run ten times a second this one waited a minute and a half (lab continuations
   * L77m, L77n). It takes nothing from anyone (see `run`).
   */
  protected shouldPreempt(): boolean { return true; }

  /** Not through the executor: see above. */
  async run(): Promise<void> {
    if (this.isLocked) return;
    this.isLocked = true;
    try { await this.runImpl(); } catch { /* a habit, never in the way */ } finally { this.isLocked = false; }
  }

  async runImpl() {
    this.queueEquips();
    // Not with a chest or a workbench open: the clicks would land in that window. And not across a craft, a
    // fight or a dig, which use the pack and the hands themselves.
    if ((this.bot as any).currentWindow) return;
    if (activeActionCapabilities(this.rootBot).some(name => !['query', 'movement'].includes(skillCategory(name)))) return;
    const worn: Record<string, string | null> = {};
    for (const place of PLACES) worn[place.destination] = this.bot.inventory.slots[this.bot.getEquipmentDestSlot(place.destination)]?.name ?? null;
    const items = this.bot.inventory.items();
    for (const piece of armourToWear(worn, items.map(item => item.name))) {
      const item = items.find(entry => entry.name === piece.name);
      if (!item) continue;
      try {
        await this.bot.equip(item, piece.destination as any);
        log.info(`🛡 ${piece.name} を身に着けた`);
      } catch (error) {
        log.warn(`防具を身に着けられない (${piece.name}): ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
  }
}

export default AutoWearArmor;
