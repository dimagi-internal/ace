import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Act tier is GRANTED to a named person, never inferred from a domain.
 *
 * `config/allowlist.txt` has no parser. Nothing executable reads it — not
 * `lib/`, `bin/`, `hooks/`, `mcp/` or `scripts/`, and not the shared canopy
 * engine; the only readers are prose (`skills/inbox-triage/SKILL.md`
 * § Counterpart tiers, and canopy's `agent-core/turn.md`), which an LLM follows
 * at triage time. The file's documented rule shapes ARE the whole contract, so
 * this test is the only thing standing between that contract and drift.
 *
 * Jon, 2026-09-11: "And then Sophie can tell you to trigger a run if she wants,
 * you don't need to check with me." That put a named dimagi-associate.com
 * counterpart — the poverty-graduation programme design author — into a tier
 * whose header read "Internal staff only". The invariant that actually matters
 * survived the rewording and is pinned here: run-steering is granted by an
 * operator to a NAMED person and written down, never inferred from a sender's
 * domain, and never derived from a run's own state (that is correspond tier).
 */

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const ALLOWLIST = 'config/allowlist.txt';
const NAMED_EXTERNAL = 'sfeintuch@dimagi-associate.com';

/** The two shapes the file documents: `@domain.com` or `user@domain.com`. */
const DOMAIN_RULE = /^@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const ADDRESS_RULE = /^[^@\s]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

const lines = () => read(ALLOWLIST).split('\n').map((l) => l.trim());
const rules = () => lines().filter((l) => l !== '' && !l.startsWith('#'));

/** The header is a `#`-prefixed block wrapped at ~78 columns. Strip the comment
 *  markers before matching so a pinned phrase can straddle a line break — the
 *  rule is what the sentence says, not where the margin fell. */
const prose = (s: string) =>
  s
    .split('\n')
    .map((l) => l.replace(/^\s*#\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ');

/** Prose files wrap at ~100 columns; same reason. */
const flat = (s: string) => s.replace(/\s+/g, ' ');

describe('allowlist act tier is granted per named person (Jon, 2026-09-11)', () => {
  it('every rule matches one of the two documented shapes', () => {
    for (const rule of rules()) {
      expect(
        DOMAIN_RULE.test(rule) || ADDRESS_RULE.test(rule),
        `"${rule}" is neither \`@domain.com\` nor \`user@domain.com\``,
      ).toBe(true);
    }
  });

  it('admits the named external counterpart as an EXACT address', () => {
    expect(rules()).toContain(NAMED_EXTERNAL);
    expect(ADDRESS_RULE.test(NAMED_EXTERNAL)).toBe(true);
  });

  it('never admits the associate domain wholesale', () => {
    expect(rules()).not.toContain('@dimagi-associate.com');
  });

  it('keeps internal staff on the domain rule', () => {
    expect(rules()).toContain('@dimagi.com');
  });

  it('every external-domain address carries a provenance comment above it', () => {
    const all = lines();
    const internal = /@dimagi\.com$/;

    for (const [i, line] of all.entries()) {
      if (!ADDRESS_RULE.test(line) || internal.test(line)) continue;

      // Walk back over the contiguous comment block immediately above the entry.
      const provenance: string[] = [];
      for (let j = i - 1; j >= 0 && all[j].startsWith('#'); j--) provenance.unshift(all[j]);
      const text = provenance.join(' ');

      expect(provenance.length, `${line} has no provenance comment above it`).toBeGreaterThan(0);
      expect(text, `${line}: the comment must name who authorized it`).toMatch(/authorized by/i);
      expect(text, `${line}: the comment must carry a date`).toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(text, `${line}: the comment must scope it to the individual`).toMatch(
        /named individual/i,
      );
    }
  });

  it('the header states granted-not-inferred and drops the internal-only claim', () => {
    const header = prose(read(ALLOWLIST));
    expect(header).toMatch(/Membership is GRANTED by an operator and written down here/);
    expect(header).toMatch(/never inferred at triage time/);
    expect(header).toMatch(/never derived from a run's own state \(that is correspond\)/);
    expect(header).toMatch(/admitted only as ONE exact address, with a comment naming who/);
    expect(header, 'the superseded claim must not survive').not.toMatch(/Internal staff only/);
  });

  it('the header still documents both rule shapes and # comments', () => {
    const header = prose(read(ALLOWLIST));
    expect(header).toContain('`@domain.com` (whole domain) or `user@domain.com` (one address)');
    expect(header).toContain('Comments start with #.');
  });

  it('the header does not weaken the correspond tier', () => {
    const header = prose(read(ALLOWLIST));
    expect(header).toMatch(/derived at triage time from the routed run's state/);
    expect(header).toMatch(/never run-state mutations/);
  });
});

describe('inbox-triage § Counterpart tiers carries the same rule', () => {
  const tiers = () => {
    const doc = read('skills/inbox-triage/SKILL.md');
    return flat(
      doc.slice(doc.indexOf('## Counterpart tiers'), doc.indexOf('## Noise classification')),
    );
  };

  it('says act tier is maintained, not derived, and operator-authorized', () => {
    const t = tiers();
    expect(t, '§ Counterpart tiers not found').not.toBe('');
    expect(t).toMatch(/act-tier sender is the inverse — \*maintained, not derived\*/);
    expect(t).toMatch(/An operator may authorize a NAMED/);
    expect(t).toContain('config/allowlist.txt');
    expect(t).toMatch(/one exact address with a comment recording who granted it and when/);
  });

  it('bans the in-turn judgement and the whole-domain grant', () => {
    const t = tiers();
    expect(t).toMatch(/never as an in-turn judgement/);
    expect(t).toMatch(/never as a whole domain/);
    expect(t).toMatch(/Not in the file, not act tier/);
  });

  it('cites its origin', () => {
    expect(tiers()).toMatch(/Origin: Jon, 2026-09-11/);
  });

  it('does not weaken the correspond rule', () => {
    const t = tiers();
    expect(t).toMatch(/\*\*Never\*\* run-state mutations/);
    expect(t).toMatch(/correspond-tier sender is \*derived, not maintained\*/);
    expect(t, '"internal-only" is superseded by "act-tier-only"').not.toMatch(
      /run management is internal-only/,
    );
  });
});
