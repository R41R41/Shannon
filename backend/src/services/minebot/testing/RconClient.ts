import net from 'node:net';

// Source RCON (what a Minecraft server speaks on rcon.port): little-endian int32 length, request id and type,
// an ASCII body and two NUL bytes. A wrong password is answered with request id -1.
const LOGIN = 3;
const COMMAND = 2;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The operator's console on a lab server that people join with real accounts. There an offline operator bot
 * cannot log in, so commands go over RCON instead. One command at a time, answered in order.
 */
export class RconClient {
  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private waiting = new Map<number, { resolve: (body: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly host: string, private readonly port: number, private readonly password: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {}

  async connect(): Promise<void> {
    const socket = net.connect({ host: this.host, port: this.port });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.on('data', chunk => this.receive(chunk));
    socket.on('error', error => this.failAll(error));
    socket.on('close', () => this.failAll(new Error('RCON_CLOSED')));
    this.socket = socket;
    await this.request(LOGIN, this.password);
  }

  /** Runs one console command and returns what the server printed for it. */
  send(command: string): Promise<string> {
    const run = this.queue.then(() => this.request(COMMAND, command.replace(/^\//, '')));
    this.queue = run.catch(() => undefined);
    return run;
  }

  close(): void {
    this.socket?.end();
    this.socket = null;
  }

  private request(type: number, body: string): Promise<string> {
    if (!this.socket) return Promise.reject(new Error('RCON_NOT_CONNECTED'));
    const id = this.nextId++;
    const payload = Buffer.from(body, 'utf8');
    const packet = Buffer.alloc(14 + payload.length);
    packet.writeInt32LE(10 + payload.length, 0);
    packet.writeInt32LE(id, 4);
    packet.writeInt32LE(type, 8);
    payload.copy(packet, 12);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error('RCON_TIMEOUT'));
      }, this.timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      this.socket!.write(packet);
    });
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readInt32LE(0);
      if (this.buffer.length < 4 + length) return;
      const id = this.buffer.readInt32LE(4);
      const body = this.buffer.subarray(12, 4 + length - 2).toString('utf8');
      this.buffer = this.buffer.subarray(4 + length);
      if (id === -1) {
        this.failAll(new Error('RCON_AUTH_REJECTED'));
        continue;
      }
      const waiter = this.waiting.get(id);
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      this.waiting.delete(id);
      waiter.resolve(body);
    }
  }

  private failAll(error: Error): void {
    for (const [id, waiter] of this.waiting) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
      this.waiting.delete(id);
    }
  }
}
