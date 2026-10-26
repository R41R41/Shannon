/**
 * POSTs JSON to the UI mod and never throws. While one push to a path is in flight, only the newest of the
 * pushes after it is kept: the task tree and list change many times a second and only the latest matters.
 *
 * `onResult` (dragon26: what was sent to the mod and whether it arrived was in no log) hears each push once it ended: the route, the mod's
 * HTTP status (null: not reached or timed out) and the value sent. It must not throw (a throw is swallowed) and never delays a push.
 */
export function createUiModPusher(baseUrl: string | (() => string), timeoutMs: number,
  fetcher: typeof fetch = fetch, onResult?: (route: string, status: number | null, value: unknown) => void): (route: string, value: unknown) => Promise<void> {
  const inFlight = new Set<string>();
  const waiting = new Map<string, { body: string; value: unknown }>();
  const origin = () => (typeof baseUrl === 'function' ? baseUrl() : baseUrl);
  const heard = (route: string, status: number | null, value: unknown) => { try { onResult?.(route, status, value); } catch { /* a log never fails a push */ } };
  const send = async (route: string, body: string, value: unknown): Promise<void> => {
    inFlight.add(route);
    try {
      const response = await fetcher(`${origin()}${route}`, { method: 'POST', body, signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Content-Type': 'application/json; charset=UTF-8' } });
      await response.body?.cancel();
      heard(route, response.status, value);
    } catch { heard(route, null, value); /* the mod is optional */ } finally {
      inFlight.delete(route);
      const next = waiting.get(route);
      if (next !== undefined) { waiting.delete(route); void send(route, next.body, next.value); }
    }
  };
  return (route, value) => {
    let body: string;
    try { body = JSON.stringify(value); } catch { return Promise.resolve(); }
    if (inFlight.has(route)) { waiting.set(route, { body, value }); return Promise.resolve(); }
    return send(route, body, value);
  };
}
