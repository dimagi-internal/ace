/**
 * The CommCare APK release-asset filename is NOT predictable from the version.
 *
 * ## Why this test exists
 *
 * `runLocalBootstrap` probes a list of filename conventions and takes the
 * first that returns 200. The list has been wrong before: the `commcare-<v>.apk`
 * form was missing until 2026-07-25, so pinning the *published* 2.63.2 release
 * failed with `APK_DOWNLOAD_FAILED` — a failure indistinguishable from a
 * network fault at the point it bites.
 *
 * The standing assumption behind that list was "newest convention wins, older
 * ones are legacy fallbacks". Measured 2026-09-06 against the live 2.64.0
 * release, that assumption is FALSE — 2.64.0 REVERTED to the oldest form:
 *
 *   $ B=https://github.com/dimagi/commcare-android/releases/download/commcare_2.64.0
 *   $ curl -o /dev/null -w '%{http_code}' -L $B/commcare-2.64.0.apk          # 404
 *   $ curl -o /dev/null -w '%{http_code}' -L $B/commcare-2.64.0-release.apk  # 404
 *   $ curl -o /dev/null -w '%{http_code}' -L $B/app-commcare-release.apk     # 200
 *
 * So the naming is per-release and non-monotonic, and every convention must
 * stay in the probe list forever. A future cleanup that "removes the legacy
 * fallbacks" would break the CURRENT pin, not just old ones. That is the
 * regression this file prevents.
 *
 * ## Evidence class
 *
 * STATIC TEXT over `mcp/mobile/client.ts`. The network facts above were
 * measured once, by hand, and are recorded here as the justification; this
 * suite deliberately makes NO network call, so it stays hermetic and cannot
 * flake in CI. What it enforces is that the probe list still covers every
 * convention we have ever observed.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const CLIENT = path.join(__dirname, '../../..', 'mcp/mobile/client.ts');
const src = readFileSync(CLIENT, 'utf8');

/**
 * Every asset-filename convention Dimagi has shipped, with the release that
 * proves it. Add a row when a new one appears — never delete one.
 */
const OBSERVED_CONVENTIONS: ReadonlyArray<{ template: string; provenAt: string }> = [
  { template: '`${baseUrl}/commcare-${version}.apk`', provenAt: '2.63.2' },
  { template: '`${baseUrl}/commcare-${version}-release.apk`', provenAt: '2.63.0, 2.63.1' },
  { template: '`${baseUrl}/app-commcare-release.apk`', provenAt: '2.62.0, and again 2.64.0' },
];

describe('CommCare APK asset-filename conventions', () => {
  it.each(OBSERVED_CONVENTIONS)(
    'still probes $template (observed on $provenAt)',
    ({ template }) => {
      expect(src).toContain(template);
    },
  );

  it('probes every observed convention, so a per-release rename cannot strand a pin', () => {
    const list = src.match(/const candidateUrls = \[([\s\S]*?)\];/);
    expect(list, 'candidateUrls array not found in client.ts').not.toBeNull();
    const entries = (list as RegExpMatchArray)[1]
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('`'));
    expect(entries).toHaveLength(OBSERVED_CONVENTIONS.length);
  });

  it('records that 2.64.0 reverted to the 2.62.0 asset name', () => {
    // The non-monotonicity is the whole finding; if someone rewrites this
    // comment back to "2.63.2+ → commcare-<v>.apk" the next upgrade re-derives
    // a false rule from it.
    expect(src).toMatch(/2\.64\.0\s+→\s+`app-commcare-release\.apk`/);
  });

  it('does not claim 2.63.3 is a draft — it is published, with only an .aab', () => {
    // Refuted 2026-09-06 via `gh release view commcare_2.63.3`:
    //   {"isDraft":false,"isPrerelease":false,"assets":["app-lts-release.aab"]}
    // Someone re-deriving the old claim from `isDraft` would read false and
    // pin an unusable release. The correct test is "has an .apk asset".
    expect(src).not.toMatch(/2\.63\.3` exists as a\s*\n?\s*\* GitHub DRAFT/);
    expect(src).toMatch(/\.aab/);
  });
});
