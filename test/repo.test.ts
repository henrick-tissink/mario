import { describe, expect, test } from 'vitest';
import { normaliseRepo, inScope, defaultProject, dirOf, ago, shortName } from '../src/repo';

// Tests compare against plain strings; the branded type is a source-side
// guarantee, not something the assertions need.
const R = (s: string | null): string | null => normaliseRepo(s);
const Rq = (s: string) => normaliseRepo(s)!;

describe('normaliseRepo', () => {
  test('scp-style remotes', () => {
    expect(R('git@gitlab.com:acme/widgets.git')).toBe('gitlab.com/acme/widgets');
    expect(R('git@gitlab.com:acme/widgets/core.git')).toBe(
      'gitlab.com/acme/widgets/core',
    );
  });

  test('https remotes', () => {
    expect(R('https://github.com/acme-labs/atlas.git')).toBe('github.com/acme-labs/atlas');
    expect(R('https://github.com/acme-labs/atlas')).toBe('github.com/acme-labs/atlas');
  });

  test('keeps host and full path, so subgroups survive', () => {
    expect(R('git@gitlab.com:a/b/c/d.git')).toBe('gitlab.com/a/b/c/d');
  });

  test('lowercases', () => {
    expect(R('git@GitLab.com:Acme/Widgets.git')).toBe('gitlab.com/acme/widgets');
  });

  // The three regressions this function exists to prevent.
  test('an explicit port is dropped, not turned into a path segment', () => {
    expect(R('https://host.example:8443/org/repo')).toBe('host.example/org/repo');
    expect(R('ssh://git@host.example:2222/org/repo.git')).toBe('host.example/org/repo');
  });

  test('an @ in the path does not truncate it', () => {
    expect(R('https://gitlab.com/acme/some@repo')).toBe('gitlab.com/acme/some@repo');
  });

  test('userinfo cannot smuggle a different host into scope', () => {
    // The classic fail-open: a naive `^[^@]+@` strip yields gitlab.com/acme/x.
    expect(R('https://github.com/evil@gitlab.com/acme/x')).toBe(
      'github.com/evil@gitlab.com/acme/x',
    );
    expect(R('https://evil@github.com/acme/x')).toBe('github.com/acme/x');
  });

  test('rejects anything that is not owner/name', () => {
    expect(R('')).toBeNull();
    expect(R(null)).toBeNull();
    expect(R('   ')).toBeNull();
    expect(R('justaword')).toBeNull();
    expect(R('https://github.com/onlyowner')).toBeNull();
  });
});

describe('inScope', () => {
  const allow = ['gitlab.com/acme', 'github.com/acme-labs'];

  test('matches a prefix on a segment boundary', () => {
    expect(inScope(Rq('gitlab.com/acme/widgets'), allow)).toBe(true);
    expect(inScope(Rq('gitlab.com/acme/devex/mario'), allow)).toBe(true);
  });

  test('matches the prefix exactly', () => {
    expect(inScope('gitlab.com/acme' as ReturnType<typeof Rq>, allow)).toBe(true);
  });

  test('does not match a partial segment', () => {
    expect(inScope(Rq('gitlab.com/acme-evil/x'), allow)).toBe(false);
  });

  test('tolerates a trailing slash in configuration', () => {
    expect(inScope(Rq('gitlab.com/acme/widgets'), ['gitlab.com/acme/'])).toBe(true);
  });

  test('fails closed', () => {
    expect(inScope(Rq('gitlab.com/acme/widgets'), [])).toBe(false);
    expect(inScope(Rq('gitlab.com/acme/widgets'), ['  ', ''])).toBe(false);
    expect(inScope(null, allow)).toBe(false);
    expect(inScope(Rq('github.com/someone/personal'), allow)).toBe(false);
  });
});

describe('defaultProject', () => {
  test('spans owner and name, so same-named repos stay separate', () => {
    expect(defaultProject(Rq('gitlab.com/acme/api'))).toBe('gitlab-acme-api');
    expect(defaultProject(Rq('github.com/acme-labs/api'))).toBe('github-acme-labs-api');
    expect(defaultProject(Rq('gitlab.com/acme/api'))).not.toBe(
      defaultProject(Rq('github.com/acme-labs/api')),
    );
  });

  test('the same owner/name on two forges are DIFFERENT projects', () => {
    // Widening identity from "last segment" to "owner + name" was not enough.
    expect(defaultProject(Rq('github.com/acme/api'))).not.toBe(
      defaultProject(Rq('gitlab.com/acme/api')),
    );
  });

  test('uses first and last segment for nested subgroups', () => {
    expect(defaultProject(Rq('gitlab.com/acme/devex/mario'))).toBe('gitlab-acme-mario');
  });

  test('slugifies', () => {
    expect(defaultProject(Rq('gitlab.com/Acme_Corp/Some.Repo'))).toBe('gitlab-acme-corp-some-repo');
  });
});

describe('helpers', () => {
  test('dirOf keeps the trailing slash and returns empty for a root file', () => {
    expect(dirOf('src/pricing/refunds.ts')).toBe('src/pricing/');
    expect(dirOf('README.md')).toBe('');
  });

  test('shortName', () => {
    expect(shortName('henry@acme.co')).toBe('Henry');
    expect(shortName('sam')).toBe('Sam');
  });

  test('ago ladder', () => {
    const now = 1_000_000_000_000;
    expect(ago(now, now)).toBe('just now');
    expect(ago(now - 5 * 60_000, now)).toBe('5m ago');
    expect(ago(now - 90 * 60_000, now)).toBe('2h ago');
    expect(ago(now - 72 * 3_600_000, now)).toBe('3d ago');
    expect(ago(now + 5000, now)).toBe('just now'); // clock skew floors at 0
  });
});
