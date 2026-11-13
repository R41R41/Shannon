/** Lab only: createProbeBot returns after its first spawn. Start only the normal scan's registered listener, without re-emitting spawn to the body. */
interface SpawnHost {
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
}
type Installer<T> = (body: T, options: { log(line: string): void }) => () => void;
const installed = new WeakMap<object, () => void>();

export function installRigSpawnScan<T extends SpawnHost>(actor: T, install: Installer<T>, log: (line: string) => void): () => void {
  const existing = installed.get(actor);
  if (existing) return existing;
  const spawnListeners: Array<() => void> = [];
  // Keep reads current and writes (worldScan/worldScanCost) on the actual actor. Only event registration is observed.
  const view = new Proxy(actor, {
    get(target, key) {
      if (key === 'on') return (event: string, listener: (...args: any[]) => void) => {
        if (event === 'spawn') {
          if (spawnListeners.length) throw new Error('RIG_SCAN_MULTIPLE_SPAWN_LISTENERS');
          spawnListeners.push(listener);
        }
        return target.on(event, listener);
      };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set: (target, key, value) => Reflect.set(target, key, value, target),
  });
  const stop = install(view, { log });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    installed.delete(actor);
    stop();
  };
  const firstSpawn = spawnListeners[0];
  if (!firstSpawn) { dispose(); throw new Error('RIG_SCAN_NO_SPAWN_LISTENER'); }
  installed.set(actor, dispose);
  try { firstSpawn(); } catch (error) { dispose(); throw error; }
  return dispose;
}
