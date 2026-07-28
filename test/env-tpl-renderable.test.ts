/**
 * `.env.tpl` must stay renderable by `op inject`.
 *
 * `op inject` is ALL-OR-NOTHING and scans the WHOLE file: one malformed
 * secret reference makes the entire render fail and write an EMPTY .env for
 * every consumer. It does not skip `#` lines, so a bare op-scheme reference
 * written into a COMMENT — to document the convention, say — aborts the render
 * exactly as a broken real reference would.
 *
 * That is not hypothetical. #1000 ("move ACE onto its own Agent-Ace vault")
 * documented the new convention with a literal placeholder reference inside a
 * comment. Every real reference in the file resolved fine; the comment alone
 * made `op inject` exit with
 *
 *     invalid secret reference 'op://Agent-': too few '/'
 *
 * and write ZERO bytes. Verified on the cloud runner 2026-07-28: `~/.ace/.env`
 * had been stale since 2026-07-27, so every headless ACE turn there ran with no
 * MCP credentials at all. The file's own comment warns about this trap three
 * lines below where it was introduced — a comment is evidently not enough.
 *
 * These checks are pure text: no 1Password, no network, no `op` binary, so they
 * run in CI on every PR. They do NOT verify that a reference RESOLVES — that
 * needs live vault access and stays `/ace:doctor`'s env_tpl_render probe.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const TPL = join(__dirname, '..', '.env.tpl');
// Built rather than written literally, so this file is not itself a violation
// of the rule it enforces (the checks below scan .env.tpl, but keeping the
// literal out of the repo entirely is what stops a future copy-paste from
// reintroducing it somewhere that IS scanned).
const SCHEME = `op:${'/'}${'/'}`;

function lines(): { n: number; text: string }[] {
  return readFileSync(TPL, 'utf8')
    .split('\n')
    .map((text, i) => ({ n: i + 1, text }));
}

describe('.env.tpl stays renderable by op inject', () => {
  it('has no op-scheme reference inside a comment', () => {
    const offenders = lines()
      .filter(({ text }) => text.trimStart().startsWith('#') && text.includes(SCHEME))
      .map(({ n, text }) => `  line ${n}: ${text.trim()}`);

    expect(
      offenders,
      `op inject scans comments too and aborts on a malformed reference in one,\n` +
        `writing an EMPTY .env for every consumer. Describe the convention in\n` +
        `words instead of writing a literal reference:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('every op-scheme reference names a vault, an item and a field', () => {
    // The shape `op://<vault>/<item>/<field>` — at least two '/' after the
    // scheme. This is precisely what the failure above tripped: `op://Agent-`
    // has none. Values may be quoted and items/fields may contain spaces.
    const bad: string[] = [];
    for (const { n, text } of lines()) {
      if (text.trimStart().startsWith('#')) continue; // covered by the test above
      const eq = text.indexOf('=');
      if (eq < 0) continue;
      const value = text.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!value.startsWith(SCHEME)) continue;
      const path = value.slice(SCHEME.length);
      const parts = path.split('/').filter((p) => p.length > 0);
      if (parts.length < 3) bad.push(`  line ${n}: ${text.trim()}`);
    }
    expect(
      bad,
      `a reference must be ${SCHEME}<vault>/<item>/<field>:\n${bad.join('\n')}`,
    ).toEqual([]);
  });

  it('every uncommented assignment resolves to a secret reference or a literal, never an empty value', () => {
    // A `KEY=` with nothing after it renders an empty variable rather than
    // failing, which is the quiet half of the same problem: the consumer sees
    // the key as "set" and misbehaves instead of reporting it missing.
    const empty = lines()
      .filter(({ text }) => /^[A-Z][A-Z0-9_]*=\s*$/.test(text))
      .map(({ n, text }) => `  line ${n}: ${text.trim()}`);
    expect(empty, `leave a not-yet-ready key COMMENTED OUT:\n${empty.join('\n')}`).toEqual([]);
  });
});
