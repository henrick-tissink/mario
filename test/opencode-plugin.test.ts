import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// OpenCode loads this file under Bun. The production plugin has no package
// dependency, so a small Bun process stub is enough to test its boundary.
const { MarioPlugin } = await import('../cli/opencode-plugin.mjs');

type SpawnCall = {
  cmd: string[];
  options: { cwd: string; stdin: Blob; stdout: string; env: Record<string, string | undefined> };
};

const encoder = new TextEncoder();
const stream = (text = '') =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });

let calls: SpawnCall[];
let originalBun: unknown;
let originalMarioBin: string | undefined;

beforeEach(() => {
  calls = [];
  originalBun = (globalThis as { Bun?: unknown }).Bun;
  originalMarioBin = process.env.MARIO_BIN;
  process.env.MARIO_BIN = '/tmp/mario';
  (globalThis as { Bun?: unknown }).Bun = {
    spawn: vi.fn((cmd: string[], options: SpawnCall['options']) => {
      calls.push({ cmd, options });
      return { stdout: stream(), exited: Promise.resolve(0) };
    }),
  };
});

afterEach(() => {
  (globalThis as { Bun?: unknown }).Bun = originalBun;
  if (originalMarioBin === undefined) delete process.env.MARIO_BIN;
  else process.env.MARIO_BIN = originalMarioBin;
});

const payload = async (at = 0) => JSON.parse(await calls[at]!.options.stdin.text());

test('injects Mario context into the first OpenCode message', async () => {
  (globalThis as { Bun?: { spawn: ReturnType<typeof vi.fn> } }).Bun!.spawn.mockImplementationOnce(
    (cmd: string[], options: SpawnCall['options']) => {
      calls.push({ cmd, options });
      return {
        stdout: stream(JSON.stringify({ hookSpecificOutput: { additionalContext: '<mario-activity>data</mario-activity>' } })),
        exited: Promise.resolve(0),
      };
    },
  );
  const client = { session: { messages: vi.fn().mockResolvedValue({ data: [] }) } };
  const hooks = await MarioPlugin({ client, directory: '/repo', worktree: '/repo' });
  const output = { parts: [{ type: 'text', text: 'Fix the bug' }] };

  await hooks['chat.message']!({ sessionID: 's1' }, output);

  expect(output.parts[0]).toMatchObject({ type: 'text', text: '<mario-activity>data</mario-activity>' });
  expect(await payload()).toMatchObject({ hook_event_name: 'SessionStart', cwd: '/repo', session_id: 's1' });
  expect(calls[0]!.options.env.MARIO_AGENT).toBe('opencode');
});

test('reports only OpenCode write tools and preserves apply_patch payloads', async () => {
  const client = { session: { messages: vi.fn() } };
  const hooks = await MarioPlugin({ client, directory: '/repo', worktree: '/repo' });

  await hooks['tool.execute.after']!({ tool: 'read', sessionID: 's1', args: { filePath: 'src/a.ts' } }, {});
  await hooks['tool.execute.after']!({ tool: 'edit', sessionID: 's1', args: { filePath: 'src/a.ts' } }, {});
  await hooks['tool.execute.after']!({
    tool: 'apply_patch',
    sessionID: 's1',
    args: { patchText: '*** Begin Patch\n*** Update File: src/b.ts\n*** End Patch' },
  }, {});

  expect(calls).toHaveLength(2);
  expect(await payload(0)).toMatchObject({
    hook_event_name: 'PostToolUse',
    session_id: 's1',
    tool_input: { filePath: 'src/a.ts' },
  });
  expect(await payload(1)).toMatchObject({
    tool_input: { patchText: '*** Begin Patch\n*** Update File: src/b.ts\n*** End Patch' },
  });
});

test('emits one completion for the latest successful assistant response', async () => {
  const client = {
    session: {
      messages: vi.fn().mockResolvedValue({
        data: [
          { info: { id: 'a1', role: 'assistant' }, parts: [{ type: 'text', text: 'Finished the fix.\nMore detail.' }] },
        ],
      }),
    },
  };
  const hooks = await MarioPlugin({ client, directory: '/repo', worktree: '/repo' });

  await hooks.event!({ event: { type: 'session.idle', properties: { sessionID: 's1' } } });
  await hooks.event!({ event: { type: 'session.idle', properties: { sessionID: 's1' } } });

  expect(calls).toHaveLength(1);
  expect(await payload()).toMatchObject({
    hook_event_name: 'SessionEnd',
    session_id: 's1',
    last_assistant_message: 'Finished the fix.',
  });
});
