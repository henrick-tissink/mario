#!/usr/bin/env node
// mario — the portable emit/read layer.
//
// Plain ESM with no dependencies, so it runs unmodified under Node 18+ AND
// under Bun. The installer records an absolute path to whichever runtime it
// found and writes that into the hook command, because a hook is spawned in an
// environment where a version-manager shim may not be on PATH — the previous
// system relied on a bare `node` shebang and would simply not fire.
//
// Two rules this file must never break:
//   1. It always exits 0. A coordination tool that fails an agent's turn will be
//      torn out within a day, and then the whole system protects nothing.
//   2. It never writes to stderr in hook mode, for the same reason.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.config', 'mario');
const CONFIG = join(CONFIG_DIR, 'config.json');
const TOUCH_TTL_MS = 10 * 60 * 1000;
const NET_TIMEOUT_MS = 4000;
// SessionStart is SYNCHRONOUS — the harness waits for it before the agent's turn
// begins. Every other call in this file is async or interactive and can afford
// four seconds; this one cannot afford four hundred milliseconds. It fails open:
// on timeout, error, or an unreachable server the hook prints nothing and the
// turn proceeds. Losing a collision warning is a bad minute; blocking every
// developer's every turn because one box is unwell is a bad week.
const HOOK_TIMEOUT_MS = Number(process.env.MARIO_HOOK_TIMEOUT_MS || 250);
const MAX_PATHS = 50;

// Client-side scoping. The server enforces the same list, but this is the half
// that provides privacy: an out-of-scope repo never reaches the network at all.
const DEFAULT_ALLOW = [];

function config() {
  try {
    const c = JSON.parse(readFileSync(CONFIG, 'utf8'));
    return { url: c.url ?? '', allow: Array.isArray(c.allow) ? c.allow : DEFAULT_ALLOW };
  } catch {
    // Absent or corrupt config: no endpoint, no scope. There is deliberately no
    // legacy fallback file — in the system this replaces, the documented
    // uninstall ("delete the config") left a second file behind that kept the
    // CLI emitting.
    return { url: '', allow: DEFAULT_ALLOW };
  }
}

// Mirrors the server exactly. Ports and userinfo are dropped by the URL parser
// rather than shifted into the path.
function normaliseRepo(remote) {
  if (!remote) return null;
  let s = String(remote).trim();
  if (!s) return null;
  const scp = /^(?:([^@/]+)@)?([^:/]+):(?!\/)(.+)$/.exec(s);
  if (scp) s = `ssh://${scp[2]}/${scp[3]}`;
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `ssh://${s}`;
  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!host) return null;
  const path = url.pathname
    .replace(/\.git\/?$/i, '')
    .split('/')
    .filter(Boolean)
    .map((x) => x.toLowerCase());
  if (path.length < 2) return null;
  return `${host}/${path.join('/')}`;
}

function inScope(remote, allow = config().allow) {
  const repo = normaliseRepo(remote);
  if (!repo) return false;
  const prefixes = allow.map((p) => String(p).trim().toLowerCase().replace(/\/+$/, '')).filter(Boolean);
  if (!prefixes.length) return false;
  return prefixes.some((p) => repo === p || repo.startsWith(p + '/'));
}

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function repoInfo(cwd = process.cwd()) {
  return {
    repo: git(cwd, ['remote', 'get-url', 'origin']),
    branch: git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
  };
}

// A repo is a property of the FILE, not of the session. A session rooted at
// ~/repos routinely edits several repos, and deriving one repo from cwd files
// all of it under a single bogus project with absolute paths.
const repoCache = new Map();
function repoForDir(dir) {
  if (repoCache.has(dir)) return repoCache.get(dir);
  const root = git(dir, ['rev-parse', '--show-toplevel']);
  const info = root
    ? {
        root,
        repo: git(dir, ['remote', 'get-url', 'origin']),
        branch: git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
      }
    : null;
  repoCache.set(dir, info);
  return info;
}

function groupByRepo(paths, cwd) {
  const groups = new Map();
  for (const p of paths) {
    const abs = p.startsWith('/') ? p : join(cwd, p);
    const info = repoForDir(abs.slice(0, abs.lastIndexOf('/')) || '/');
    if (!info?.repo) continue; // no owning repo: nothing to collide with
    const rel = info.root && abs.startsWith(info.root + '/') ? abs.slice(info.root.length + 1) : abs;
    const g = groups.get(info.repo) ?? { repo: info.repo, branch: info.branch, paths: [] };
    g.paths.push(rel);
    groups.set(info.repo, g);
  }
  return [...groups.values()];
}

function agentName() {
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) return 'claude';
  if (process.env.CODEX_HOME || process.env.CODEX_SANDBOX) return 'codex';
  return undefined;
}

function base() {
  const url = process.env.MARIO_URL || config().url;
  if (!url) throw new Error('no endpoint: run `mario setup <url>`');
  return url.replace(/\/+$/, '');
}

async function req(path, { method = 'GET', body, query, timeout = NET_TIMEOUT_MS } = {}) {
  const url = new URL(base() + path);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
    else url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const emit = (payload) => req('/e', { method: 'POST', body: payload });

// --- touch debounce ---------------------------------------------------------
// The server already collapses a session's touches into one row, so this exists
// only to stop one HTTP call per keystroke-sized edit. Keyed on (session, repo,
// path) rather than time alone, so a genuinely new file registers immediately —
// that is the signal collision detection needs.

function debounceFile(session) {
  return join(tmpdir(), `mario-touch-${String(session || 'nosession').replace(/[^\w-]/g, '')}.json`);
}

function filterRecent(session, paths, ns) {
  const file = debounceFile(session);
  let seen = {};
  try {
    seen = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    /* first touch of this session */
  }
  const now = Date.now();
  const key = (p) => `${ns} ${p}`;
  const fresh = paths.filter((p) => !seen[key(p)] || now - seen[key(p)] > TOUCH_TTL_MS);
  if (fresh.length) {
    for (const p of fresh) seen[key(p)] = now;
    try {
      writeFileSync(file, JSON.stringify(seen), { mode: 0o600 });
    } catch {
      /* the debounce is an optimisation, never a correctness requirement */
    }
  }
  return fresh;
}

// --- hook mode --------------------------------------------------------------

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

// Codex's apply_patch carries the whole patch envelope in tool_input.command
// rather than a file_path field. Gated on the envelope marker so a Bash command
// is never scraped.
function pathsFromPatch(command) {
  if (typeof command !== 'string' || !command.includes('*** Begin Patch')) return [];
  const out = [];
  const re = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;
  let m;
  while ((m = re.exec(command)) !== null) out.push(m[1].trim());
  return out;
}

function pathsFromToolInput(input) {
  if (!input || typeof input !== 'object') return [];
  const out = [...pathsFromPatch(input.command)];
  for (const k of ['file_path', 'path', 'notebook_path', 'filePath']) {
    if (typeof input[k] === 'string') out.push(input[k]);
  }
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) if (typeof e?.file_path === 'string') out.push(e.file_path);
  }
  if (Array.isArray(input.files)) {
    for (const f of input.files) if (typeof f === 'string') out.push(f);
  }
  return [...new Set(out)].slice(0, MAX_PATHS);
}

async function hook() {
  const ev = readStdin();
  const cwd = ev.cwd || process.cwd();
  const session = ev.session_id;
  const agent = agentName();
  const name = ev.hook_event_name;

  if (name === 'SessionStart') {
    const { repo } = repoInfo(cwd);
    if (!inScope(repo)) return;
    let r;
    try {
      r = await req('/check', { query: { repo, format: 'json' }, timeout: HOOK_TIMEOUT_MS });
    } catch {
      return; // fail open: never hold up a turn
    }
    if (!r || typeof r === 'string' || r.clear) return;
    const lines = [];
    for (const c of r.collisions ?? []) {
      const who = (c.actor.split('@')[0] ?? c.actor).replace(/^./, (x) => x.toUpperCase());
      const where = c.files?.[0] ?? c.dirs?.[0] ?? '';
      lines.push(
        `${c.heat === 'hot' ? '!' : '~'} ${who} active${where ? ` in ${where}` : ''}${c.branch ? ` (${c.branch})` : ''}`,
      );
    }
    for (const f of r.findings ?? []) {
      lines.push(`o open finding${f.seen > 1 ? ` x${f.seen}` : ''}: ${f.summary} [${f.id.slice(0, 8)}]`);
    }
    if (r.state) lines.push(`Project state: ${r.state}`);
    if (!lines.length) return;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: `[mario]\n${lines.join('\n')}`,
        },
      }),
    );
    return;
  }

  if (name === 'PostToolUse') {
    const raw = pathsFromToolInput(ev.tool_input);
    if (!raw.length) return;
    const batch = [];
    for (const g of groupByRepo(raw, cwd)) {
      if (!inScope(g.repo)) continue;
      const fresh = filterRecent(session, g.paths, g.repo);
      if (!fresh.length) continue;
      batch.push({ kind: 'touch', session, agent, repo: g.repo, branch: g.branch, paths: fresh });
    }
    if (batch.length) await emit(batch);
    return;
  }

  if (name === 'Stop' || name === 'SessionEnd') {
    const { repo, branch } = repoInfo(cwd);
    // No repo, no emit. An event with no code area has nothing to collide with
    // and nothing to summarise, and last_assistant_message is the least
    // controlled input in the system.
    if (!inScope(repo)) return;
    const msg = (ev.last_assistant_message || '').split('\n').find((l) => l.trim());
    if (!msg) return;
    await emit({ kind: 'done', session, agent, repo, branch, summary: msg.trim() });
  }
}

// --- commands ---------------------------------------------------------------

const USAGE = [
  'mario check [paths...]      who else is in this code, and what is known broken',
  'mario finding "<line>" [p]  record an out-of-scope defect or pain point',
  'mario done "<line>"         record finishing a piece of work',
  'mario findings [area]       open findings, most-reported first',
  'mario close <id> [note]     close a finding (id must be >= 8 chars)',
  'mario who [hours]           who is active where, and whether folds are running',
  'mario scope                 is this repo in scope?',
  'mario setup <url> [--allow=a,b]   store your endpoint',
  'mario hook                  (invoked by harness hooks, reads JSON on stdin)',
].join('\n');

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'hook') return hook();

  const { repo, branch } = cmd === 'setup' || cmd === 'scope' ? {} : repoInfo();

  if (['check', 'finding', 'done', 'findings'].includes(cmd) && !inScope(repo)) {
    console.log('out of scope — this repo does not emit (see `mario scope`)');
    return;
  }

  switch (cmd) {
    case 'check': {
      const r = await req('/check', { query: { repo, path: rest } });
      process.stdout.write((typeof r === 'string' ? r : JSON.stringify(r)) + '\n');
      return;
    }
    case 'finding':
    case 'done': {
      const args = rest.filter((a) => !a.startsWith('-'));
      const summary = cmd === 'done' ? args.join(' ') : args[0];
      if (!summary) throw new Error(`usage: mario ${cmd} "<one line>"`);
      const paths = cmd === 'finding' ? args.slice(1) : [];
      const r = await emit({ kind: cmd, summary, repo, branch, paths, agent: agentName() });
      const one = r?.results?.[0];
      console.log(one?.ok ? `recorded ${cmd} on ${one.project}` : `not recorded — ${one?.reason ?? r}`);
      return;
    }
    case 'findings': {
      const r = await req('/findings', { query: { area: rest[0] } });
      process.stdout.write((typeof r === 'string' ? r : JSON.stringify(r)) + '\n');
      return;
    }
    case 'close': {
      const [id, ...note] = rest;
      if (!id) throw new Error('usage: mario close <id> [note]');
      const r = await req(`/findings/${encodeURIComponent(id)}/close`, {
        method: 'POST',
        body: { note: note.join(' ') || null },
      });
      console.log(typeof r === 'string' ? r : JSON.stringify(r));
      return;
    }
    case 'who':
    case 'status': {
      const hours = rest[0] && /^\d+$/.test(rest[0]) ? rest[0] : undefined;
      const r = await req('/who', { query: { hours } });
      process.stdout.write((typeof r === 'string' ? r : JSON.stringify(r)) + '\n');
      return;
    }
    case 'setup': {
      const url = rest.find((a) => !a.startsWith('-'));
      if (!url) throw new Error('usage: mario setup <endpoint-url> [--allow=prefix,prefix]');
      const flag = rest.find((a) => a.startsWith('--allow='));
      const allow = flag
        ? flag.slice('--allow='.length).split(',').map((x) => x.trim()).filter(Boolean)
        : config().allow;
      mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
      // The endpoint is a bearer credential. 0600, not whatever the umask says.
      writeFileSync(CONFIG, JSON.stringify({ url: url.replace(/\/+$/, ''), allow }, null, 2) + '\n', {
        mode: 0o600,
      });
      chmodSync(CONFIG, 0o600);
      console.log(`wrote ${CONFIG}`);
      console.log(`  scope: ${allow.length ? allow.join(', ') : '(none — nothing will emit)'}`);
      return;
    }
    case 'scope': {
      const c = config();
      console.log(`allowed prefixes:\n  ${c.allow.join('\n  ') || '(none — nothing will emit)'}`);
      const here = repoInfo().repo;
      const why = here
        ? (normaliseRepo(here) ?? '(remote could not be parsed)')
        : git(process.cwd(), ['rev-parse', '--git-dir'])
          ? '(git repo, but no origin remote)'
          : '(not a git repo)';
      console.log(`\nthis repo: ${why} -> ${inScope(here, c.allow) ? 'IN scope' : 'OUT of scope'}`);
      return;
    }
    default:
      console.log(USAGE);
  }
}

main().catch((err) => {
  // Rule 1: never fail the caller. In hook mode, stay silent entirely.
  if (process.argv[2] !== 'hook') console.error(`mario: ${err.message}`);
  process.exit(0);
});
