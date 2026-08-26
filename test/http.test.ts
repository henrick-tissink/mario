import { beforeEach, expect, test } from 'vitest';
import { openMemory, type DB } from '../src/db';
import { createApp } from '../src/http';
import { issueToken } from '../src/auth';
import type { Config } from '../src/config';

const cfg: Config = {
  decayMs: 120*60_000, allow: ['gitlab.com/acme'], stateMaxLines: 15, maxSummary: 280,
  maxFoldEvents: 500, admins: ['boss@x.co'], accessTeamDomain: '', accessAud: '',
  foldModel: 't', devActor: 'dev@x.co',
};
const REPO = 'git@gitlab.com:acme/widgets.git';
let db: DB, app: ReturnType<typeof createApp>, token: string;

beforeEach(() => {
  db = openMemory();
  app = createApp({ db, cfg, summarise: async () => 'doc' });
  token = issueToken(db, 'henry@x.co');
});

const post = (path: string, body: unknown, headers: Record<string,string> = {}) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body) });

test('an unknown endpoint is 401', async () => {
  expect((await app.request('/a/nope/check')).status).toBe(401);
});

test('emit and check round-trip through HTTP', async () => {
  const r = await post(`/a/${token}/e`, { kind: 'touch', session: 's', repo: REPO, paths: ['src/p/a.ts'] });
  expect(r.status).toBe(200);
  expect((await r.json() as any).results[0].ok).toBe(true);

  const other = issueToken(db, 'me@x.co');
  const c = await app.request(`/a/${other}/check?repo=${encodeURIComponent(REPO)}&path=src/p/a.ts`);
  expect(await c.text()).toContain('! Henry is editing src/p/a.ts');
});

test('a malformed body is still 200 — never derail an agent turn', async () => {
  const r = await app.request(`/a/${token}/e`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json{',
  });
  expect(r.status).toBe(200);
  expect((await r.json() as any).results[0].ok).toBe(false);
});

test('an unknown kind is rejected per-item, not with a 500', async () => {
  const r = await post(`/a/${token}/e`, { kind: 'wat', repo: REPO, summary: 'x' });
  expect(r.status).toBe(200);
  const body = await r.json() as any;
  expect(body.results[0].ok).toBe(false);
  expect(db.query('SELECT * FROM events').all().length).toBe(0);
});

test('a batch is capped at 50', async () => {
  const many = Array.from({ length: 80 }, (_, i) =>
    ({ kind: 'done', summary: `x${i}`, repo: REPO }));
  const r = await post(`/a/${token}/e`, many);
  expect((await r.json() as any).results.length).toBe(50);
});

test('MCP is POST-only; GET does not open a stream', async () => {
  const g = await app.request(`/a/${token}/mcp`);
  expect(g.status).toBe(405);
  expect(g.headers.get('allow')).toBe('POST');
});

test('MCP initialize and a real tool call', async () => {
  const call = (body: unknown) => app.request(`/a/${token}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
  const init = await call({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  expect((await init.json() as any).result.serverInfo.name).toBe('mario');

  const list = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const names = (await list.json() as any).result.tools.map((t: any) => t.name).sort();
  expect(names).toEqual(['mario_check','mario_close','mario_emit','mario_findings','mario_state']);

  const emitted = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'mario_emit', arguments: { kind: 'finding', summary: 'bad thing', repo: REPO } } });
  expect((await emitted.json() as any).result.content[0].text).toContain('recorded finding');
});

test('MCP reports an out-of-scope emit as a failure, not a fake success', async () => {
  const r = await app.request(`/a/${token}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'mario_emit', arguments: { kind: 'finding', summary: 'x', repo: 'git@github.com:someone/p.git' } } }),
  });
  const res = (await r.json() as any).result;
  expect(res.isError).toBe(true);
  expect(res.content[0].text).toContain('not recorded');
});

test('admin-only fold', async () => {
  expect((await post(`/a/${token}/luigi`, {})).status).toBe(403);
  const boss = issueToken(db, 'boss@x.co');
  expect((await post(`/a/${boss}/luigi`, {})).status).toBe(200);
});

test('the browser API requires the CSRF header on writes', async () => {
  const noHeader = await app.request('/api/endpoint', { method: 'POST' });
  expect(noHeader.status).toBe(403);
  const withHeader = await app.request('/api/endpoint', { method: 'POST', headers: { 'x-mario': '1' } });
  expect(withHeader.status).toBe(200);
});

test('minting an endpoint retires the previous one', async () => {
  const mint = () => app.request('/api/endpoint', { method: 'POST', headers: { 'x-mario': '1' } });
  const a = (await (await mint()).json()) as any;
  const b = (await (await mint()).json()) as any;
  expect(b.replaced).toBe(true);
  const t = a.endpoint.split('/a/')[1];
  expect((await app.request(`/a/${t}/check`)).status).toBe(401);
});

test('pages render', async () => {
  for (const p of ['/', '/findings', '/setup']) {
    const r = await app.request(p);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('</html>');
  }
});

test('the probes answer without auth and report posture', async () => {
  expect((await app.request('/healthz')).status).toBe(200);
  expect((await app.request('/readyz')).status).toBe(200);
  const s = (await (await app.request('/statusz')).json()) as any;
  // devActor is set in this suite, so posture must say so rather than look well.
  expect(s.config.dev_actor_set).toBe(true);
  expect(s.warnings.join(' ')).toContain('MARIO_DEV_ACTOR');
  expect(s.ok).toBe(false);
  expect(typeof s.size.paths_bytes).toBe('number');
});

test('an oversized emit body is rejected fail-soft, not with an error status', async () => {
  const huge = JSON.stringify([{ kind: 'done', summary: 'x'.repeat(400_000), repo: REPO }]);
  const r = await app.request(`/a/${token}/e`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: huge,
  });
  expect(r.status).toBe(200);            // never derail an agent's loop
  const body = (await r.json()) as any;
  expect(body.results[0].ok).toBe(false);
  expect(db.query('SELECT * FROM events').all().length).toBe(0);
});

test('mario close reaches a real route on the agent surface', async () => {
  await post(`/a/${token}/e`, { kind: 'finding', summary: 'a real defect', repo: REPO });
  const id = (db.query<{ id: string }>('SELECT id FROM findings').get())!.id;
  const r = await post(`/a/${token}/findings/${id.slice(0, 8)}/close`, { note: 'fixed' });
  expect(r.status).toBe(200);
  const f = db.query<{ status: string; closed_by: string }>(
    'SELECT status, closed_by FROM findings').get()!;
  expect(f.status).toBe('closed');
  expect(f.closed_by).toBe('henry@x.co');   // who closed it is recorded
});

test('the agent surface serves the scope, so a client can configure itself', async () => {
  // A fresh install defaults to an empty allow-list, which fails closed — so
  // without this endpoint a correctly installed CLI emits nothing, forever,
  // silently. `mario setup` fetches this.
  const r = await app.request(`/a/${token}/scope`);
  expect(r.status).toBe(200);
  expect(((await r.json()) as any).allow).toEqual(cfg.allow);
});

test('scope requires a valid endpoint like every other agent route', async () => {
  expect((await app.request('/a/bogus/scope')).status).toBe(401);
});
