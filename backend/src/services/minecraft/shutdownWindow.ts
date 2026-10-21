/**
 * The window in which this body opens no RCON connection to the dedicated home server because it is shutting itself down.
 *
 * 2026-10-21 13:13:57: the lifecycle poll (every 500 ms, `list uuids` over a new RCON connection each time) and the 250 ms stop
 * observation kept connecting while the server ran its own `stop`. One RCON client was accepted after the server thread had begun
 * to stop: its command waits for the server thread, and the server thread waits for that client to exit (RconClient.stop joins it,
 * RCON "failed to exit after N second(s)" then "Waited N seconds attempting force stop!"). The world was already saved, but the
 * process never ended, so stop.sh's wait and then systemd's 90 s TimeoutStopSec ended in SIGKILL (failed/timeout).
 *
 * A body that has just asked for a stop, or has just run stop.sh, therefore stays off RCON until the process is seen gone (the
 * stopped observation clears the window), and at most for SHUTDOWN_QUIET_MS if it never goes. Only this body's own, known
 * shutdowns can be covered; a stop typed in the game or sent by another tool is not visible to it (systemd's `deactivating` is, and
 * the process status already keeps that unknown without any RCON).
 */
export const SHUTDOWN_QUIET_MS = 180_000;

export class ShutdownWindow {
  private readonly open = new Map<symbol, number>();
  constructor(private readonly now: () => number = Date.now) {}

  /** Opens the window and returns the function that closes this opening (idempotent). Several openings may overlap. */
  begin(): () => void {
    const token = Symbol('shutdown');
    this.open.set(token, this.now());
    return () => { this.open.delete(token); };
  }

  /** True while any opening is younger than SHUTDOWN_QUIET_MS; older openings are dropped, so a server that never stops is polled again. */
  active(): boolean {
    for (const [token, since] of this.open) if (this.now() - since >= SHUTDOWN_QUIET_MS) this.open.delete(token);
    return this.open.size > 0;
  }

  /** The process is gone (or was never going): nothing can be shutting down any more. */
  clear(): void { this.open.clear(); }
}

/** The one window of the dedicated home server, shared by the lifecycle native and the registered stop script. */
export const shannonHomeShutdown = new ShutdownWindow();
