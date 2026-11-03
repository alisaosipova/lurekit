// typedPath / shownPath (ADR-0022 amendment: printed next commands) for both path flavours, so the
// Windows behaviour is checked on every CI OS: path.win32 and path.posix are passed explicitly.

import { describe, expect, it } from 'vitest';
import path from 'node:path';

import { scenariosArg, shownPath, typedPath } from '../src/cli.js';

describe('typedPath', () => {
  it('win32: a drive path with backslashes is plain and printed unquoted', () => {
    expect(typedPath('D:\\a\\x\\scenarios', path.win32)).toBe('D:\\a\\x\\scenarios');
    expect(typedPath('D:\\a\\lurekit\\lurekit\\.aab-test-work\\newcomer-1\\c-AAB-003', path.win32)).toBe(
      'D:\\a\\lurekit\\lurekit\\.aab-test-work\\newcomer-1\\c-AAB-003',
    );
    expect(typedPath('runs\\aab-test-newcomer', path.win32)).toBe('runs\\aab-test-newcomer');
    expect(typedPath('D:/a/x/scenarios', path.win32)).toBe('D:/a/x/scenarios');
  });

  it('win32: a path with a space or a quote is single-quoted', () => {
    expect(typedPath('C:\\Program Files\\lurekit\\scenarios', path.win32)).toBe("'C:\\Program Files\\lurekit\\scenarios'");
    expect(typedPath("C:\\it's\\x", path.win32)).toBe("'C:\\it'\\''s\\x'");
  });

  it('posix: plain paths unquoted; a space or a backslash (a shell escape there) is quoted', () => {
    expect(typedPath('/home/u/lurekit/scenarios', path.posix)).toBe('/home/u/lurekit/scenarios');
    expect(typedPath('node_modules/@scope/pkg+1:x', path.posix)).toBe('node_modules/@scope/pkg+1:x');
    expect(typedPath('/home/u/my runs', path.posix)).toBe("'/home/u/my runs'");
    expect(typedPath('a\\b', path.posix)).toBe("'a\\b'");
  });
});

describe('shownPath', () => {
  const win = { cwd: () => 'D:\\a\\lurekit\\lurekit\\.aab-test-work\\newcomer-1' };
  const posix = { cwd: () => '/home/u/work' };

  it('win32: below the cwd -> relative with backslashes, unquoted', () => {
    expect(shownPath('runs\\aab-test-newcomer', win, path.win32)).toBe('runs\\aab-test-newcomer');
    expect(shownPath('runs/aab-test-newcomer', win, path.win32)).toBe('runs\\aab-test-newcomer');
    expect(shownPath('D:\\a\\lurekit\\lurekit\\.aab-test-work\\newcomer-1\\.aab-runs\\aab-new', win, path.win32)).toBe(
      '.aab-runs\\aab-new',
    );
    expect(shownPath('.aab-runs', win, path.win32)).toBe('.aab-runs');
  });

  it('win32: outside the cwd or on another drive -> absolute, unquoted when plain', () => {
    expect(shownPath('D:\\elsewhere\\runs', win, path.win32)).toBe('D:\\elsewhere\\runs');
    expect(shownPath('E:\\runs\\aab-1', win, path.win32)).toBe('E:\\runs\\aab-1');
    expect(shownPath('..\\other', win, path.win32)).toBe('D:\\a\\lurekit\\lurekit\\.aab-test-work\\other');
    expect(shownPath('C:\\My Runs\\aab-1', win, path.win32)).toBe("'C:\\My Runs\\aab-1'");
  });

  it('win32: the cwd itself and a "..name" child', () => {
    expect(shownPath('.', win, path.win32)).toBe('D:\\a\\lurekit\\lurekit\\.aab-test-work\\newcomer-1');
    expect(shownPath('..runs', win, path.win32)).toBe('..runs');
  });

  it('posix: below the cwd -> relative; outside -> absolute; spaces quoted', () => {
    expect(shownPath('runs/aab-test-newcomer', posix, path.posix)).toBe('runs/aab-test-newcomer');
    expect(shownPath('/home/u/work/.aab-runs/aab-new', posix, path.posix)).toBe('.aab-runs/aab-new');
    expect(shownPath('../other', posix, path.posix)).toBe('/home/u/other');
    expect(shownPath('/srv/my runs', posix, path.posix)).toBe("'/srv/my runs'");
    expect(shownPath('..runs', posix, path.posix)).toBe('..runs');
  });
});

describe('typedPath: shell-significant characters are always quoted', () => {
  const dangerous = [' ', "'", '"', '$', '`', ';', '&', '|', '<', '>', '(', ')', '*', '?', '!', '#', '~', '%', '\n', '\r', '\t'];
  for (const flavour of [path.win32, path.posix]) {
    const name = flavour === path.win32 ? 'win32' : 'posix';
    it(`${name}: every dangerous character forces quoting`, () => {
      for (const ch of dangerous) {
        const p = flavour === path.win32 ? `D:\\a\\x${ch}y` : `/a/x${ch}y`;
        const out = typedPath(p, flavour);
        expect(out, JSON.stringify(ch)).toBe(`'${p.replace(/'/g, "'\\''")}'`);
      }
    });
  }
});

describe('scenariosArg (corpus: line for the shipped corpus)', () => {
  it('win32: CI layout -> relative with backslashes, unquoted', () => {
    expect(scenariosArg('D:\\a\\lurekit\\lurekit\\scenarios', 'D:\\a\\lurekit\\lurekit\\.aab-test-work\\newcomer-1', path.win32)).toBe(
      '..\\..\\scenarios',
    );
    expect(scenariosArg('D:\\a\\lurekit\\scenarios', 'D:\\a\\lurekit\\scenarios', path.win32)).toBe('.');
  });

  it('win32: another drive -> absolute, unquoted when plain, quoted with a space', () => {
    expect(scenariosArg('C:\\npm\\lurekit\\scenarios', 'D:\\work', path.win32)).toBe('C:\\npm\\lurekit\\scenarios');
    expect(scenariosArg('C:\\Program Files\\lurekit\\scenarios', 'D:\\work', path.win32)).toBe(
      "'C:\\Program Files\\lurekit\\scenarios'",
    );
  });

  it('posix: relative when plain, absolute quoted otherwise', () => {
    expect(scenariosArg('/home/u/lurekit/scenarios', '/home/u/lurekit/work', path.posix)).toBe('../scenarios');
    expect(scenariosArg('/home/u/my lurekit/scenarios', '/home/u/w', path.posix)).toBe("'/home/u/my lurekit/scenarios'");
  });
});
