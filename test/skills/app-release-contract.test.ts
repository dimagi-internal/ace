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
 *
 * UPDATED FOR ace#1636 (2026-08-26), the fourth and last instance. Re-pointing
 * one reader at a time kept missing readers: #1567 demoted the `releases:`
 * block to corroboration here without noticing that `llo-launch`'s
 * app-verdict-freshness gate read it as a hard `[BLOCKER]` input. `app-release`
 * Step 7 was skipped on 2 of 2 observed runs, so that gate either halted
 * falsely or silently skipped the staleness check and let a stale deep app-UX
 * verdict authorize a go-live. The block is now RETIRED: Step 7 is deleted,
 * `llo-launch` reads `app-release_summary.md`'s `apps.<app>.build_id`, and this
 * rubric's corroborating leg is gone. So the shape assertions below flip from
 * "every `releases:` template agrees" to "no `releases:` template survives" —
 * a shape nobody writes cannot drift.
 *
 * The ownership rail proper is `deploy-summary-owns-no-release-state.test.ts`.
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

  it('sources release evidence from the owned artifact alone (ace#1636)', () => {
    // The corroborating leg is gone with the block. What must survive is the
    // instruction NOT to go looking for release evidence in app-deploy's file.
    expect(row).toMatch(/never look for release evidence there/i);
    expect(row).toMatch(/never deduct for its absence/i);
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

  it('claims sole ownership of released build state (ace#1636)', () => {
    // Was: "is_released lives HERE and not in the deploy summary's releases:
    // block". Now that the block is retired there is no rival location to
    // contrast against, so the contract states ownership positively — and
    // names the readers, which is what #1567 failed to enumerate.
    expect(producer).toMatch(/sole owner of released build\s+state/);
    for (const reader of ['app-release-eval', 'app-release-qa', 'llo-launch']) {
      expect(
        producer.slice(producer.indexOf('sole owner of released build')).slice(0, 500),
      ).toContain(reader);
    }
  });
});

describe('the releases: block is retired, not merely tolerated (ace#1636)', () => {
  /**
   * Was: "every `releases:` template agrees on one four-key shape" — three
   * declared shapes across two files for one block is what let the rubric
   * drift away from the producer unnoticed. The stronger answer is zero
   * templates: a shape nobody writes cannot drift, and a write with no reader
   * is not worth keeping alive.
   */
  const templates = (doc: string) => [...doc.matchAll(/releases:\n([\s\S]{0,400}?)```/g)];

  it('the producer no longer declares a releases: template', () => {
    expect(
      templates(producer).length,
      'app-release Step 7 wrote a `releases:` block into `app-deploy_summary.md`, ' +
        'an artifact app-deploy owns. It was skipped on 2 of 2 observed runs while ' +
        'the release itself was clean, and its only hard reader (llo-launch) now ' +
        'reads the owned artifact. Retired in ace#1636.',
    ).toBe(0);
  });

  it('the rubric no longer declares one either', () => {
    expect(templates(rubric).length).toBe(0);
  });
});
