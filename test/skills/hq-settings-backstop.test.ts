/**
 * Seam test for dimagi-internal/ace#1009.
 *
 * `app-hq-settings` applies standing-instruction settings to the CCHQ DRAFT
 * app and then names `app-release-qa` as the downstream backstop that
 * re-verifies them on the RELEASED artifact. Nothing checked that the claim
 * was true — and for grid menu display it was false on both halves:
 * `app-release-qa` had no grid check at all, and grid is not observable in
 * the CCZ in the first place (`suite.xml` emits a bare `<menu id="mN">`).
 * The setting shipped with ZERO downstream verification, which is exactly
 * the "applied but never verified" shape #867 / #971 / #994 exist to prevent.
 *
 * The test reads the backstop table `app-hq-settings` publishes and asserts,
 * for every row, that `app-release-qa` actually names that halt class — both
 * as a check in its Process and as an entry in its Failure modes. Same
 * seam-disagreement class as #994: two skills each individually plausible,
 * disagreeing about a contract neither one owns alone.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SKILLS = fileURLToPath(new URL('../../skills/', import.meta.url));

const hqSettings = readFileSync(`${SKILLS}app-hq-settings/SKILL.md`, 'utf8');
const releaseQa = readFileSync(`${SKILLS}app-release-qa/SKILL.md`, 'utf8');

interface BackstopRow {
  setting: string;
  surface: string;
  haltClass: string;
}

/**
 * Parse the `| Setting | Backstop surface | Halt class |` table out of
 * `app-hq-settings`. That table IS the claim under test — if someone adds a
 * setting to it without wiring a check in `app-release-qa`, this fails.
 */
function parseBackstopTable(md: string): BackstopRow[] {
  const lines = md.split('\n');
  const headerIdx = lines.findIndex(
    (l) => /\|\s*Setting\s*\|/.test(l) && /Halt class/.test(l),
  );
  if (headerIdx === -1) return [];
  const rows: BackstopRow[] = [];
  // Skip the header and the `|---|---|---|` separator.
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) break;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 3) break;
    const haltClass = (cells[2].match(/`([a-z0-9-]+)`/) ?? [])[1];
    if (!haltClass) continue;
    rows.push({ setting: cells[0], surface: cells[1], haltClass });
  }
  return rows;
}

describe('app-hq-settings ↔ app-release-qa backstop seam (ace#1009)', () => {
  const rows = parseBackstopTable(hqSettings);

  it('app-hq-settings publishes a backstop table with a halt class per setting', () => {
    expect(
      rows.length,
      'app-hq-settings must declare, per setting, WHICH surface backstops it and ' +
        'WHICH halt class fires — a prose claim like "app-release-qa re-verifies ' +
        'both from the released suite.xml" is what ace#1009 was.',
    ).toBeGreaterThanOrEqual(2);
    const settings = rows.map((r) => r.setting.toLowerCase()).join(' ');
    expect(settings).toMatch(/camera-only/);
    expect(settings).toMatch(/grid/);
  });

  it.each(rows.map((r) => [r.setting, r.haltClass] as const))(
    'app-release-qa actually implements the backstop for %s (halt class: %s)',
    (setting, haltClass) => {
      // Named in the Process (the check exists) …
      const processHalf = releaseQa.split('## Failure modes')[0];
      expect(
        processHalf.includes(haltClass),
        `app-hq-settings claims ${setting} is backstopped by ${haltClass}, but ` +
          `app-release-qa's Process never names it. A claimed backstop that ` +
          `does not exist is worse than no backstop.`,
      ).toBe(true);
      // … and documented as a failure mode (the operator knows what to do).
      const failureHalf = releaseQa.split('## Failure modes')[1] ?? '';
      expect(
        failureHalf.includes(haltClass),
        `${haltClass} is checked but has no entry under app-release-qa's ` +
          `## Failure modes, so a halt gives the operator no remediation.`,
      ).toBe(true);
    },
  );

  it('the grid check is NOT sourced from suite.xml or the read-only REST API', () => {
    // The two intuitive surfaces both lie: suite.xml has no style attribute at
    // all, and GET /api/v0.5/application/ serializes only 5 module keys, so it
    // reads a misleading `None` for a correctly-gridded module. Grid must come
    // from the raw app doc.
    const gridSection = releaseQa.slice(
      releaseQa.indexOf('Grid menu display'),
      releaseQa.indexOf('Constraint locality'),
    );
    expect(gridSection.length).toBeGreaterThan(0);
    expect(gridSection).toMatch(/apps\/source\//);
    expect(gridSection).toMatch(/display_style/);
    // And it must warn about both traps, so the next reader doesn't fall in.
    expect(gridSection).toMatch(/suite\.xml/);
    expect(gridSection).toMatch(/api\/v0\.5\/application/);
  });
});
