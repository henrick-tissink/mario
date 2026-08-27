// Mario's OpenCode adapter. OpenCode runs local plugins under Bun, while the
// shared Mario hook client remains dependency-free ESM under Node or Bun.

const WRITE_TOOLS = new Set(['edit', 'write', 'apply_patch']);

function data(result) {
  return result?.data ?? result;
}

function firstLine(parts) {
  for (const part of parts ?? []) {
    if (part?.type !== 'text' || typeof part.text !== 'string') continue;
    const line = part.text.split('\n').find((value) => value.trim());
    if (line) return line.trim();
  }
  return '';
}

function toolInput(tool, args) {
  if (!args || typeof args !== 'object') return null;
  if (tool === 'apply_patch') {
    return typeof args.patchText === 'string' ? { patchText: args.patchText } : null;
  }
  return typeof args.filePath === 'string' ? { filePath: args.filePath } : null;
}

async function runHook(cwd, event, capture = false) {
  const cmd = process.env.MARIO_BIN || `${process.env.HOME}/.local/bin/mario`;
  const child = Bun.spawn([cmd, 'hook'], {
    cwd,
    env: { ...process.env, MARIO_AGENT: 'opencode' },
    stdin: new Blob([JSON.stringify(event)]),
    stdout: capture ? 'pipe' : 'ignore',
    stderr: 'ignore',
  });

  if (!capture) {
    void child.exited.catch(() => {});
    return null;
  }

  const output = await new Response(child.stdout).text();
  await child.exited;
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

export const MarioPlugin = async ({ client, directory, worktree }) => {
  const emitted = new Set();
  const cwd = directory || worktree;

  return {
    // This hook runs before OpenCode persists the incoming message or starts the
    // model. Adding the context to its parts makes it available on the first turn.
    'chat.message': async (input, output) => {
      try {
        const messages = data(await client.session.messages({ path: { id: input.sessionID } }));
        if (messages.some((message) => message?.info?.role === 'user')) return;
        const result = await runHook(cwd, {
          hook_event_name: 'SessionStart',
          cwd,
          session_id: input.sessionID,
        }, true);
        const context = result?.hookSpecificOutput?.additionalContext;
        if (typeof context === 'string' && context) {
          output.parts.unshift({ type: 'text', text: context, synthetic: true });
        }
      } catch {
        // Startup coordination is advisory. A broken sidecar must not block chat.
      }
    },

    'tool.execute.after': async (input) => {
      if (!WRITE_TOOLS.has(input.tool)) return;
      const inputForMario = toolInput(input.tool, input.args);
      if (!inputForMario) return;
      try {
        void runHook(cwd, {
          hook_event_name: 'PostToolUse',
          cwd,
          session_id: input.sessionID,
          tool_input: inputForMario,
        }).catch(() => {});
      } catch {
        // Bun can throw before a child is created (for example, if Mario was removed).
      }
    },

    event: async ({ event }) => {
      if (event.type !== 'session.idle') return;
      try {
        const session = event.properties.sessionID;
        const messages = data(await client.session.messages({ path: { id: session } }));
        const latest = [...messages]
          .reverse()
          .find((message) => message?.info?.role === 'assistant' && !message.info.error);
        if (!latest || emitted.has(latest.info.id)) return;
        const summary = firstLine(latest.parts);
        if (!summary) return;
        emitted.add(latest.info.id);
        void runHook(cwd, {
          hook_event_name: 'SessionEnd',
          cwd,
          session_id: session,
          last_assistant_message: summary,
        }).catch(() => {});
      } catch {
        // Idle notifications are never allowed to affect an OpenCode session.
      }
    },
  };
};
