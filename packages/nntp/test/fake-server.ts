import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { once } from 'node:events';

/**
 * A real TCP server that speaks enough NNTP to drive the client.
 *
 * A real socket rather than a mocked one: the bugs worth catching here are
 * framing bugs — chunk boundaries, split terminators, dot-stuffing — and a mock
 * that hands over whole responses cannot exercise any of them.
 */
export interface FakeServer {
  readonly port: number;
  /** Command lines the server has received, in order. */
  readonly commands: readonly string[];
  close(): Promise<void>;
}

export interface FakeServerOptions {
  /** Sent on connect. Defaults to a posting-allowed greeting. */
  readonly greeting?: string;
  /**
   * Reply to a command line. Return a string to send verbatim, an array to
   * send as separate writes (to force chunk boundaries), or null to send
   * nothing at all, which is how a hung server is simulated.
   */
  readonly respond: (command: string) => string | readonly string[] | null;
}

const DEFAULT_GREETING = '200 fake NNTP ready (posting ok)\r\n';

export async function startFakeServer(options: FakeServerOptions): Promise<FakeServer> {
  const commands: string[] = [];
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // A fake server that ignores errors would turn a client bug into an
    // unhandled rejection that fails an unrelated test.
    socket.on('error', () => sockets.delete(socket));

    socket.write(options.greeting ?? DEFAULT_GREETING, 'latin1');

    let pending = '';
    socket.on('data', (chunk: Buffer) => {
      pending += chunk.toString('latin1');

      for (;;) {
        const end = pending.indexOf('\r\n');
        if (end < 0) {
          break;
        }

        const command = pending.slice(0, end);
        pending = pending.slice(end + 2);
        commands.push(command);

        const reply = options.respond(command);
        if (reply === null) {
          continue;
        }

        for (const part of typeof reply === 'string' ? [reply] : reply) {
          // latin1, not the default utf8: Usenet is 8-bit clean and an article
          // body is binary. Writing it as utf8 turns every byte above 0x7f into
          // two, which a test with an ASCII payload never notices and a test
          // with a real yEnc payload fails on with a baffling CRC error.
          socket.write(part, 'latin1');
        }
      }
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake server did not bind a TCP port');
  }

  return {
    port: (address as AddressInfo).port,
    commands,
    close: async (): Promise<void> => {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close();
      await once(server, 'close');
    },
  };
}
