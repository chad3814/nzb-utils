import { connect as netConnect } from 'node:net';
import type { Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { TLSSocket } from 'node:tls';

import { NntpConnectionError } from './errors.ts';
import type { NntpEndpoint } from './models.ts';

export type NntpSocket = Socket | TLSSocket;

/**
 * Open a transport to the endpoint.
 *
 * Port 563 is implicit TLS and what commercial providers expect; 119 is
 * cleartext. `starttls` connects in the clear and is upgraded afterwards by
 * {@link upgradeToTls}, once the greeting has been read.
 */
export function openSocket(endpoint: NntpEndpoint): Promise<NntpSocket> {
  const { host, port, security } = endpoint;

  return new Promise<NntpSocket>((resolve, reject) => {
    const fail = (error: Error): void => {
      reject(new NntpConnectionError(`cannot connect to ${host}:${port}`, { cause: error }));
    };

    const socket =
      security === 'implicit'
        ? tlsConnect({ host, port, servername: host })
        : netConnect({ host, port });
    const ready = security === 'implicit' ? 'secureConnect' : 'connect';

    socket.once(ready, () => {
      socket.off('error', fail);
      resolve(socket);
    });
    socket.once('error', fail);
  });
}

/** Upgrade an established cleartext session in place (RFC 4642). */
export function upgradeToTls(plain: NntpSocket, host: string): Promise<TLSSocket> {
  // The caller has to detach its own listeners first, or two readers end up
  // consuming the same stream.
  plain.removeAllListeners('data');
  plain.removeAllListeners('error');
  plain.removeAllListeners('close');

  return new Promise<TLSSocket>((resolve, reject) => {
    const upgraded = tlsConnect({ socket: plain, servername: host });
    upgraded.once('secureConnect', () => resolve(upgraded));
    upgraded.once('error', (error: Error) => {
      reject(new NntpConnectionError(`STARTTLS failed: ${error.message}`, { cause: error }));
    });
  });
}
