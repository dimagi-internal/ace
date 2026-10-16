import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACT_MANIFEST } from '../../lib/artifact-manifest';

/**
 * app-media-coverage's per-app outputs are per-app NAMES, and the manifest
 * registers exactly the names the skill writes (ace#2142).
 *
 * Two collisions with one root cause — per-app runs shared a name:
 *  - scratch: two concurrent per-app runs in one session rewrote each other's
 *    Content Generator inputs (`spark-facilitator/20260906-2233`);
 *  - report: the skill wrote `_report-<YYYY-MM-DD>.md`, so same-day Learn and
 *    Deliver runs wrote ONE file and find-or-update let the second replace the
 *    first (`smallholder-seasonal/20261014-0859`) — while the manifest
 *    registered `_report.md`, a name the skill never wrote, so the fence could
 *    not see the report at all.
 */

const SKILL = readFileSync(
  join(__dirname, '..', '..', 'skills', 'app-media-coverage', 'SKILL.md'),
  'utf8',
);
const APPS = ['learn', 'deliver'] as const;

function productsSection(md: string): string {
  const m = md.match(/^## Products\s*\n([\s\S]*?)(?=^## )/m);
  return m ? m[1] : '';
}

/** `3-commcare/app-media-coverage_<x>-<app>.<ext>` product templates, expanded per app. */
function perAppProducts(md: string): string[] {
  const out: string[] = [];
  for (const line of productsSection(md).split('\n')) {
    const lm = line.match(/^[-*] `(3-commcare\/app-media-coverage_(?:report|plan)-[^`]*)`/);
    if (!lm) continue;
    if (lm[1].includes('<app>')) for (const app of APPS) out.push(lm[1].replace('<app>', app));
    else out.push(lm[1]);
  }
  return out;
}

function registeredMediaPaths(): string[] {
  return ARTIFACT_MANIFEST.filter(
    (a) => a.producedBy === 'app-media-coverage' && /_(report|plan)-/.test(a.path),
  ).map((a) => a.path);
}

describe('app-media-coverage per-app paths (ace#2142)', () => {
  it('the manifest registers exactly the per-app report + plan names the skill declares', () => {
    expect(registeredMediaPaths().sort()).toEqual(perAppProducts(SKILL).sort());
  });

  it('NEGATIVE CONTROL: the shipped mismatch (`_report-<YYYY-MM-DD>.md` vs the manifest) is caught', () => {
    const before = SKILL.replace(
      '`3-commcare/app-media-coverage_report-<app>.md`',
      '`3-commcare/app-media-coverage_report-<YYYY-MM-DD>.md`',
    );
    expect(before).not.toEqual(SKILL);
    expect(perAppProducts(before).sort()).not.toEqual(registeredMediaPaths().sort());
  });

  it('no product or write step names a dated, app-less report', () => {
    expect(SKILL).not.toMatch(/app-media-coverage_report-<YYYY-MM-DD>/);
    expect(SKILL).toMatch(/Write the report to `3-commcare\/app-media-coverage_report-<app>\.md`/);
  });

  it('declares a per-app scratch root and routes every generator/prepare/classify path through it', () => {
    expect(SKILL).toMatch(/WORK="<scratch>\/app-media-coverage\/<opp>\/<app>"/);
    expect(SKILL).toMatch(/run-content-generator\.ts" "\$WORK\/gen\//);
    expect(SKILL).toMatch(/run-media-prepare\.ts" <file> --out-dir "\$WORK\//);
    expect(SKILL).toMatch(/run-media-classify\.ts" "\$WORK\//);
    // The pre-fix shape: an unqualified scratch file / bare `<input.json>`.
    expect(SKILL).not.toMatch(/write the listing to a scratch file/);
    expect(SKILL).not.toMatch(/<input\.json>/);
  });
});
