import { randomUUID } from 'node:crypto';

const SCORE_OBJECTIVE = 'sh_test';
// A freshly generated isolated world can spend several seconds processing
// chunk/entity updates. Treat that as slow infrastructure, not a missing
// command marker. Individual assertions remain bounded.
const DEFAULT_TIMEOUT_MS = 10_000;
// A setup transaction emits the command and a tellraw marker back-to-back.
// Without pacing between transactions, a normal fixture can exceed the
// vanilla server's chat-spam limit and disconnect the test bot.
const COMMAND_BURST_COOLDOWN_MS = 250;

export type MinecraftCommandAssertion =
  | { type: 'inventory_count'; item: string; minCount: number; maxCount?: number }
  | { type: 'health_between'; min: number; max: number }
  | { type: 'food_between'; min: number; max: number }
  | { type: 'position_y_between'; min: number; max: number }
  | { type: 'position_within'; x: number; y: number; z: number; radius: number }
  | { type: 'block_at'; x: number; y: number; z: number; block: string; state?: Record<string, string | number | boolean> }
  | { type: 'equipped_item'; slot: 'mainhand' | 'offhand' | 'head' | 'chest' | 'legs' | 'feet'; item: string }
  | { type: 'entity_nearby'; entity: string; maxDistance: number; present?: boolean }
  | { type: 'entity_count'; entity: string; tag?: string; x: number; y: number; z: number; radius: number; minCount: number; maxCount?: number }
  | { type: 'dimension'; dimension: string }
  | { type: 'gamemode'; gamemode: 'survival' | 'creative' | 'adventure' | 'spectator' }
  | { type: 'gamerule'; rule: string; value: boolean | number }
  | { type: 'difficulty'; difficulty: 'peaceful' | 'easy' | 'normal' | 'hard' };

export interface MinecraftCommandAssertionResult {
  assertion: MinecraftCommandAssertion;
  passed: boolean;
  durationMs: number;
  error: string | null;
}

interface CommandBotLike {
  version?: string;
  chat(message: string): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  removeListener(event: 'message', listener: (message: unknown) => void): unknown;
}

interface PreparedAssertion {
  prepare: string[];
  positive: string;
  negative: string;
}

/**
 * Server-authoritative test oracle.
 *
 * Assertions are converted to `/execute` predicates and reported back through
 * unique `tellraw` markers. This means a skill's own success flag is never the
 * sole evidence for a test pass.
 */
export class MinecraftCommandOracle {
  private initialized = false;

  constructor(
    private readonly bot: CommandBotLike,
    private readonly timeoutMilliseconds: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async verifyReady(): Promise<void> {
    await this.barrier();
  }

  async executeSetupCommand(command: string): Promise<void> {
    const normalized = normalizeVersionedCommand(command, this.bot.version);
    const marker = markerText('SETUP');
    await this.waitForMarker(marker, () => {
      this.bot.chat(`/${normalized}`);
      this.bot.chat(tellraw(marker));
    });
    await delay(COMMAND_BURST_COOLDOWN_MS);
  }

  async evaluateAll(assertions: MinecraftCommandAssertion[]): Promise<MinecraftCommandAssertionResult[]> {
    const results: MinecraftCommandAssertionResult[] = [];
    for (const assertion of assertions) results.push(await this.evaluate(assertion));
    return results;
  }

  async evaluate(assertion: MinecraftCommandAssertion): Promise<MinecraftCommandAssertionResult> {
    const startedAt = Date.now();
    try {
      const prepared = prepareAssertion(assertion);
      if (prepared.prepare.length > 0) {
        await this.ensureScoreObjective();
        // Invalid queries must not reuse a previous assertion's score (often
        // zero, which could falsely prove absence or a disabled gamerule).
        await this.executeSetupCommand(`scoreboard players set @s ${SCORE_OBJECTIVE} -2147483648`);
      }
      for (const command of prepared.prepare) await this.executeSetupCommand(command);

      const passMarker = markerText('PASS');
      const failMarker = markerText('FAIL');
      const outcome = await this.waitForEitherMarker(assertion.type, passMarker, failMarker, () => {
        this.bot.chat(`/execute ${prepared.positive} run ${tellrawCommand(passMarker)}`);
        this.bot.chat(`/execute ${prepared.negative} run ${tellrawCommand(failMarker)}`);
      });
      await delay(COMMAND_BURST_COOLDOWN_MS);
      return {
        assertion: structuredClone(assertion),
        passed: outcome === 'pass',
        durationMs: Date.now() - startedAt,
        error: null,
      };
    } catch (error) {
      return {
        assertion: structuredClone(assertion),
        passed: false,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async ensureScoreObjective(): Promise<void> {
    if (this.initialized) return;
    // Adding an existing objective reports an error, but the following barrier
    // still proves that commands are authorized and processed in order.
    await this.executeSetupCommand(`scoreboard objectives add ${SCORE_OBJECTIVE} dummy`);
    this.initialized = true;
  }

  private async barrier(): Promise<void> {
    const marker = markerText('READY');
    await this.waitForMarker(marker, () => this.bot.chat(tellraw(marker)));
  }

  private waitForMarker(marker: string, send: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const listener = (message: unknown) => {
        if (!messageText(message).includes(marker)) return;
        clearTimeout(timer);
        this.bot.removeListener('message', listener);
        resolve();
      };
      timer = setTimeout(() => {
        this.bot.removeListener('message', listener);
        reject(new Error(`MINECRAFT_COMMAND_MARKER_TIMEOUT:${marker.split(':')[1]}`));
      }, this.timeoutMilliseconds);
      this.bot.on('message', listener);
      send();
    });
  }

  private waitForEitherMarker(
    assertionType: MinecraftCommandAssertion['type'],
    passMarker: string,
    failMarker: string,
    send: () => void,
  ): Promise<'pass' | 'fail'> {
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const listener = (message: unknown) => {
        const text = messageText(message);
        const outcome = text.includes(passMarker) ? 'pass' : text.includes(failMarker) ? 'fail' : null;
        if (!outcome) return;
        clearTimeout(timer);
        this.bot.removeListener('message', listener);
        resolve(outcome);
      };
      timer = setTimeout(() => {
        this.bot.removeListener('message', listener);
        reject(new Error(`MINECRAFT_COMMAND_ASSERTION_TIMEOUT:${assertionType}`));
      }, this.timeoutMilliseconds);
      this.bot.on('message', listener);
      send();
    });
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export function prepareAssertion(assertion: MinecraftCommandAssertion): PreparedAssertion {
  switch (assertion.type) {
    case 'inventory_count': {
      const item = resourceLocation(assertion.item);
      const min = nonNegativeInteger(assertion.minCount, 'minCount');
      const max = assertion.maxCount === undefined
        ? null
        : nonNegativeInteger(assertion.maxCount, 'maxCount');
      if (max !== null && max < min) throw new Error('ASSERTION_RANGE_INVALID');
      const range = `${min}..${max ?? ''}`;
      return {
        prepare: [`execute store result score @s ${SCORE_OBJECTIVE} run clear @s ${item} 0`],
        positive: `if score @s ${SCORE_OBJECTIVE} matches ${range}`,
        negative: `unless score @s ${SCORE_OBJECTIVE} matches ${range}`,
      };
    }
    case 'health_between': {
      const min = scaled(assertion.min, 100, 'min');
      const max = scaled(assertion.max, 100, 'max');
      if (max < min) throw new Error('ASSERTION_RANGE_INVALID');
      return {
        prepare: [`execute store result score @s ${SCORE_OBJECTIVE} run data get entity @s Health 100`],
        positive: `if score @s ${SCORE_OBJECTIVE} matches ${min}..${max}`,
        negative: `unless score @s ${SCORE_OBJECTIVE} matches ${min}..${max}`,
      };
    }
    case 'food_between': {
      const min = nonNegativeInteger(assertion.min, 'min');
      const max = nonNegativeInteger(assertion.max, 'max');
      if (max < min) throw new Error('ASSERTION_RANGE_INVALID');
      return {
        prepare: [`execute store result score @s ${SCORE_OBJECTIVE} run data get entity @s foodLevel`],
        positive: `if score @s ${SCORE_OBJECTIVE} matches ${min}..${max}`,
        negative: `unless score @s ${SCORE_OBJECTIVE} matches ${min}..${max}`,
      };
    }
    case 'position_y_between': {
      const min = Math.round(finite(assertion.min, 'min') * 100);
      const max = Math.round(finite(assertion.max, 'max') * 100);
      if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min)
        throw new Error('ASSERTION_RANGE_INVALID');
      return {
        prepare: [`execute store result score @s ${SCORE_OBJECTIVE} run data get entity @s Pos[1] 100`],
        positive: `if score @s ${SCORE_OBJECTIVE} matches ${min}..${max}`,
        negative: `unless score @s ${SCORE_OBJECTIVE} matches ${min}..${max}`,
      };
    }
    case 'position_within': {
      const x = finite(assertion.x, 'x');
      const y = finite(assertion.y, 'y');
      const z = finite(assertion.z, 'z');
      const radius = finite(assertion.radius, 'radius');
      if (radius < 0) throw new Error('ASSERTION_RADIUS_INVALID');
      const predicate = `positioned ${x} ${y} ${z} if entity @s[distance=..${radius}]`;
      const inverse = `positioned ${x} ${y} ${z} unless entity @s[distance=..${radius}]`;
      return { prepare: [], positive: predicate, negative: inverse };
    }
    case 'block_at': {
      const x = integer(assertion.x, 'x');
      const y = integer(assertion.y, 'y');
      const z = integer(assertion.z, 'z');
      let block = resourceLocation(assertion.block);
      if (assertion.state) {
        const states = Object.entries(assertion.state).map(([key, value]) => {
          if (!/^[a-z0-9_]+$/.test(key) || !/^[a-z0-9_-]+$/.test(String(value))) throw new Error('BLOCK_STATE_INVALID');
          return `${key}=${value}`;
        });
        if (states.length) block += `[${states.join(',')}]`;
      }
      return {
        prepare: [],
        positive: `if block ${x} ${y} ${z} ${block}`,
        negative: `unless block ${x} ${y} ${z} ${block}`,
      };
    }
    case 'equipped_item': {
      const item = resourceLocation(assertion.item);
      const slotMap = {
        mainhand: 'weapon.mainhand',
        offhand: 'weapon.offhand',
        head: 'armor.head',
        chest: 'armor.chest',
        legs: 'armor.legs',
        feet: 'armor.feet',
      } as const;
      const slot = slotMap[assertion.slot];
      return {
        prepare: [],
        positive: `if items entity @s ${slot} ${item}`,
        negative: `unless items entity @s ${slot} ${item}`,
      };
    }
    case 'entity_nearby': {
      const entity = resourceLocation(assertion.entity);
      const distance = finite(assertion.maxDistance, 'maxDistance');
      if (distance < 0) throw new Error('ASSERTION_RADIUS_INVALID');
      const exists = `at @s if entity @e[type=${entity},distance=..${distance},limit=1]`;
      const absent = `at @s unless entity @e[type=${entity},distance=..${distance},limit=1]`;
      return assertion.present === false
        ? { prepare: [], positive: absent, negative: exists }
        : { prepare: [], positive: exists, negative: absent };
    }
    case 'dimension': {
      const dimension = resourceLocation(assertion.dimension);
      return {
        prepare: [],
        positive: `if dimension ${dimension}`,
        negative: `unless dimension ${dimension}`,
      };
    }
    case 'entity_count': {
      const entity = resourceLocation(assertion.entity);
      const x = finite(assertion.x, 'x');
      const y = finite(assertion.y, 'y');
      const z = finite(assertion.z, 'z');
      const radius = finite(assertion.radius, 'radius');
      if (radius < 0) throw new Error('ASSERTION_RADIUS_INVALID');
      const min = nonNegativeInteger(assertion.minCount, 'minCount');
      const max = assertion.maxCount === undefined ? '' : nonNegativeInteger(assertion.maxCount, 'maxCount');
      if (max !== '' && max < min) throw new Error('ASSERTION_RANGE_INVALID');
      if (assertion.tag !== undefined && !/^[a-zA-Z0-9_]+$/.test(assertion.tag)) throw new Error('ENTITY_TAG_INVALID');
      const tag = assertion.tag === undefined ? '' : `,tag=${assertion.tag}`;
      const selector = `@e[type=${entity},x=${x},y=${y},z=${z},distance=..${radius}${tag}]`;
      return {
        prepare: [`execute store result score @s ${SCORE_OBJECTIVE} run execute if entity ${selector}`],
        positive: `if score @s ${SCORE_OBJECTIVE} matches ${min}..${max}`,
        negative: `unless score @s ${SCORE_OBJECTIVE} matches ${min}..${max}`,
      };
    }
    case 'gamemode':
      return {
        prepare: [],
        positive: `if entity @s[gamemode=${assertion.gamemode}]`,
        negative: `unless entity @s[gamemode=${assertion.gamemode}]`,
      };
    case 'gamerule': {
      const rule = resourceLocation(assertion.rule);
      const value = typeof assertion.value === 'boolean' ? Number(assertion.value) : nonNegativeInteger(assertion.value, 'value');
      return {
        prepare: [`execute store result score @s ${SCORE_OBJECTIVE} run gamerule ${rule}`],
        positive: `if score @s ${SCORE_OBJECTIVE} matches ${value}`,
        negative: `unless score @s ${SCORE_OBJECTIVE} matches ${value}`,
      };
    }
    case 'difficulty': {
      const value = { peaceful: 0, easy: 1, normal: 2, hard: 3 }[assertion.difficulty];
      return {
        prepare: [`execute store result score @s ${SCORE_OBJECTIVE} run difficulty`],
        positive: `if score @s ${SCORE_OBJECTIVE} matches ${value}`,
        negative: `unless score @s ${SCORE_OBJECTIVE} matches ${value}`,
      };
    }
  }
}

function tellraw(marker: string): string {
  return `/${tellrawCommand(marker)}`;
}

function tellrawCommand(marker: string): string {
  return `tellraw @s ${JSON.stringify({ text: marker })}`;
}

function markerText(kind: 'READY' | 'SETUP' | 'PASS' | 'FAIL'): string {
  return `SHANNON_TEST:${kind}:${randomUUID().split('-').join('').slice(0, 12)}`;
}

function messageText(message: unknown): string {
  if (typeof message === 'string') return message;
  if (message && typeof message === 'object' && typeof (message as { toString?: unknown }).toString === 'function') {
    return (message as { toString(): string }).toString();
  }
  return String(message);
}

function normalizeCommand(command: string): string {
  const normalized = command.trim().replace(/^\/+/, '');
  if (!normalized || /[\r\n]/.test(normalized)) throw new Error('MINECRAFT_COMMAND_INVALID');
  return normalized;
}

export function normalizeVersionedCommand(command: string, version?: string): string {
  const normalized = normalizeCommand(command);
  const [major, minor, patch = 0] = (version ?? '').split('.').map(Number);
  if (!(major > 1 || (major === 1 && (minor > 21 || (minor === 21 && patch >= 11))))) return normalized;
  const aliases: Record<string, string> = { doMobSpawning: 'spawn_mobs', doDaylightCycle: 'advance_time', doWeatherCycle: 'advance_weather',
    naturalRegeneration: 'natural_health_regeneration', natural_regeneration: 'natural_health_regeneration' };
  return normalized.replace(/^gamerule (\w+)(?= |$)/, (match, rule: string) =>
    aliases[rule] ? `gamerule minecraft:${aliases[rule]}` : match);
}

function resourceLocation(value: string): string {
  const normalized = value.includes(':') ? value : `minecraft:${value}`;
  if (!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(normalized)) throw new Error('RESOURCE_LOCATION_INVALID');
  return normalized;
}

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`ASSERTION_${name.toUpperCase()}_INVALID`);
  return value;
}

function integer(value: number, name: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`ASSERTION_${name.toUpperCase()}_INVALID`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  const parsed = integer(value, name);
  if (parsed < 0) throw new Error(`ASSERTION_${name.toUpperCase()}_INVALID`);
  return parsed;
}

function scaled(value: number, scale: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`ASSERTION_${name.toUpperCase()}_INVALID`);
  return Math.round(value * scale);
}
