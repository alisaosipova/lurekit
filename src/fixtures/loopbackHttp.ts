// Shared loopback HTTP plumbing for the serve-only fixtures (ADR-0002, invariant a). Binds an
// ephemeral port on 127.0.0.1 only and closes the server (including idle keep-alive sockets)
// on teardown so the port is freed.

import type { Server } from 'node:http';

import type { FixtureObservation } from './fixture.js';

/** Listen on an ephemeral 127.0.0.1 port; returns the bound port. Closes the server and throws
 *  if the address cannot be read back. */
/** Fixed request limits of every loopback fixture server (ADR-0002 note, block B10 ENGINE-15):
 *  Node's defaults (300 s request, 60 s headers) outlast the 10 s teardown bound. */
export const LOOPBACK_REQUEST_TIMEOUT_MS = 5000;
export const LOOPBACK_HEADERS_TIMEOUT_MS = 5000;
export const LOOPBACK_KEEPALIVE_TIMEOUT_MS = 1000;
/** Largest request body a loopback fixture reads (larger: 413). */
export const LOOPBACK_MAX_BODY = 1024 * 1024;

export async function listenLoopback(server: Server, kind: string): Promise<number> {
  server.requestTimeout = LOOPBACK_REQUEST_TIMEOUT_MS;
  server.headersTimeout = LOOPBACK_HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = LOOPBACK_KEEPALIVE_TIMEOUT_MS;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    await closeServer(server);
    throw new Error(`${kind} fixture: failed to bind an ephemeral loopback port`);
  }
  return addr.port;
}

/** Close a server and drop every open connection so the port is released promptly. */
export async function closeServer(server: Server | undefined): Promise<void> {
  if (!server || !server.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

/** Passive delivery counter for a serve-only fixture (evidence-spec s3.1 `content_fetched`,
 *  ADR-0002 amendment "content delivery"). The request handler calls request() once per
 *  incoming request and delivered() when it answers with the attack-bearing content body
 *  (never for HEAD, a 404, a 405 or another path). It only counts; it originates nothing. */
export class DeliveryCounter {
  private requests = 0;
  private deliveries = 0;

  request(): void {
    this.requests += 1;
  }

  delivered(): void {
    this.deliveries += 1;
  }

  snapshot(): FixtureObservation {
    return {
      content_fetched: this.deliveries > 0,
      content_requests: this.deliveries,
      request_count: this.requests,
    };
  }
}
