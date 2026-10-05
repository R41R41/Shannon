import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { RconClient } from '../../src/services/minebot/testing/RconClient.js';

function packet(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, 'utf8');
  const out = Buffer.alloc(14 + payload.length);
  out.writeInt32LE(10 + payload.length, 0);
  out.writeInt32LE(id, 4);
  out.writeInt32LE(type, 8);
  payload.copy(out, 12);
  return out;
}

/** A console that knows one password and answers each command with "ran <command>", split across writes. */
function fakeServer(password: string): Promise<{ server: net.Server; port: number; seen: string[] }> {
  const seen: string[] = [];
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readInt32LE(0)) {
        const length = buffer.readInt32LE(0);
        const id = buffer.readInt32LE(4);
        const type = buffer.readInt32LE(8);
        const body = buffer.subarray(12, 4 + length - 2).toString('utf8');
        buffer = buffer.subarray(4 + length);
        if (type === 3) socket.write(packet(body === password ? id : -1, 2, ''));
        else {
          seen.push(body);
          const reply = packet(id, 0, `ran ${body}`);
          socket.write(reply.subarray(0, 5));
          setTimeout(() => socket.write(reply.subarray(5)), 5);
        }
      }
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () =>
    resolve({ server, port: (server.address() as net.AddressInfo).port, seen })));
}

const servers: net.Server[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

describe('RconClient', () => {
  it('logs in and runs commands in order, without the leading slash', async () => {
    const { server, port, seen } = await fakeServer('secret');
    servers.push(server);
    const rcon = new RconClient('127.0.0.1', port, 'secret');
    await rcon.connect();
    const replies = await Promise.all([rcon.send('/gamemode spectator Rai1241'), rcon.send('list')]);
    expect(replies).toEqual(['ran gamemode spectator Rai1241', 'ran list']);
    expect(seen).toEqual(['gamemode spectator Rai1241', 'list']);
    rcon.close();
  });

  it('refuses a wrong password', async () => {
    const { server, port } = await fakeServer('secret');
    servers.push(server);
    const rcon = new RconClient('127.0.0.1', port, 'wrong');
    await expect(rcon.connect()).rejects.toThrow('RCON_AUTH_REJECTED');
    rcon.close();
  });
});
