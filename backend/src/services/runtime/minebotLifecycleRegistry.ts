type Unsub = () => void;

const spawnedListeners = new Set<() => void>();
const stoppedListeners = new Set<() => void>();
const errorListeners = new Set<(message: string) => void>();

export function onMinebotSpawned(listener: () => void): Unsub {
  spawnedListeners.add(listener);
  return () => { spawnedListeners.delete(listener); };
}

export function onMinebotStopped(listener: () => void): Unsub {
  stoppedListeners.add(listener);
  return () => { stoppedListeners.delete(listener); };
}

export function onMinebotError(listener: (message: string) => void): Unsub {
  errorListeners.add(listener);
  return () => { errorListeners.delete(listener); };
}

export function emitMinebotSpawned(): void {
  for (const listener of spawnedListeners) listener();
}

export function emitMinebotStopped(): void {
  for (const listener of stoppedListeners) listener();
}

export function emitMinebotError(message: string): void {
  for (const listener of errorListeners) listener(message);
}

export function clearMinebotLifecycleListeners(): void {
  spawnedListeners.clear();
  stoppedListeners.clear();
  errorListeners.clear();
}
