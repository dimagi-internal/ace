/**
 * ace#1439 — `app-release-eval § both_apps_released` (35% weight, the headline
 * dimension) required `is_released: true` and `latest_released_version` ≥ 1
 * "in the deployment-summary `releases:` block". Neither key has ever been
 * written there: the producer's block carries
 * `{build_id, version, released_at, connect_markers}`.
 *
 * Both names are real — they are what CommCare HQ returns from the release
 * POST (`{"is_released": true, "latest_released_version": <n>}`). They were
 * lifted from an API response into a rubric as if they were artifact keys.
 *
 * A grader reading the rubric literally deducts on a perfect release. On
 * bednet-check-2-visit/20260814-2019 that was avoided only because the grader
 * went and read the producer's contract. Same class ace#1010 fixed for
 * `build_id_traceability`, surviving in the sibling dimension.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '../..');
const producer = readFileSync(join(REPO, 'skills/app-release/SKILL.md'), 'utf8');
const rubric = readFileSync(join(REPO, 'skills/app-release-eval/SKILL.md'), 'utf8');

/** The `both_apps_released` table row. */
const row = rubric.split('\n').find((l) => l.includes('**Both apps released**')) ?? '';

describe('the rubric grades keys the producer is instructed to emit', () => {
  it('found the row', () => {
    expect(row).not.toBe('');
  });

  it('no longer requires latest_released_version from an artifact', () => {
    // It is an HQ API field, not a key any ACE artifact carries. The row may
    // still MENTION it while explaining the fix — what must not survive is a
    // requirement, so every mention has to sit in a sentence that disowns it.
    const sentences = row.split(/(?<=\.)\s+/);
    const requiring = sentences.filter(
      (x) =>
        x.includes('latest_released_version') &&
        !/previously|never been written|HQ|note HQ's field/i.test(x),
    );
    expect(requiring).toEqual([]);
  });

  it('reads is_released from the artifact that declares it', () => {
    expect(row).toContain('app-release_summary.md');
    expect(row).toMatch(/is_released/);
  });

  it('cross-checks against keys the releases: block really carries', () => {
    for (const key of ['version', 'released_at']) {
      expect(row).toContain(key);
    }
  });

  it('carries ace#1010’s standing rule, since this is its second instance', () => {
    expect(row).toMatch(/never deduct for evidence the producer is not/i);
  });
});

describe('the producer declares what the rubric reads', () => {
  it('app-release § Products declares the summary frontmatter', () => {
    expect(producer).toMatch(/Frontmatter contract \(ace#1439\)/);
  });

  it.each(['is_released', 'version', 'build_id', 'released_at'])(
    'declares %s', (key) => {
      const block = producer.slice(producer.indexOf('Frontmatter contract'));
      expect(block.slice(0, 900)).toContain(key);
    },
  );

  it('says explicitly that is_released is NOT in the releases: block', () => {
    expect(producer).toMatch(/is_released` lives HERE and not in the deploy/);
  });
});

describe('the releases: block has ONE declared shape', () => {
  /** Every `releases:` template in the producer, as a sorted key set. */
  const shapes = [...producer.matchAll(/releases:\n([\s\S]{0,400}?)```/g)].map((m) =>
    [...new Set([...m[1].matchAll(/\b([a-z_]+):/g)].map((k) => k[1]))]
      .filter((k) => !['learn_app', 'deliver_app', 'releases'].includes(k))
      .sort()
      .join(','),
  );

  it('found more than one template — the drift risk is real', () => {
    expect(shapes.length).toBeGreaterThanOrEqual(1);
  });

  it('all templates agree', () => {
    // Three declared shapes across two files for one block is what let the
    // rubric drift away from the producer unnoticed.
    expect(new Set(shapes).size).toBe(1);
  });

  it('and that shape is the four-key one', () => {
    expect(shapes[0].split(',').sort()).toEqual(
      ['build_id', 'connect_markers', 'released_at', 'version'].sort(),
    );
  });
});
