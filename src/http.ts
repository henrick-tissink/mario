// The HTTP surface.
//
// Route registration order is load-bearing in Hono — matched handlers compose in
// the order they were registered, and a handler that returns without calling
// next() ends the chain. The previous system depended on that accidentally, so
// here every guard is applied explicitly inside the handler it protects rather
// than by hoping a `use()` sits in the right place.

import { Hono } from 'hono';
import type { DB } from './db';
import { parsePaths } from './db';
import type { Config } from './config';
import { isAdmin } from './config';
import {
  actorFromRequest,
  csrfOk,
  issueToken,
  resolveToken,
  revokeAllFor,
  touchToken,
} from './auth';
import { emit, isEmitKind } from './emit';
import { check, renderCheck } from './check';
import { closeFinding, listFindings } from './findings';
import { handleMcp } from './mcp';
import { presence, renderPresence } from './presence';
import { runLuigi, type Summariser } from './luigi';
import { page, escapeHtml } from './ui';

export interface Deps {
  db: DB;
  cfg: Config;
  summarise: Summariser;
}

type Env = { Variables: { actor: string } };

export function createApp(deps: Deps): Hono<Env> {
  const { db, cfg } = deps;
  const app = new Hono<Env>();

  // --- agent surface: /a/:token/* ------------------------------------------

  const agent = new Hono<Env>();

  agent.use('/:token/*', async (c, next) => {
    const token = c.req.param('token');
    const actor = token ? resolveToken(db, token) : null;
    if (!actor) return c.json({ error: 'unknown endpoint' }, 401);
    c.set('actor', actor);
    touchToken(db, token!);
    await next();
  });

  // Always 200 on a body we could read. An emit that fails must never surface as
  // an error inside an agent's loop and derail whatever it was actually doing —
  // which is also why the JSON parse is inside the try, not outside it.
  agent.post('/:token/e', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ results: [{ ok: false, skipped: 'empty', reason: 'body was not JSON' }] });
    }
    const items = (Array.isArray(body) ? body : [body]).slice(0, 50);
    const results = items.map((raw) => {
      try {
        const item = raw as Record<string, unknown>;
        if (!isEmitKind(item.kind)) {
          return { ok: false, skipped: 'empty', reason: `unknown kind ${String(item.kind)}` };
        }
        return emit(db, cfg, c.get('actor'), item as never);
      } catch (err) {
        console.error('emit failed', err);
        return {
          ok: false,
          skipped: 'empty',
          reason: String(err instanceof Error ? err.message : err).slice(0, 300),
        };
      }
    });
    return c.json({ results });
  });

  agent.get('/:token/check', (c) => {
    const r = check(db, cfg, c.get('actor'), {
      repo: c.req.query('repo'),
      project: c.req.query('project'),
      paths: c.req.queries('path') ?? [],
    });
    return c.req.query('format') === 'json' ? c.json(r) : c.text(renderCheck(r));
  });

  agent.get('/:token/who', (c) => {
    const p = presence(db, cfg, Number(c.req.query('hours') ?? 48));
    return c.req.query('format') === 'json' ? c.json(p) : c.text(renderPresence(p));
  });

  agent.get('/:token/findings', (c) => {
    const rows = listFindings(db, {
      project: c.req.query('project'),
      area: c.req.query('area'),
      status: c.req.query('status'),
      limit: Number(c.req.query('limit') ?? 20),
    });
    if (c.req.query('format') === 'json') return c.json({ findings: rows });
    if (!rows.length) return c.text('none');
    return c.text(
      rows
        .map(
          (f) =>
            `[${f.id.slice(0, 8)}] ${f.project}${f.seen_count > 1 ? ` x${f.seen_count}` : ''}: ${f.summary}`,
        )
        .join('\n'),
    );
  });

  // POST only. A GET on the MCP path opens an SSE stream that never emits and
  // keeps a server object alive for the life of the connection.
  agent.post('/:token/mcp', (c) => handleMcp(c.req.raw, db, cfg, c.get('actor')));
  agent.all('/:token/mcp', (c) =>
    c.json(
      {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed. Use POST for MCP requests.' },
        id: null,
      },
      405,
      { allow: 'POST' },
    ),
  );

  agent.post('/:token/luigi', async (c) => {
    if (!isAdmin(cfg, c.get('actor'))) return c.json({ error: 'forbidden' }, 403);
    return c.json({ folded: await runLuigi(db, cfg, deps.summarise) });
  });

  app.route('/a', agent);

  // --- browser surface ------------------------------------------------------

  const api = new Hono<Env>();

  api.use('/*', async (c, next) => {
    if (!csrfOk(c.req.raw)) return c.json({ error: 'missing x-mario header' }, 403);
    const actor = await actorFromRequest(c.req.raw, cfg);
    if (!actor) return c.json({ error: 'unauthorised' }, 401);
    c.set('actor', actor);
    await next();
  });

  api.get('/me', (c) => {
    const actor = c.get('actor');
    const existing = db
      .query<{ created_at: number }, [string]>(
        'SELECT created_at FROM tokens WHERE actor = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1',
      )
      .get(actor);
    return c.json({
      actor,
      admin: isAdmin(cfg, actor),
      has_endpoint: !!existing,
      endpoint_created: existing?.created_at ?? null,
    });
  });

  api.get('/who', (c) => c.json(presence(db, cfg, Number(c.req.query('hours') ?? 48))));

  api.get('/findings', (c) =>
    c.json({
      findings: listFindings(db, {
        status: c.req.query('status'),
        project: c.req.query('project'),
        limit: 200,
      }),
    }),
  );

  api.post('/findings/:id/close', async (c) => {
    const body = await c.req.json<{ note?: string }>().catch(() => ({}) as { note?: string });
    const r = closeFinding(db, c.req.param('id'), body.note ?? null);
    return r.ok ? c.json({ closed: r.id }) : c.json({ error: r.reason }, 400);
  });

  // Self-serve. Access has already proved identity, so a caller can only ever
  // mint for themselves — the actor comes from the verified JWT, never the body.
  api.post('/endpoint', (c) => {
    const actor = c.get('actor');
    const replaced = revokeAllFor(db, actor);
    const token = issueToken(db, actor);
    const url = new URL(c.req.url);
    // Force https off the host rather than trusting the request scheme: this URL
    // is baked into every developer's config, and one http:// would put their
    // events on the wire in clear text.
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    return c.json({
      endpoint: `${local ? url.origin : `https://${url.host}`}/a/${token}`,
      replaced: replaced > 0,
    });
  });

  api.post('/luigi', async (c) => {
    if (!isAdmin(cfg, c.get('actor'))) return c.json({ error: 'forbidden' }, 403);
    return c.json({ folded: await runLuigi(db, cfg, deps.summarise) });
  });

  app.route('/api', api);

  // --- pages ----------------------------------------------------------------

  app.get('/', (c) => c.html(page('who')));
  app.get('/findings', (c) => c.html(page('findings')));
  app.get('/setup', (c) => c.html(page('setup')));

  app.notFound((c) => c.text('not found', 404));
  app.onError((err, c) => {
    console.error('unhandled', err);
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}

export { escapeHtml, parsePaths };
