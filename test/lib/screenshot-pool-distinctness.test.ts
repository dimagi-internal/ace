import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findAliasCollisions,
  classifyPoolDistinctness,
  describePoolCollisions,
  type PoolAsset,
} from '../../lib/screenshot-pool-distinctness.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// The founding instance (dimagi-internal/ace#1832), verified 2026-09-06 by
// fetching both Drive ids unauthenticated and hashing them:
//
//   $ curl -sL -o a.png "https://drive.google.com/uc?export=download&id=1nUv5Yw4Z4L3xyXCU9xYZvrQBk9cLZADC"
//   $ curl -sL -o b.png "https://drive.google.com/uc?export=download&id=1BqFXsUju_wFaIDYNsviTInBbOgGMzibp"
//   $ shasum -a 256 a.png b.png
//   b7b4eeac3d7e0f39c521999934e5b00c68e86dc409a9a3210ec4dca3407d61d2  a.png
//   b7b4eeac3d7e0f39c521999934e5b00c68e86dc409a9a3210ec4dca3407d61d2  b.png
//   $ cmp a.png b.png   # no output — identical
const CONNECT_HOME_SHA =
  'b7b4eeac3d7e0f39c521999934e5b00c68e86dc409a9a3210ec4dca3407d61d2';
// A genuinely different pool asset's digest, for the negative control. Any
// distinct value works — the check is equality between assets, never against a
// known constant — so this is a legible placeholder, not a claim about a file.
const CLAIM_OPP_SHA =
  '3f1a0c9e5b7d2846af10c3ee9b45d7620fe8813a4c5d6e7f8091a2b3c4d5e6f7';
const LEARN_INSTALL_SHA =
  '9c8b7a6f5e4d3c2b1a0908f7e6d5c4b3a291807f6e5d4c3b2a1908f7e6d5c4b3';

describe('screenshot-pool distinctness (ace#1832)', () => {
  describe('POSITIVE control — the real byte-identical pair', () => {
    const pool: PoolAsset[] = [
      { alias: 'connect-home', digest: CONNECT_HOME_SHA, source: 'live' },
      { alias: 'sync-button', digest: CONNECT_HOME_SHA, source: 'live' },
      { alias: 'claim-opp', digest: CLAIM_OPP_SHA, source: 'live' },
    ];

    it('finds exactly one collision, naming both aliases', () => {
      const collisions = findAliasCollisions(pool);
      expect(collisions).toHaveLength(1);
      expect(collisions[0].aliases).toEqual(['connect-home', 'sync-button']);
      expect(collisions[0].digest).toBe(CONNECT_HOME_SHA);
    });

    it('hard-FAILS the pool build and quarantines BOTH aliases', () => {
      const report = classifyPoolDistinctness(pool);
      expect(report.verdict).toBe('fail');
      // Not 'warn'. A warn is what a mislabelled asset survives.
      expect(report.quarantine).toEqual(['connect-home', 'sync-button']);
      // The uninvolved alias is untouched.
      expect(report.publishable).toEqual(['claim-opp']);
    });

    it('never elects a winner — a pool has no ordering that could justify one', () => {
      const report = classifyPoolDistinctness(pool);
      // Both colliding aliases are quarantined; neither is silently promoted.
      // This is the one behaviour that separates a pool from a journey, where
      // `lib/capture-manifest.ts` DOES elect a canonical frame.
      for (const alias of ['connect-home', 'sync-button']) {
        expect(report.publishable).not.toContain(alias);
      }
    });

    it('reports a cause an operator can act on', () => {
      const [line] = describePoolCollisions(findAliasCollisions(pool));
      expect(line).toContain('[BLOCKER]');
      expect(line).toContain('connect-home');
      expect(line).toContain('sync-button');
      expect(line).toContain('takeScreenshot');
    });
  });

  describe('NEGATIVE control — genuinely different screenshots must NOT trip', () => {
    const pool: PoolAsset[] = [
      { alias: 'connect-home', digest: CONNECT_HOME_SHA, source: 'live' },
      { alias: 'claim-opp', digest: CLAIM_OPP_SHA, source: 'live' },
      { alias: 'learn-install', digest: LEARN_INSTALL_SHA, source: 'live' },
    ];

    it('finds no collisions', () => {
      expect(findAliasCollisions(pool)).toEqual([]);
    });

    it('passes, quarantines nothing, publishes all three', () => {
      const report = classifyPoolDistinctness(pool);
      expect(report.verdict).toBe('pass');
      expect(report.quarantine).toEqual([]);
      expect(report.publishable).toEqual(['claim-opp', 'connect-home', 'learn-install']);
    });

    it('near-identical is not identical — one differing byte passes', () => {
      // Guards the failure mode where a well-meaning "similar enough" fuzz
      // (perceptual hash, size tolerance) gets bolted on later and starts
      // quarantining legitimately similar screens — two Connect screens share
      // a toolbar and a list, so almost every real pair is "similar".
      const nearly = CONNECT_HOME_SHA.slice(0, -1) + 'e';
      expect(nearly).not.toBe(CONNECT_HOME_SHA);
      expect(
        findAliasCollisions([
          { alias: 'connect-home', digest: CONNECT_HOME_SHA },
          { alias: 'sync-button', digest: nearly },
        ]),
      ).toEqual([]);
    });
  });

  describe('edge cases that would otherwise switch the check off', () => {
    it('un-hashed entries are ignored, not grouped into a false collision', () => {
      // Three aliases with no digest yet must NOT read as a 3-way collision.
      // A check that fires on absent evidence gets disabled within a run.
      const report = classifyPoolDistinctness([
        { alias: 'a', digest: '' },
        { alias: 'b', digest: '' },
        { alias: 'c', digest: CONNECT_HOME_SHA },
      ] as PoolAsset[]);
      expect(report.verdict).toBe('pass');
      expect(report.publishable).toEqual(['c']);
    });

    it('the same alias listed twice is one entry, not a self-collision', () => {
      expect(
        findAliasCollisions([
          { alias: 'connect-home', digest: CONNECT_HOME_SHA },
          { alias: 'connect-home', digest: CONNECT_HOME_SHA },
        ]),
      ).toEqual([]);
    });

    it('an empty pool passes', () => {
      const report = classifyPoolDistinctness([]);
      expect(report).toEqual({
        verdict: 'pass',
        collisions: [],
        quarantine: [],
        publishable: [],
      });
    });

    it('a three-way collision reports all three, sorted', () => {
      const collisions = findAliasCollisions([
        { alias: 'sync-button', digest: CONNECT_HOME_SHA },
        { alias: 'connect-home', digest: CONNECT_HOME_SHA },
        { alias: 'commcare-welcome', digest: CONNECT_HOME_SHA },
      ]);
      expect(collisions).toHaveLength(1);
      expect(collisions[0].aliases).toEqual([
        'commcare-welcome',
        'connect-home',
        'sync-button',
      ]);
    });
  });

  describe('the recipe-shaped CAUSE is pinned statically (no device needed)', () => {
    // The byte-identity is not bad luck — `03-sync-button.yaml` produces it by
    // construction, and that is readable from the file. Until the recipe is
    // repaired and re-validated on a device, this asserts the DEFECT is still
    // documented in the file rather than silently reordered by someone who
    // could not test it. When a device session fixes the recipe, this test
    // flips to asserting the capture follows the tap.
    const recipe = fs.readFileSync(
      path.join(ROOT, 'mcp/mobile/recipes/baseline/03-sync-button.yaml'),
      'utf-8',
    );

    it('still captures before its own sync tap — the duplicate is by construction', () => {
      // Line-anchored on the STEP (`- takeScreenshot:`), not a bare substring.
      // The defect banner at the top of the file quotes `takeScreenshot:
      // "sync-button"` in prose, so a substring search matches the banner —
      // always first in the file — and the assertion would hold no matter
      // where the real step sits. Caught by mutation-checking this very test:
      // reordering the recipe left it green.
      const lines = recipe.split('\n');
      const capture = lines.findIndex((l) => /^\s*-\s*takeScreenshot:\s*"sync-button"/.test(l));
      const tap = lines.findIndex((l) =>
        /^\s*id:\s*"org\.commcare\.dalvik:id\/action_sync"/.test(l),
      );
      expect(capture, 'the sync-button capture STEP (not the banner prose)').toBeGreaterThan(-1);
      expect(tap, 'the action_sync tap').toBeGreaterThan(-1);
      expect(
        capture,
        'If the capture now follows the tap, the ace#1832 repair has landed — ' +
          'flip this assertion to `toBeGreaterThan(tap)` and un-quarantine the ' +
          'alias in skills/common-screenshot-capture/SKILL.md.',
      ).toBeLessThan(tap);
    });

    it('the recipe carries the DEFECT banner so nobody re-derives it', () => {
      expect(recipe).toContain('ace#1832');
    });

    it('the alias is quarantined in the coverage table until then', () => {
      const skill = fs.readFileSync(
        path.join(ROOT, 'skills/common-screenshot-capture/SKILL.md'),
        'utf-8',
      );
      const row = skill
        .split('\n')
        .find((l) => l.startsWith('| `sync-button` |'));
      expect(row, 'the sync-button row in the Coverage table').toBeTruthy();
      expect(
        row,
        'sync-button must not be advertised as a live capture while its recipe ' +
          'produces a byte-identical copy of connect-home (ace#1832).',
      ).not.toMatch(/\|\s*Live\s*\|/);
      expect(row).toMatch(/QUARANTINED/i);
    });
  });
});
