// The SessionStart hook is synchronous — the harness waits for it before the
// agent's turn begins. These assert the two properties that make a single-box
// deployment defensible: it never blocks, and it never fails a turn.
import { expect, test } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
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

function runHook(home: string, event: unknown, env: NodeJS.ProcessEnv = {}) {
  const t0 = Date.now();
  return new Promise<{ code: number; out: string; err: string; ms: number }>((resolve) => {
    const proc = spawn(process.execPath, [CLI, 'hook'], {
      env: { ...process.env, ...env, HOME: home },
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('close', (code) => resolve({ code: code ?? 0, out, err, ms: Date.now() - t0 }));
    proc.stdin.end(JSON.stringify(event));
  });
}

async function emitFromHook(event: unknown, env?: NodeJS.ProcessEnv) {
  let emitted: unknown;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      emitted = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ results: [{ ok: true }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind a port');
  const home = fakeHome(`http://127.0.0.1:${address.port}/a/tok`);
  const result = await runHook(home, event, env);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return { emitted, result };
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

test('OpenCode patch events report paths and OpenCode attribution', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'mario-repo-'));
  mkdirSync(join(repo, 'src'));
  execFileSync('git', ['init', repo], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@gitlab.com:acme/widgets.git']);

  const { emitted, result } = await emitFromHook(
    {
      hook_event_name: 'PostToolUse',
      cwd: repo,
      session_id: 'open-session',
      tool_input: {
        patchText: '*** Begin Patch\n*** Update File: src/cart.ts\n*** End Patch',
      },
    },
    { MARIO_AGENT: 'opencode' },
  );

  expect(result.code).toBe(0);
  expect(emitted).toEqual([
    expect.objectContaining({
      kind: 'touch',
      session: 'open-session',
      agent: 'opencode',
      paths: ['src/cart.ts'],
    }),
  ]);
});
