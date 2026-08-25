// A structural guard, not a behavioural one.
//
// `presence()` shipped with `?1`/`?2` numbered placeholders, which better-sqlite3
// rejects at RUNTIME with "Too many parameter values were provided". Typecheck
// passed, 100 tests passed, and the failure only appeared when a real request
// hit an untested endpoint. This test reads the source and makes that class of
// mistake impossible to merge.
import { expect, test } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src', import.meta.url).pathname;
const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));

test('no numbered SQL placeholders anywhere in src', () => {
  const offenders: string[] = [];
  for (const f of files) {
    readFileSync(join(SRC, f), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        // `?1`, `?2`, … in a SQL context. Ignore TS optional-chaining/ternaries
        // by requiring the digit to be followed by a non-identifier character.
        if (/\?\d+\b/.test(line) && !line.trimStart().startsWith('//')) {
          offenders.push(`${f}:${i + 1}: ${line.trim()}`);
        }
      });
  }
  expect(offenders).toEqual([]);
});

test('every SQL LIKE is paired with an ESCAPE clause', () => {
  const offenders: string[] = [];
  for (const f of files) {
    readFileSync(join(SRC, f), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const trimmed = line.trimStart();
        // Skip prose: comment lines, and identifiers such as SCP_LIKE.
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
        if (!/(?<![\w_])LIKE\s/.test(line)) return;
        if (!/ESCAPE\s+'\\\\'/.test(line)) offenders.push(`${f}:${i + 1}: ${trimmed}`);
      });
  }
  expect(offenders).toEqual([]);
});
