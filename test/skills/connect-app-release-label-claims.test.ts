/**
 * No skill may verify a CommCare release by waiting for a `Released - ` label
 * prefix, and no skill may cite the retired `/a/<org>/opportunity/init/` route
 * (dimagi-internal/ace#2185).
 *
 * ## The failure class
 *
 * `app-release` § Step 8 told a run to GET `/a/<connect_org>/opportunity/init/`
 * and watch the app dropdown label "change from `Unreleased - <name>` to
 * `Released - <name>`". Both halves were wrong, and only one of them was loud:
 *
 *   - The route 404s. Opportunity creation moved to a program-scoped,
 *     HYPHENATED, trailing-slash-free path
 *     (`/a/<org>/program/<pk>/opportunity-init`, `program/urls.py`). A 404 at
 *     least announces itself.
 *   - **The label prefix never existed.** Connect prefixes only the negative
 *     case — `app_name = f"Unreleased - {app_name}"` when no version carries
 *     `is_released` (`commcare_connect/utils/commcarehq_api.py`). A released
 *     app renders as a BARE name. So the step waited on a string the server
 *     cannot emit, and would have reported a correctly-released app as
 *     unreleased. Measured live 2026-09-07 on `connect-ace-prod`: 143 options,
 *     19 prefixed `Unreleased - `, ZERO `Released - `.
 *
 * The second half is the dangerous one and is invisible to any check that only
 * pings URLs, which is why it is pinned here as a content rule rather than
 * left to the next live probe.
 *
 * ## Why a content rule rather than a live probe
 *
 * The fact under test belongs to upstream SOURCE, not to a running server: it
 * is a formatting branch in one Django helper. A live probe re-observes it
 * noisily once; this asserts that ACE's own instructions never re-encode the
 * inverted claim. Negated mentions are explicitly allowed — the skill is
 * expected to SAY the prefix does not exist.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILLS_DIR = path.join(REPO_ROOT, 'skills');

function skillFiles(): string[] {
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(SKILLS_DIR, d.name, 'SKILL.md'))
    .filter((p) => fs.existsSync(p));
}

/** A window of prose immediately before an occurrence that refutes it. */
const NEGATION =
  /\b(no|not|never|zero|without|instead of|rather than|asserting the presence|404|retired|superseded|no longer)\b/i;

/**
 * Report the 1-based line of every unrefuted occurrence of `pattern`.
 *
 * A citation that REFUTES the thing it names ("…both 404", "there is no
 * `Released - ` prefix") is the whole point of the durable record, so a
 * NEGATION anywhere in the surrounding sentence exempts it. The window spans
 * both directions because these sentences wrap across lines.
 */
function unrefutedHits(text: string, pattern: RegExp): number[] {
  const hits: number[] = [];
  for (const m of text.matchAll(pattern)) {
    const window = text.slice(Math.max(0, m.index! - 220), m.index! + 200);
    if (NEGATION.test(window)) continue;
    hits.push(text.slice(0, m.index!).split('\n').length);
  }
  return hits;
}

/** Capital-R only: `Unreleased - ` is the REAL prefix and must stay searchable. */
const RELEASED_PREFIX = /(?<![A-Za-z])Released - /g;
const RETIRED_ROUTE = /\/opportunity\/init\//g;
const TRAILING_SLASH_WIZARD = /opportunity-init\//g;

/**
 * The step exactly as it shipped before ace#2185 — the known-bad input. If a
 * refactor ever makes the scans structurally unable to fire, these controls go
 * red before the repo-wide assertions quietly go green on everything.
 */
const DEFECTIVE_STEP_8 = [
  '8. **Verify Connect can see the release.**',
  '   Optional but recommended sanity check before Phase 4 starts:',
  '',
  '   - GET `/a/<connect_org>/opportunity/init/` (Connect side, via ace-connect MCP context)',
  '   - Look at the deliver_app dropdown options for `<hq_domain>`. The option',
  '     text should change from `Unreleased - <name>` to `Released - <name>`',
  '     once the release propagates.',
].join('\n');

describe('the scans can actually fail (negative + positive controls)', () => {
  it('NEGATIVE: flags the pre-ace#2185 Step 8 on both counts', () => {
    expect(unrefutedHits(DEFECTIVE_STEP_8, RELEASED_PREFIX)).not.toEqual([]);
    expect(unrefutedHits(DEFECTIVE_STEP_8, RETIRED_ROUTE)).not.toEqual([]);
  });

  it('NEGATIVE: flags a trailing-slash wizard citation', () => {
    expect(
      unrefutedHits('GET /a/<org>/program/<pk>/opportunity-init/ renders the form.', TRAILING_SLASH_WIZARD),
    ).not.toEqual([]);
  });

  it('POSITIVE: a refuting citation of either string is legal', () => {
    const record =
      'There is no `Released - ` prefix; Connect emits only `Unreleased - `. ' +
      'The old `/a/<org>/opportunity/init/` spelling returns 404.';
    expect(unrefutedHits(record, RELEASED_PREFIX)).toEqual([]);
    expect(unrefutedHits(record, RETIRED_ROUTE)).toEqual([]);
  });

  it('POSITIVE: the correct wizard route is not flagged', () => {
    expect(
      unrefutedHits('GET /a/<org>/program/<pk>/opportunity-init', TRAILING_SLASH_WIZARD),
    ).toEqual([]);
  });
});

describe('Connect release-visibility claims stay true to upstream', () => {
  const scanned = skillFiles().map((file) => ({
    rel: path.relative(REPO_ROOT, file),
    text: fs.readFileSync(file, 'utf8'),
  }));

  function offendersFor(pattern: RegExp): string[] {
    return scanned.flatMap(({ rel, text }) =>
      unrefutedHits(text, pattern).map((line) => `${rel}:${line}`),
    );
  }

  it('scans a non-trivial number of skills', () => {
    // Guards the whole describe: an empty corpus passes every assertion below.
    expect(scanned.length).toBeGreaterThan(20);
  });

  it('no skill instructs a `Released - ` label-prefix match', () => {
    expect(
      offendersFor(RELEASED_PREFIX),
      'A skill asserts a `Released - ` label prefix. Connect emits `Unreleased - ` ' +
        'for the negative case ONLY; a released app renders as a bare name ' +
        '(commcare_connect/utils/commcarehq_api.py). Waiting for `Released - ` ' +
        'reports a correctly-released app as unreleased — ace#2185.',
    ).toEqual([]);
  });

  it('no skill cites the retired /opportunity/init/ route', () => {
    expect(
      offendersFor(RETIRED_ROUTE),
      'The opportunity wizard is program-scoped and hyphenated: ' +
        'GET /a/<org>/program/<pk>/opportunity-init (no trailing slash). ' +
        '/a/<org>/opportunity/init/ returns 404 — ace#2185.',
    ).toEqual([]);
  });

  it('every `opportunity-init` citation omits the trailing slash', () => {
    expect(
      offendersFor(TRAILING_SLASH_WIZARD),
      'Django route is `<slug:pk>/opportunity-init` with no trailing slash; ' +
        'the trailing-slash form 404s (verified live 2026-09-07) — ace#2185.',
    ).toEqual([]);
  });
});

describe('app-release § Step 8 keeps the traps that made it wrong', () => {
  const text = fs.readFileSync(path.join(SKILLS_DIR, 'app-release/SKILL.md'), 'utf8');

  it('matches the app by id, not by label text', () => {
    expect(
      /match by app id/i.test(text),
      'Step 8 must resolve the option by its value-JSON `id`. A label-text ' +
        'match is what pinned the step to a wording that changed — ace#2185.',
    ).toBe(true);
  });

  it('records that an absent option is inconclusive, not a failure', () => {
    expect(
      /inconclusive/i.test(text),
      "Connect's get_application drops apps already bound to an active " +
        'opportunity, so a missing option is not evidence of a failed release ' +
        '— ace#2185.',
    ).toBe(true);
  });
});
