/** Mineflayer attaches its furnace property listener after openBlock resolves. Initial packets can precede that await. */
export function captureFurnaceProperties(bot: any) {
  const windows = new Map<number, Map<number, number>>();
  const client = bot._client;
  const receive = (packet: { windowId: number; property: number; value: number }) => {
    if (!Number.isInteger(packet.windowId) || packet.property < 0 || packet.property > 3 || !Number.isFinite(packet.value)) return;
    if (!windows.has(packet.windowId)) windows.set(packet.windowId, new Map());
    windows.get(packet.windowId)!.set(packet.property, packet.value);
    if (windows.size > 4) windows.delete(windows.keys().next().value!);
  };
  client?.on?.('craft_progress_bar', receive);
  return {
    read(window: any): { burning: boolean | null; seconds: number | null; progress: number | null } {
      const values = windows.get(window.id), ticks = values?.get(0), cooked = values?.get(2), total = values?.get(3);
      // A missing total makes the SDK report zero even when the raw burn time is positive. Zero is known only from a packet or initialized SDK state.
      const sdkKnown = window.totalFuel !== null && typeof window.fuel === 'number';
      return {
        burning: ticks !== undefined ? ticks > 0 : sdkKnown ? window.fuel > 0 : null,
        seconds: ticks !== undefined ? Math.max(0, ticks / 20) : sdkKnown && typeof window.fuelSeconds === 'number' ? Math.max(0, window.fuelSeconds) : null,
        progress: cooked !== undefined && total !== undefined && total > 0 ? Math.max(0, Math.min(1, cooked / total))
          : window.totalProgress !== null && typeof window.progress === 'number' ? window.progress : null,
      };
    },
    close() { client?.removeListener?.('craft_progress_bar', receive); windows.clear(); },
  };
}
