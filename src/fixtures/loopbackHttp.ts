// Shared loopback HTTP plumbing for the serve-only fixtures (ADR-0002, invariant a). Binds an
// ephemeral port on 127.0.0.1 only and closes the server (including idle keep-alive sockets)
// on teardown so the port is freed.

import type { Server } from 'node:http';

/** Listen on an ephemeral 127.0.0.1 port; returns the bound port. Closes the server and throws
 *  if the address cannot be read back. */
export async function listenLoopback(server: Server, kind: string): Promise<number> {
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
