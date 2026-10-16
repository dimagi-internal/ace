import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The Phase 7 sweep handle `(synthetic, ace <opp>/<run-id>)` must never sit in
 * the NAME of a labs object a demo films (ace#2733).
 *
 * `demo-data-setup` § C7 used to say "Name every labs object with" the handle,
 * so the programme report's breadcrumb read "… (synthetic, ace
 * spark-facilitator/20261004-1706 v2)" on every frame and canopy's DDD
 * user-artifact judge scored it a trust defect (spark-facilitator/20261004-1706,
 * DDD run spark-facilitator-programme-cascade-2026-10-06-002; recurred on
 * smallholder-seasonal/20261012-1549). On noora-health/20261015-1129 the
 * handle in the synthetic opportunity's name put a real organisation's name on
 * a page framed as illustrative. Two rails read the same string; the handle
 * moves to `description` / `notes`, and the sweep matches there too.
 */
const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const demo = read('skills/demo-data-setup/SKILL.md');
const sweep = read('skills/sweep-labs/SKILL.md');

function section(text: string, start: string, end: string): string {
  const i = text.indexOf(start);
  expect(i, `missing section start: ${start}`).toBeGreaterThanOrEqual(0);
  const j = text.indexOf(end, i + start.length);
  return text.slice(i, j < 0 ? undefined : j);
}

describe('sweep handle stays off rendered names (ace#2733)', () => {
  it('§ C7 no longer tells the producer to NAME every labs object with the handle', () => {
    expect(demo).not.toMatch(/Name every labs object with\s+`\(synthetic, ace/);
  });

  it('§ C7 routes the handle for each rendered object to a non-rendered field', () => {
    const c7 = section(demo, '**Sweep handles.**', '**Known residuals');
    expect(c7).toMatch(/\| programme report workflow \|[^\n]*\| `description` \|/);
    expect(c7).toMatch(/\| opp reports[^\n]*\| `description` \|/);
    expect(c7).toMatch(/\| synthetic opportunity[^\n]*\| `notes` \|/);
  });

  it('§ C4 and § C1 put the handle in description / notes, not the name or label', () => {
    const c4 = section(demo, '**C4. Instantiate the trio.**', '**C5.');
    expect(c4).toMatch(/name: '<Programme> programme report \(synthetic\)'/);
    expect(c4).toMatch(/patch: \{description: '\(synthetic, ace <opp>\/<run-id>\)'\}/);
    const c1 = section(demo, '**C1. Create the synthetic programme.**', '**C2.');
    expect(c1).toMatch(/goes in `notes`/);
  });

  it('sweep-labs matches the handle in description and notes, not only name', () => {
    expect(sweep).toMatch(/`description`[^\n]*`notes`[^\n]*sweepHandleField/);
  });
});
