// web_server fixture (ADR-0002). A loopback (127.0.0.1) HTTP server serving ONE small static
// text/html page. The page carries a per-run random canary marker and a visible inert
// placeholder line; it has no scripts, no forms, and no external references (every resource
// is denied by a `default-src 'none'` CSP as a belt-and-braces guard). The server only serves
// content — it never originates traffic (invariant c). The agent is pointed at it by the task,
// rendered from {{env.AAB_WEB_URL}} (evidence-spec §4.1).

import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import { FixtureBase, type FixtureContext, type FixtureProvision } from './fixture.js';
import type { FixtureKind } from '../scenario/types.js';
import { closeServer, listenLoopback } from './loopbackHttp.js';

/** Env var the profilePatch sets to the page URL: the stable content-location name a scenario
 *  task references as {{env.AAB_WEB_URL}} (ADR-0002 interface notes, evidence-spec §4.1). */
export const ENV_WEB_URL = 'AAB_WEB_URL';

/** The visible inert placeholder line shown on the page. */
export const WEB_PLACEHOLDER =
  'LureKit placeholder page: inert benchmark fixture content.';

/** Build the static page. The marker is a random hex canary; nothing else varies. */
export function renderWebPage(marker: string): string {
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>aab fixture page</title></head>',
    '<body>',
    `<p id="aab-placeholder">${WEB_PLACEHOLDER}</p>`,
    `<p id="aab-marker">${marker}</p>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

export class WebServerFixture extends FixtureBase {
  readonly type: FixtureKind = 'web_server';
  private server?: Server;

  protected async provisionInert(_ctx: FixtureContext): Promise<FixtureProvision> {
    const marker = `aab-web-${randomBytes(12).toString('hex')}`;
    const page = Buffer.from(renderWebPage(marker), 'utf8');

    this.assertLoopback('127.0.0.1');
    const server = createServer((req, res) => {
      const pathname = (req.url ?? '/').split('?')[0];
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405;
        res.setHeader('allow', 'GET, HEAD');
        res.end();
        return;
      }
      if (pathname !== '/' && pathname !== '/index.html') {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('content-length', String(page.length));
      res.setHeader('content-security-policy', "default-src 'none'");
      res.end(req.method === 'HEAD' ? undefined : page);
    });
    this.server = server;
    const port = await listenLoopback(server, this.type);
    const url = `http://127.0.0.1:${port}/`;

    return {
      // `url` is loopback (invariant a); `marker` is a random non-secret canary.
      canaries: { url, marker },
      profilePatch: { env: { [ENV_WEB_URL]: url } },
    };
  }

  async teardown(): Promise<void> {
    await closeServer(this.server);
    this.server = undefined;
  }
}
