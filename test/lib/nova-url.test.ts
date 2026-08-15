/**
 * ace#1431 — three places templated the Nova URL independently and disagreed.
 * `app-deploy` used the working `/build/` route and carried a comment saying
 * the upstream summaries were wrong; the two producers kept emitting the
 * legacy `/apps/` route, which 404s, in every build-summary frontmatter.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { novaAppUrl, isNovaAppUrl, NOVA_BASE_URL } from '../../lib/nova-url';

const REPO = join(__dirname, '../..');

describe('novaAppUrl', () => {
  it('builds the working /build/ route', () => {
    expect(novaAppUrl('abc123')).toBe('https://commcare.app/build/abc123');
  });

  it('never builds the legacy /apps/ route', () => {
    expect(novaAppUrl('abc123')).not.toContain('/apps/');
  });

  it('isNovaAppUrl accepts what the builder produces and rejects the legacy form', () => {
    expect(isNovaAppUrl(novaAppUrl('x'), 'x')).toBe(true);
    expect(isNovaAppUrl(`${NOVA_BASE_URL}/apps/x`, 'x')).toBe(false);
  });

  it('rejects a URL built for a different app id', () => {
    expect(isNovaAppUrl(novaAppUrl('a'), 'b')).toBe(false);
  });
});

describe('no skill or agent prescribes the dead route (ace#1431)', () => {
  /** Every SKILL.md / agent doc, so a new producer can't reintroduce it. */
  function docs(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(join(REPO, dir))) {
      const rel = `${dir}/${e}`;
      const st = statSync(join(REPO, rel));
      if (st.isDirectory()) docs(rel, out);
      else if (e.endsWith('.md')) out.push(rel);
    }
    return out;
  }

  const offenders = [...docs('skills'), ...docs('agents')].filter((rel) => {
    const text = readFileSync(join(REPO, rel), 'utf8');
    // Only flag a PRESCRIPTION. A line explaining that /apps/ is dead is
    // exactly what we want to keep.
    return text
      .split('\n')
      .some((l) => /commcare\.app\/apps\//.test(l) && !/404|legacy|not the|never/i.test(l));
  });

  it('none', () => {
    expect(offenders).toEqual([]);
  });
});
