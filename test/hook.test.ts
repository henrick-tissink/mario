// The SessionStart hook is synchronous — the harness waits for it before the
// agent's turn begins. These assert the two properties that make a single-box
// deployment defensible: it never blocks, and it never fails a turn.
import { expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = new URL('../cli/mario.mjs', import.meta.url).pathname;

function fakeHome(url: string) {
  const home = mkdtempSync(join(tmpdir(), 'mario-home-'));
  mkdirSync(join(home, '.config', 'mario'), { recursive: true });
  writeFileSync(
    join(home, '.config', 'mario', 'config.json'),
    JSON.stringify({ url, allow: ['gitlab.com/acme'] }),
  );
  return home;
}

function runHook(home: string, event: unknown) {
  const t0 = Date.now();
  return new Promise<{ code: number; out: string; err: string; ms: number }>((resolve) => {
    const proc = spawn(process.execPath, [CLI, 'hook'], {
      env: { ...process.env, HOME: home },
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('close', (code) => resolve({ code: code ?? 0, out, err, ms: Date.now() - t0 }));
    proc.stdin.end(JSON.stringify(event));
  });
}

test('an unreachable server does not block the turn', async () => {
  // Port 9 (discard) — connections hang or are refused, never answered.
  const home = fakeHome('http://127.0.0.1:9/a/tok');
  const r = await runHook(home, { hook_event_name: 'SessionStart', cwd: process.cwd() });
  expect(r.code).toBe(0);
  expect(r.out).toBe('');
  expect(r.err).toBe('');
  expect(r.ms).toBeLessThan(3000); // the 250ms budget plus process startup
}, 10_000);

test('a missing config is silent and exits 0', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mario-empty-'));
  const r = await runHook(home, { hook_event_name: 'SessionStart', cwd: process.cwd() });
  expect(r.code).toBe(0);
  expect(r.out).toBe('');
  expect(r.err).toBe('');
}, 10_000);

test('a malformed hook event is survivable', async () => {
  const home = fakeHome('http://127.0.0.1:9/a/tok');
  const r = await runHook(home, { hook_event_name: 'NoSuchEvent' });
  expect(r.code).toBe(0);
  expect(r.err).toBe('');
}, 10_000);
