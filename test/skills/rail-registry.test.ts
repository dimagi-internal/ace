import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  MEASUREMENT_PROVENANCE_BASELINE,
  RAILS,
  RAIL_DIRS,
  UNKNOWN_PROVENANCE_BASELINE,
  citationsIn,
  isRepoPolicingRail,
} from '../../lib/rail-registry';

/**
 * Every repo-policing rail must say where its defect was actually observed.
 *
 * ## The failure class
 *
 * ACE answers every incident by adding a rail. `CLAUDE.md` states that as
 * policy — *class-level preventers > instance-level fixes* — and it is right.
 * What has never existed is the other half: a rail has no provenance
 * requirement, no expiry and no removal path, so the apparatus only grows.
 * Measured on `main` today: 92 rails, added 1 / 3 / 3 / 41 / 44 per month from
 * April to September. It roughly quadrupled in two months.
 *
 * The cost is not the CI time. It is that a prune review is undecidable. To
 * retire a rail you need to know **what it prevented** and **whether it has
 * ever fired**, and neither is recorded anywhere, so nobody ever retires one
 * and the population grows monotonically whatever its quality.
 *
 * This rail closes the first half. `predictive-guard-citation` already demands
 * that a skill predicting ANOTHER system's behaviour cite the reproducer that
 * observed it; this applies the identical discipline to the rails themselves,
 * which are the one class of claim in the repo that has been exempt from it.
 *
 * ## What it does not do
 *
 * It records no firing history. That needs CI integration — which assertion
 * blocked which push — and a local approximation would be a number with
 * nothing behind it. The registry is the hook that hangs from; provenance
 * alone does not make a prune review decidable, it makes it possible.
 *
 * ## `unknown` is a finding
 *
 * Five rails have no discoverable provenance and are recorded as `unknown`
 * with a note saying what was searched. That is deliberate: an honest
 * `unknown` is the INPUT to the prune review — a rail nobody can attach to an
 * incident is the first candidate for deletion — while a plausible citation
 * invented to fill the field destroys the only signal the registry carries.
 * The count is ratcheted downward so `unknown` cannot become the escape hatch.
 *
 * Modelled on `test/skills/predictive-guard-citation.test.ts`, deliberately.
 */

const repoRoot = new URL('../..', import.meta.url).pathname;

function testFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...testFilesUnder(full));
    else if (entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** Rails as they exist on disk, keyed repo-relative. */
function railsOnDisk(): Map<string, string> {
  const found = new Map<string, string>();
  for (const dir of RAIL_DIRS) {
    for (const abs of testFilesUnder(join(repoRoot, dir))) {
      const src = readFileSync(abs, 'utf8');
      if (isRepoPolicingRail(src)) found.set(abs.slice(repoRoot.length).replace(/^\//, ''), src);
    }
  }
  return found;
}

const onDisk = railsOnDisk();

describe('every repo-policing rail declares where its defect was observed', () => {
  it('the registry matches the filesystem', () => {
    // A new rail cannot be added without a line here, and a deleted one
    // cannot leave a ghost entry behind. Enumerating from the tree rather
    // than trusting the list is the whole point: a hand-maintained registry
    // that nothing reconciles goes stale silently, which is the failure mode
    // one level up from the one this file is about.
    const registered = new Set(Object.keys(RAILS));
    const missing = [...onDisk.keys()].filter((f) => !registered.has(f)).sort();
    const ghosts = [...registered].filter((f) => !onDisk.has(f)).sort();

    expect(
      [
        ...missing.map((f) => `UNREGISTERED ${f}`),
        ...ghosts.map((f) => `NOT A RAIL ANY MORE ${f}`),
      ].join('\n  '),
      'lib/rail-registry.ts is out of step with the tree.\n\n' +
        'A new rail: add its path to RAILS with the issue where its defect was OBSERVED ' +
        '(and the run id, if there is one). If you cannot point at one, that is worth ' +
        'knowing before the rail ships, not after — say so in `unknown` and expect to ' +
        'justify it.\n\n' +
        'A ghost entry: the rail was deleted or is no longer repo-policing. Drop its line.\n',
    ).toBe('');
  });

  it('every entry declares provenance or an honest unknown, never both and never neither', () => {
    const offenders: string[] = [];
    for (const [file, p] of Object.entries(RAILS)) {
      const cited = p.issues.length > 0 || p.observed !== undefined || p.measurement !== undefined;
      if (cited && p.unknown !== undefined) {
        offenders.push(`${file}: declares BOTH provenance and \`unknown\` — pick one`);
      } else if (!cited && p.unknown === undefined) {
        offenders.push(`${file}: declares neither provenance nor \`unknown\``);
      } else if (!cited && !p.unknown?.trim()) {
        offenders.push(`${file}: \`unknown\` is empty — say what you searched and did not find`);
      }
    }
    expect(offenders.join('\n  '), 'Each rail says where its defect was observed, or says it cannot.').toBe('');
  });

  it('no declared citation is fabricated', () => {
    // The rule that makes the field worth having. A citation copied from
    // somewhere plausible is worse than an empty one: it reads as evidence and
    // is not. CLAUDE.md makes the same point about issue filings, and ace#1481
    // is the measured cost of ignoring it — an "all zero hits" claim about a
    // string that sits at templates/work-order-template.md:147.
    const offenders: string[] = [];
    for (const [file, p] of Object.entries(RAILS)) {
      const src = onDisk.get(file);
      if (src === undefined) continue; // the filesystem test above owns this
      const present = citationsIn(src);
      for (const issue of p.issues) {
        if (!present.issues.includes(issue)) {
          offenders.push(`${file}: declares ${issue}, which appears nowhere in the file`);
        }
      }
      if (p.observed !== undefined && !present.runs.includes(p.observed)) {
        offenders.push(`${file}: declares run ${p.observed}, which appears nowhere in the file`);
      }
      // A measurement is free text, so the anti-fabrication rule is stricter:
      // it must be quoted VERBATIM from the rail, which is what lets the next
      // reader find it and re-run it.
      if (p.measurement !== undefined) {
        const flat = (s: string) => s.replace(/\s+/g, ' ');
        if (!flat(src.replace(/^\s*\*/gm, '')).includes(flat(p.measurement))) {
          offenders.push(`${file}: declares a measurement its own file does not state verbatim`);
        }
      }
    }
    expect(
      offenders.join('\n  '),
      'A registry entry cites something its own rail does not mention. Cite what the rail ' +
        'actually records, or write the citation into the rail where the next reader will ' +
        'find it — an entry nobody can trace back is the same as no entry.\n',
    ).toBe('');
  });

  it('unknown provenance does not grow', () => {
    const unknown = Object.entries(RAILS)
      .filter(([, p]) => p.unknown !== undefined)
      .map(([f]) => f)
      .sort();

    expect(
      unknown.length,
      `${unknown.length} rails have no discoverable provenance (baseline ${UNKNOWN_PROVENANCE_BASELINE}):\n  ` +
        unknown.join('\n  ') +
        '\n\nA NEW rail may not join them. Point at the issue, the run, or the artifact ' +
        'where the defect was seen — if none exists, the honest question is whether the ' +
        'rail should exist, not how to record it.\n',
    ).toBeLessThanOrEqual(UNKNOWN_PROVENANCE_BASELINE);
  });

  it('the unknown baseline is a debt to pay down, not a floor to fill', () => {
    // Same one-directional contract as the sibling ratchets: attaching a rail
    // to its incident must lower the constant, or the slot silently re-opens
    // for the next uncited rail.
    const unknown = Object.values(RAILS).filter((p) => p.unknown !== undefined).length;
    expect(
      unknown === UNKNOWN_PROVENANCE_BASELINE ? '' : `actual ${unknown}, baseline ${UNKNOWN_PROVENANCE_BASELINE}`,
      'Rails gained provenance — lower UNKNOWN_PROVENANCE_BASELINE to lock the gain in.',
    ).toBe('');
  });

  it('measurement-backed provenance does not become the escape hatch', () => {
    // `measurement` exists so a rail commissioned from a population count can
    // say so instead of borrowing an issue number. It is free text, and free
    // text is how "declare provenance" decays into "write a sentence" — so it
    // is bounded the same way `unknown` is.
    const measured = Object.entries(RAILS)
      .filter(([, p]) => p.measurement !== undefined)
      .map(([f]) => f)
      .sort();
    expect(
      measured.length,
      `${measured.length} rails rest on a measurement rather than an incident (baseline ` +
        `${MEASUREMENT_PROVENANCE_BASELINE}):\n  ${measured.join('\n  ')}\n\n` +
        'A rail about ONE defect cites that defect. This form is for a rail about a ' +
        'population, and there are very few of those.\n',
    ).toBeLessThanOrEqual(MEASUREMENT_PROVENANCE_BASELINE);
  });

  it('the detector separates a rail from an ordinary unit test (negative control)', () => {
    // Without this, a rule that matched everything or nothing would pass every
    // assertion above and look like a healthy registry. Both strings are the
    // real shapes: the first is how test/skills/claims-authoring.test.ts reads
    // a SKILL.md, the second is how a per-skill checks.test.ts loads its own
    // fixture and tests a function.
    const rail = `const SKILL = readFileSync(join(process.cwd(), 'skills/inbox-triage/SKILL.md'), 'utf8');`;
    const unitTest = `const GOOD = readFileSync(join(__dirname, 'fixtures', 'good.md'), 'utf8');`;
    const noRead = `import { checkThing } from '../../skills/x/checks';`;

    expect(isRepoPolicingRail(rail), 'a test that reads a source tree IS a rail').toBe(true);
    expect(isRepoPolicingRail(unitTest), 'a test that reads its own fixture is NOT').toBe(false);
    expect(isRepoPolicingRail(noRead), 'importing a source module is not reading the repo').toBe(false);
  });
});
