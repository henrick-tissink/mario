// The MCP surface: five tools at /a/:token/mcp.
//
// Tool descriptions load into every agent's context on every session across the
// whole team, so verbosity here has a compounding cost. One line each.
//
// The actor comes from the path token and is never a tool parameter, so an
// agent can neither forget it nor claim to be someone else.

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { DB } from './db';
import { parsePaths } from './db';
import type { Config } from './config';
import { emit } from './emit';
import { check, renderCheck } from './check';
import { closeFinding, listFindings } from './findings';
import { ago } from './repo';

const text = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }] });
const fail = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }], isError: true });

export function buildServer(db: DB, cfg: Config, actor: string): McpServer {
  const server = new McpServer(
    { name: 'mario', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'mario_check',
    {
      description:
        'Before starting work in an area: who else is active there, and what is already known broken.',
      inputSchema: {
        repo: z.string().optional().describe('git remote url or owner/repo'),
        paths: z.array(z.string()).optional().describe('files you are about to touch'),
        project: z.string().optional(),
      },
    },
    async ({ repo, paths, project }) =>
      text(renderCheck(check(db, cfg, actor, { repo, paths, project }))),
  );

  server.registerTool(
    'mario_emit',
    {
      description:
        'Record work: claim (starting), done (finished), or finding (defect noticed out of scope). One line, no essays.',
      inputSchema: {
        kind: z.enum(['claim', 'done', 'finding']),
        summary: z.string(),
        repo: z.string().optional(),
        paths: z.array(z.string()).optional(),
        branch: z.string().optional(),
        session: z.string().optional(),
        agent: z.enum(['claude', 'codex']).optional(),
      },
    },
    async (a) => {
      const r = emit(db, cfg, actor, a);
      // The result is reported honestly. The previous implementation ignored the
      // skip reason and told the agent `recorded finding on  ()` — a blank
      // project, a blank id, and a success the agent had no way to doubt.
      if (!r.ok) return fail(`not recorded — ${r.reason}`);
      const short = r.id ? ` (${r.id.slice(0, 8)})` : '';
      const seen = r.seen && r.seen > 1 ? ` — reported ${r.seen}x` : '';
      return text(
        `${r.merged ? 'merged into existing' : 'recorded'} ${a.kind} on ${r.project}${short}${seen}`,
      );
    },
  );

  server.registerTool(
    'mario_state',
    {
      description: 'Rolling summary of what has been happening on a project.',
      inputSchema: { repo: z.string().optional(), project: z.string().optional() },
    },
    async ({ repo, project }) => {
      const c = check(db, cfg, actor, { repo, project });
      if (!c.project) return text('no such project, or it is out of scope');
      const row = db
        .query<{ doc: string; updated_at: number }, [string]>(
          'SELECT doc, updated_at FROM state WHERE project = ?',
        )
        .get(c.project);
      if (!row) return text(`no state yet for ${c.project}`);
      return text(`${row.doc}\n\n(folded ${ago(row.updated_at)})`);
    },
  );

  server.registerTool(
    'mario_findings',
    {
      description: 'Open findings, most-reported first. Use to pick up known defects.',
      inputSchema: {
        project: z.string().optional(),
        area: z.string().optional().describe('path prefix filter, e.g. src/pricing/'),
        limit: z.number().int().min(1).max(50).default(20),
      },
    },
    async ({ project, area, limit }) => {
      const rows = listFindings(db, { project, area, limit });
      if (!rows.length) return text('none');
      return text(
        rows
          .map((f) => {
            const where = parsePaths(f.paths).slice(0, 2).join(', ');
            const seen = f.seen_count > 1 ? ` x${f.seen_count}` : '';
            return `[${f.id.slice(0, 8)}] ${f.project}${seen}: ${f.summary}${
              where ? ` (${where})` : ''
            } — ${ago(f.updated_at)}`;
          })
          .join('\n'),
      );
    },
  );

  server.registerTool(
    'mario_close',
    {
      description: 'Close an open finding once it is fixed or judged not real.',
      inputSchema: {
        id: z.string().min(8).describe('at least the 8-character short id'),
        note: z.string().optional().describe('why it is closed'),
      },
    },
    async ({ id, note }) => {
      const r = closeFinding(db, id, note ?? null);
      if (r.ok) return text(`closed ${r.id.slice(0, 8)}: ${r.summary}`);
      const why = {
        'too-short': 'id must be at least 8 characters — refusing a wildcard match',
        'not-found': `no finding matching ${id}`,
        ambiguous: `${id} matches more than one finding; use a longer id`,
        'already-closed': `${id} is already closed`,
      }[r.reason];
      return fail(why);
    },
  );

  return server;
}

/**
 * Stateless: a fresh server and transport per request, which is safe because
 * nothing is retained between calls. Verified against the SDK's web-standard
 * transport — the one its own docs point Bun at.
 */
export async function handleMcp(
  req: Request,
  db: DB,
  cfg: Config,
  actor: string,
): Promise<Response> {
  const server = buildServer(db, cfg, actor);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const res = await transport.handleRequest(req);
  req.signal.addEventListener('abort', () => void server.close());
  return res;
}
