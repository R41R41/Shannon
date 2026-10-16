/**
 * POSTs JSON to the UI mod and never throws. While one push to a path is in flight, only the newest of the
 * pushes after it is kept: the task tree and list change many times a second and only the latest matters.
 */
export function createUiModPusher(baseUrl: string | (() => string), timeoutMs: number,
  fetcher: typeof fetch = fetch): (route: string, value: unknown) => Promise<void> {
  const inFlight = new Set<string>();
  const waiting = new Map<string, string>();
  const origin = () => (typeof baseUrl === 'function' ? baseUrl() : baseUrl);
  const send = async (route: string, body: string): Promise<void> => {
    inFlight.add(route);
    try {
      const response = await fetcher(`${origin()}${route}`, { method: 'POST', body, signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Content-Type': 'application/json; charset=UTF-8' } });
      await response.body?.cancel();
    } catch { /* the mod is optional */ } finally {
      inFlight.delete(route);
      const next = waiting.get(route);
      if (next !== undefined) { waiting.delete(route); void send(route, next); }
    }
  };
  return (route, value) => {
    let body: string;
    try { body = JSON.stringify(value); } catch { return Promise.resolve(); }
    if (inFlight.has(route)) { waiting.set(route, body); return Promise.resolve(); }
    return send(route, body);
  };
}
