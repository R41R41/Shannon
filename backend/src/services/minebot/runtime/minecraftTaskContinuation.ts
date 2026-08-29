/** Per-world Minecraft task notes. Not a process-wide last user. */
export interface MinecraftTaskContinuation {
  lastGoal: string | null;
  lastSummary: string | null;
}

const rows = new Map<string, MinecraftTaskContinuation>();

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && value.trim() === value && !['default', 'unknown'].includes(value) && !/[\x00-\x1f]/.test(value);
}

export function minecraftTaskContinuation(
  minecraft?: { serverId?: string; worldId?: string },
): MinecraftTaskContinuation | undefined {
  if (!id(minecraft?.serverId) || !id(minecraft?.worldId)) return undefined;
  const key = JSON.stringify([minecraft.serverId, minecraft.worldId]);
  let row = rows.get(key);
  if (!row) {
    row = { lastGoal: null, lastSummary: null };
    rows.set(key, row);
  }
  return row;
}
