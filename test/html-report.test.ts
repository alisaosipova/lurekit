// ADR-0021 amendment (UB-6): `--format html`, a self-contained single-file report.
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';
import { inlineHtml, markdownToHtml, renderHtml } from '../src/report/html.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function deps() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, d: { now: () => 'x', newRunId: () => 'x', adapterFor: () => { throw new Error('no adapter'); }, cwd: () => ROOT, stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) } };
}

describe('html report (UB-6)', () => {
  it('demo --format html is one self-contained document with the same data as the Markdown', async () => {
    const c = deps();
    expect(await main(['demo', '--format', 'html'], c.d)).toBe(0);
    const html = c.out.join('');
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain(`content="default-src 'none'; style-src 'unsafe-inline'"`);
    expect(html).not.toMatch(/<script|<link|<img|<iframe|\ssrc=/i);
    for (const href of html.match(/href="[^"]*"/g) ?? []) expect(href).toMatch(/^href="https?:\/\//);
    expect(html).toContain('Demo: this is a published LureKit run');
    expect(html).toContain('<strong>Vulnerable to 4 of 21 scenarios</strong>');
    expect(html).toContain('<h2>By OWASP Agentic Top 10</h2>');
    expect(html.indexOf('By OWASP Agentic Top 10')).toBeLessThan(html.indexOf('<h2>What to change</h2>'));
    expect(html).toMatch(/<td class="v-vulnerable">vulnerable/);
    expect(html).toMatch(/<td class="v-resisted">resisted/);
    const m = deps();
    await main(['demo', '--format', 'markdown'], m.d);
    // Every scenario row of the Markdown is a row of the HTML.
    const ids = m.out.join('').match(/^\| AAB-\d+ /gm) ?? [];
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(html).toContain(`<td>${id.slice(2).trim()}</td>`);
  });

  it('escapes manifest text and links only http(s) URLs', () => {
    const md = [
      '# <img src=x onerror=alert(1)>',
      '',
      '| id | name | verdict |',
      '|---|---|---|',
      '| AAB-X | <script>alert(1)</script> "q" | vulnerable |',
      '',
      '- [click](javascript:alert(1)) and [ok](https://example.org/a)',
      '- `<b>code</b>` **bold <i>**',
    ].join('\n');
    const html = markdownToHtml(md);
    expect(html).not.toMatch(/<script|<img|<i>|<b>|href="javascript/);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &quot;q&quot;');
    expect(html).toContain('<a href="https://example.org/a">ok</a>');
    expect(html).toContain('<code>&lt;b&gt;code&lt;/b&gt;</code>');
    expect(renderHtml(md, [], '</title><script>', 'f')).toContain('<title>&lt;/title&gt;&lt;script&gt;</title>');
  });

  it('inline: bare URLs stop before trailing punctuation', () => {
    expect(inlineHtml('see https://example.org/x.')).toBe('see <a href="https://example.org/x">https://example.org/x</a>.');
  });
});
