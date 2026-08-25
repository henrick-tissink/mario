// Repo normalisation, scoping, and project identity.
//
// Three defects in the system this replaces all lived in one function, because
// it parsed git remotes with string surgery instead of a URL parser:
//   - an explicit port became a path segment  (host:8443/org/x -> host/8443/org/x)
//   - `@` anywhere truncated the path         (org/a@b -> b -> null)
//   - and the same rule could fail OPEN       (github.com/evil@gitlab.com/org/x
//                                              -> gitlab.com/org/x, in scope)
// So this one is written to be boring and total: every remote form is converted
// to a URL first, and everything after that is field access.

/** A remote, normalised to `host/path/segments`, lowercased. */
export type Repo = string & { readonly __brand: 'Repo' };

const SCP_LIKE = /^(?:([^@/]+)@)?([^:/]+):(?!\/)(.+)$/;

/**
 * git@gitlab.com:acme/widgets/core.git -> gitlab.com/acme/widgets/core
 * https://user:pw@github.com:8443/acme-labs/x    -> github.com/acme-labs/x
 *
 * Host AND full path are kept: GitLab subgroups nest arbitrarily deep, and
 * truncating to the last two segments discards the owning org — which is
 * exactly what scoping filters on. Ports and userinfo are dropped, not
 * shifted into the path.
 */
export function normaliseRepo(remote: string | null | undefined): Repo | null {
  if (!remote) return null;
  let s = String(remote).trim();
  if (!s) return null;

  // scp-style (`git@host:org/repo`) has no scheme and is not a valid URL.
  // The negative lookahead on `:/` keeps `https://…` out of this branch.
  const scp = SCP_LIKE.exec(s);
  if (scp) s = `ssh://${scp[2]}/${scp[3]}`;
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `ssh://${s}`;

  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }

  // url.hostname drops userinfo and port for us — that is the whole point.
  const host = url.hostname.toLowerCase();
  if (!host) return null;

  const path = url.pathname
    .replace(/\.git\/?$/i, '')
    .split('/')
    .filter(Boolean)
    .map((seg) => seg.toLowerCase());

  // A remote must identify an owner and a repo. One segment is not a repo.
  if (path.length < 2) return null;
  return `${host}/${path.join('/')}` as Repo;
}

/**
 * Scoping is an allow-list of prefixes, so an org nobody has considered is out
 * rather than silently in. Enforced independently on the client (which is the
 * half that provides privacy — out-of-scope work never leaves the machine) and
 * on the server (which is central policy). Both fail closed, so drift between
 * them can only ever mean fewer events.
 */
export function inScope(repo: string | null | undefined, allow: readonly string[]): boolean {
  if (!repo) return false;
  const prefixes = allow.map((p) => p.trim().toLowerCase().replace(/\/+$/, '')).filter(Boolean);
  if (!prefixes.length) return false; // unconfigured means closed, not open
  return prefixes.some((p) => repo === p || repo.startsWith(p + '/'));
}

/**
 * Project identity.
 *
 * The system this replaces slugged the LAST path segment only, so
 * `gitlab.com/acme/api` and `github.com/acme-labs/api` silently became one
 * project — pooling their events, findings and state, and inventing collisions
 * between unrelated codebases. Since a false collision is the one failure this
 * product cannot afford, identity now spans owner and name.
 */
export function defaultProject(repo: Repo): string {
  // Host included. Widening identity from "last segment" to "owner + name" was
  // not enough: github.com/acme/api and gitlab.com/acme/api still collapsed
  // into one project. Identity has to be total, because a false collision
  // between unrelated codebases is the one failure this product cannot afford.
  const [host, ...path] = repo.split('/');
  const forge = (host ?? '').split('.')[0] ?? '';
  const owner = path.length >= 2 ? [path[0]!, path[path.length - 1]!] : path;
  const parts = [forge, ...owner];
  const slug = parts
    .join('-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return slug || 'unassigned';
}

/** Directory of a path, including the trailing slash. `''` for a root file. */
export function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i + 1);
}

/** Display name for an actor: `henry@x.com` -> `Henry`. */
export function shortName(actor: string): string {
  const local = actor.split('@')[0] || actor;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

export function ago(ts: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - ts) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
