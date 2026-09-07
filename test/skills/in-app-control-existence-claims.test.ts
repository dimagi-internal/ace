import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ACE's authoring corpus may not assert that an in-app GRIEVANCE control
 * EXISTS without citing the run evidence that observed it.
 *
 * ## The failure class (dimagi-internal/ace#2106)
 *
 * `skills/_training-template.md § Support channel` told every worker-facing
 * producer to route escalation to *"the app's own in-app grievance route (the
 * **GRM menu**), which the PDD already designates as the complaint channel"* —
 * stated as settled fact, not conditioned on anything. It was false twice:
 *
 *   - **No app has the control.** The released Deliver CCZ of
 *     `hh-poverty-targeting` (HQ `ce668763ad6c4b48ac5f4cd4502f3f8c`, domain
 *     `connect-ace-prod`) greps zero for
 *     `grievance|GRM|complaint|report a problem|report an issue` across
 *     `suite.xml`, `modules-0/forms-0.xml` and both `app_strings.txt`. Its
 *     entire menu is one module (`Household Visit`) and one form. A live
 *     `uiautomator` dump on `bednet-check-2-visit/20260902-1555` under
 *     Connect APK 2.64.0 returned six unrelated entries and no grievance
 *     route.
 *   - **No PDD designates one, and none is asked to.**
 *     `templates/pdd-template.md` and both shipped example PDDs grep zero;
 *     the template has no grievance section at all. Two distinct live PDDs
 *     (hh-poverty-targeting, bednet-check-2-visit) grep zero for a grievance
 *     channel — the sole hit is the word "complaint" used idiomatically
 *     inside a form-constraint ruling.
 *
 * This is the EXISTENCE-side twin of
 * `test/skills/predictive-guard-citation.test.ts`. That rail refuses a claim
 * that an external system *rejects* something without a reproducer; this one
 * refuses a claim that an external control *exists* without one. Same failure
 * mode, opposite polarity — and this half was untested.
 *
 * ## Why the scan is the whole corpus, not `_training-template.md`
 *
 * The claim did not stay in the template it was written in. It reached NINE
 * sites: three skills carried a literal instruction or QA criterion, three
 * more listed "support contact + GRM escalation route" as a PDD field to read
 * (a field the PDD template does not have), and `lib/support-channel-guard.ts`
 * put it in the guard's own remediation MESSAGE — so a producer that failed
 * the support-channel check was told to insert the false claim.
 *
 * That last one is why this file scans `.ts` as well as `.md`. ace#1884 is the
 * precedent: `gate-brief` survived a "complete" removal in fifteen files
 * because it lived on as a prose destination, invisible to the filename regex
 * meant to catch it. A template is exactly the surface an absent concept
 * regrows from, and a scan narrower than the corpus cannot see the regrowth.
 *
 * ## Why a citation is the escape hatch rather than a ban
 *
 * The concept must remain NAMEABLE — this test names it, the corrected
 * template explains it, and a future opportunity that genuinely builds a
 * grievance form must be able to document it. So an occurrence passes if an
 * issue number, an ACE run id, or the word "repro" sits on or beside its line,
 * exactly as the sibling rail does it. The ±1-line window makes the citation
 * belong to the claim rather than to a nearby changelog table.
 *
 * Unlike the sibling, this one runs at ZERO baseline: every site was cleaned
 * in the PR that added it, so there is no debt to pay down and any new
 * uncited occurrence fails.
 */

/**
 * The claim shape is SHARED with the runtime guard rather than re-spelled
 * here. Two reasons, one of them learned the hard way in this very file: a
 * first draft matched the bare word `grievance`, which flagged fifteen lines
 * of the corrected prose explaining that the control does not exist — the
 * always-fires-blocker class (ace#1026) aimed at its own remedy. Sharing
 * `claimsInAppGrievanceControl` means the rail catches the INSTRUCTIONAL
 * shape only, inherits the negation exclusion, and cannot drift from what the
 * runtime guard actually rejects.
 */
import { claimsInAppGrievanceControl } from '../../lib/support-channel-guard.js';

const CLAIM = { test: (line: string) => claimsInAppGrievanceControl(line) !== null };

/** Same shape as predictive-guard-citation.test.ts: tracker ref, run id, or "repro". */
const CITATION = /#\d{3,4}|20\d{6}-\d{4}|repro/i;
const CONTEXT_LINES = 1;

const repoRoot = new URL('../..', import.meta.url).pathname;

/**
 * The authoring corpus: everything an agent READS as instruction. `test/` is
 * excluded because a test asserting the absence has to be able to say the
 * word; `docs/learnings/` is excluded for the same reason — a learning record
 * exists to describe what was wrong.
 */
const SCAN_ROOTS = ['skills', 'agents', 'templates', 'commands', 'lib'];
const SCAN_EXTS = ['.md', '.ts'];

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else if (SCAN_EXTS.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

function uncitedClaims(absPath: string): { line: number; text: string }[] {
  const lines = readFileSync(absPath, 'utf8').split('\n');
  const hits: { line: number; text: string }[] = [];
  lines.forEach((line, i) => {
    if (!CLAIM.test(line)) return;
    const from = Math.max(0, i - CONTEXT_LINES);
    const to = Math.min(lines.length, i + CONTEXT_LINES + 1);
    if (CITATION.test(lines.slice(from, to).join('\n'))) return;
    hits.push({ line: i + 1, text: line.trim().slice(0, 140) });
  });
  return hits;
}

function scan(): string[] {
  const offenders: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const abs of filesUnder(join(repoRoot, root))) {
      const rel = abs.slice(repoRoot.length).replace(/^\//, '');
      for (const h of uncitedClaims(abs)) offenders.push(`${rel}:${h.line}  ${h.text}`);
    }
  }
  return offenders;
}

describe('in-app control existence claims must cite run evidence (ace#2106)', () => {
  it('no authoring file names an in-app grievance route without a citation', () => {
    expect(
      scan().join('\n'),
      'A skill, agent, template, command or lib file names an in-app grievance/GRM route ' +
        'with no issue number, run id, or "repro" on or beside its line.\n\n' +
        'ACE-built apps do not have one: the released Deliver CCZ of hh-poverty-targeting ' +
        'greps zero for grievance|GRM|complaint across suite.xml and both app_strings.txt, ' +
        'and templates/pdd-template.md has no grievance section, so no PDD is even asked to ' +
        'designate the channel the old text claimed it "already designates".\n\n' +
        'A worker sent to a menu that is not there does not fall back to the coordinator — ' +
        'they stop escalating. Either observe the control in THIS run (a ' +
        'commcare_download_ccz grep of app_strings.txt, or a Phase 6 ui-dump) and cite it, ' +
        'or name the human coordinator fill-in, which is true on every build.\n',
    ).toBe('');
  });

  // --- controls: the rail must bite, and must not bite the fix -------------

  it('POSITIVE control: the exact text that shipped would fail', () => {
    const shipped = [
      '1. a **human** — the LLO coordinator / Partner Trainer, and',
      "2. the app's own in-app grievance route (the **GRM menu**), which the PDD",
      '   already designates as the complaint channel.',
    ].join('\n');
    const lines = shipped.split('\n');
    const claimLines = lines.filter((l) => CLAIM.test(l));
    expect(claimLines.length).toBeGreaterThan(0);
    for (const l of claimLines) expect(CITATION.test(shipped)).toBe(false);
  });

  it('NEGATIVE control: a cited, conditional mention passes', () => {
    const corrected = [
      'Name an in-app route only when this run\'s evidence shows one exists.',
      'Assume it does NOT (dimagi-internal/ace#2106): no ACE-built app has a GRM menu.',
      'The coordinator fill-in is the floor.',
    ];
    const hits = corrected.filter((_, i) => {
      if (!CLAIM.test(corrected[i]!)) return false;
      const from = Math.max(0, i - CONTEXT_LINES);
      const to = Math.min(corrected.length, i + CONTEXT_LINES + 1);
      return !CITATION.test(corrected.slice(from, to).join('\n'));
    });
    expect(hits).toEqual([]);
  });

  it('scans .ts as well as .md — the guard message is where it hid', () => {
    expect(SCAN_EXTS).toContain('.ts');
    expect(SCAN_ROOTS).toContain('lib');
  });
});
