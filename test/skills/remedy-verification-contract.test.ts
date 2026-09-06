import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Nothing in ACE verified an issue's SUGGESTED FIX. This test pins the rail
 * that does.
 *
 * ## The failure class (ace#1900)
 *
 * `CLAUDE.md § File ACE issues mid-run` rule 1 makes the filer verify the
 * PREMISE — open the file, run the grep, quote the output. It says nothing
 * about the suggested fix, which is the half a fix-and-ship subagent inherits
 * and acts on. Measured 2026-08-29..09-06 across self-healed issues whose
 * premise was verified and correct, the remedy failed in FOUR shapes:
 *
 *   | Shape        | Case      | What it would have done                     |
 *   |--------------|-----------|---------------------------------------------|
 *   | wrong        | ace#2004  | hoisting the arm above the ancestry guard —  |
 *   |              |           | arms + merges a STRANGER'S PR                |
 *   | under-scoped | ace#2027  | duplicates the provider test into 2 branches |
 *   | no-op        | ace#1768  | the probe already calls the atom             |
 *   | stale        | ace#1766  | already shipped in f423ce12, day after filing|
 *
 * A false premise is one grep to close. A false remedy costs a full fix-agent
 * investigation (~200k tokens each) — or, worse, is trusted, ships a no-op,
 * and closes the issue over a live defect.
 *
 * ## Why the obligation is on the FIXER, not the filer
 *
 * A filer-side `Remedy-Status:` trailer was the shape ace#1900 sketched. It is
 * rejected here for two reasons, both checkable:
 *
 *   1. **CI cannot see it.** The ratchet precedent
 *      (`predictive-guard-citation.test.ts`) works because it reads files in
 *      the repo. `clean-install` runs `npx vitest run` with no `gh`, no issue
 *      access, and the one `GH_TOKEN` it holds belongs to a different step. A
 *      ratchet over GitHub issue BODIES cannot exist in this CI.
 *   2. **It taxes filing.** `CLAUDE.md`'s bar is deliberately low ("file when
 *      you'd bet it's real"), and ace#1466/#1468 were closed by Jon as issues
 *      that should never have been filed. A preventer that suppresses real
 *      findings is worse than the defect.
 *
 * So the contract lands where it is already read: the ship checkpoint the
 * dispatcher validates. `Remedy:` sits beside `Merge state` — the field that
 * demonstrably changed behaviour precisely because it is a required OUTPUT
 * rather than a remembered rule.
 *
 * ## What this test asserts, and why it is not "the prose exists"
 *
 * The four surfaces are checked AGAINST EACH OTHER. `orchestrator-reference`
 * owns the anchor section; the three callers must cite it BY NAME and must
 * agree on the vocabulary. So renaming the heading in one place, or dropping a
 * token in another, fails — no single file can satisfy this alone, which is
 * the property a bare "does the paragraph exist" check lacks.
 */

const REPO = join(__dirname, '..', '..');

/**
 * The section that owns the contract. Its citers must name it verbatim.
 * Parameterised into the checker so a control can rename it and prove the
 * citations are asserted against the HEADING rather than against themselves.
 */
const DEFAULT_ANCHOR = 'The filed remedy is a lead, not an instruction';
const ANCHOR = DEFAULT_ANCHOR;

/** The checkpoint field, and the closed vocabulary every surface must share. */
const FIELD = 'Remedy:';
const VOCAB = ['as-filed', 're-derived', 'refuted'] as const;

const OWNER = 'agents/orchestrator-reference.md';

/** Surfaces that must carry the field + vocabulary and cite the anchor. */
const CARRIERS = [
  'agents/ace-orchestrator.md',
  'skills/shipping/SKILL.md',
] as const;

/**
 * Pure checker so the controls below can mutate a corpus in memory rather
 * than the working tree.
 */
/**
 * Collapse whitespace before matching. Every surface here is hard-wrapped
 * prose, so a citation routinely straddles a line break — the first run of
 * this test failed on exactly that, with `ace-orchestrator.md` carrying the
 * anchor's name split across two lines. Matching raw text would have made the
 * rail hostage to reflow.
 */
const norm = (s: string) => s.replace(/\s+/g, ' ');

export function checkRemedyContract(
  corpus: Record<string, string>,
  ANCHOR = DEFAULT_ANCHOR,
): string[] {
  const v: string[] = [];
  const owner = norm(corpus[OWNER] ?? '');

  // 1. The owner declares the anchor section.
  if (!owner.includes(`### ${ANCHOR}`)) {
    v.push(`${OWNER}: missing the anchor section "### ${ANCHOR}"`);
  }

  // 2. The owner carries BOTH checks. One alone leaves two of the four
  //    shapes uncovered: the origin/main re-read catches stale + no-op,
  //    executing the remedy catches wrong + under-scoped.
  if (!/git show origin\/main:/.test(owner)) {
    v.push(`${OWNER}: the anchor must prescribe re-reading the cited file:line against origin/main (covers stale + no-op)`);
  }
  if (!/execute the remedy/i.test(owner)) {
    v.push(`${OWNER}: the anchor must prescribe executing the remedy before adopting it (covers wrong + under-scoped)`);
  }

  // 3. The owner lists Remedy: as a required return field.
  const required = owner.split('### Required fields in the subagent return')[1] ?? '';
  if (!required.includes(FIELD)) {
    v.push(`${OWNER}: "${FIELD}" is not listed under Required fields in the subagent return`);
  }

  // 4. Every surface — owner included — shares the field and the whole
  //    vocabulary. A partial vocabulary is how a rename drifts one caller
  //    out of agreement with the rest.
  for (const f of [OWNER, ...CARRIERS]) {
    const text = norm(corpus[f] ?? '');
    if (!text.includes(FIELD)) v.push(`${f}: missing the "${FIELD}" checkpoint field`);
    for (const token of VOCAB) {
      if (!text.includes(token)) v.push(`${f}: missing remedy verdict "${token}"`);
    }
  }

  // 5. The callers cite the owner's section BY NAME — this is the two-way
  //    binding. Renaming the heading without updating them fails here.
  for (const f of CARRIERS) {
    if (!norm(corpus[f] ?? '').includes(ANCHOR)) {
      v.push(`${f}: does not cite "${ANCHOR}" by name`);
    }
  }

  // 6. CLAUDE.md rule 1 says it governs the premise ONLY, and routes the
  //    remedy elsewhere — so a reader of the filing rules cannot conclude
  //    the suggested fix is covered. It must NOT add a filer obligation.
  const claude = norm(corpus['CLAUDE.md'] ?? '');
  if (!/governs the PREMISE only/.test(claude)) {
    v.push('CLAUDE.md: rule 1 must state that it governs the PREMISE only');
  }
  if (!claude.includes(ANCHOR)) {
    v.push(`CLAUDE.md: rule 1 must route remedy verification to "${ANCHOR}"`);
  }

  return v;
}

const FILES = [OWNER, ...CARRIERS, 'CLAUDE.md'];
function liveCorpus(): Record<string, string> {
  return Object.fromEntries(FILES.map((f) => [f, readFileSync(join(REPO, f), 'utf8')]));
}

describe('remedy-verification contract (ace#1900)', () => {
  it('the four live surfaces satisfy it', () => {
    expect(checkRemedyContract(liveCorpus())).toEqual([]);
  });

  /**
   * CONTROL 1 — mutation, per file. Neuter each surface in turn and count.
   * A checker that passes on an empty file is inert; this proves each of the
   * four files is load-bearing on its own.
   */
  it('control: neutering any ONE surface fails, and names that surface', () => {
    const counts: Record<string, number> = {};
    for (const f of FILES) {
      const corpus = { ...liveCorpus(), [f]: '# gutted\n' };
      const violations = checkRemedyContract(corpus);
      counts[f] = violations.length;
      expect(violations.length, `${f} is not load-bearing`).toBeGreaterThan(0);
      expect(violations.every((x) => x.startsWith(f))).toBe(true);
    }
    // Pinned so a future refactor that silently drops a check is visible.
    expect(counts).toEqual({
      'agents/orchestrator-reference.md': 8, // anchor + 2 checks + required-field + field + 3 tokens
      'agents/ace-orchestrator.md': 5, // field + 3 tokens + anchor citation
      'skills/shipping/SKILL.md': 5, // field + 3 tokens + anchor citation
      'CLAUDE.md': 2, // premise-only clause + anchor route
    });
  });

  /**
   * CONTROL 2 — the mutual assertion. Rename the owner's heading and nothing
   * about the callers changes on disk; a per-file existence check would still
   * pass all three. Here all three fail, because they are asserted against
   * each other rather than against themselves.
   */
  it('control: renaming the anchor heading breaks all three citers, not the owner', () => {
    const renamed = 'The filed remedy is advisory';
    const live = liveCorpus();
    // norm() first: the citation in ace-orchestrator.md straddles a line
    // break, so a raw split would silently rename nothing there.
    const corpus = { ...live, [OWNER]: norm(live[OWNER]).split(ANCHOR).join(renamed) };
    // The owner is internally consistent after the rename; the citers are not.
    const violations = checkRemedyContract(corpus, renamed);
    expect(violations).toEqual([
      `agents/ace-orchestrator.md: does not cite "${renamed}" by name`,
      `skills/shipping/SKILL.md: does not cite "${renamed}" by name`,
      `CLAUDE.md: rule 1 must route remedy verification to "${renamed}"`,
    ]);
    // And the inverse: rename EVERY surface together and it passes again.
    const allRenamed = Object.fromEntries(
      Object.entries(live).map(([f, t]) => [f, norm(t).split(ANCHOR).join(renamed)]),
    );
    expect(checkRemedyContract(allRenamed, renamed)).toEqual([]);
  });

  /**
   * CONTROL 3 — a single file cannot satisfy the contract. This is the
   * property that separates "four docs agree" from "one doc says it four
   * times", and it is the failure mode of every prose rule this repo has
   * had to replace with a rail.
   */
  it('control: the owner carrying everything alone still fails', () => {
    const live = liveCorpus();
    const corpus: Record<string, string> = { [OWNER]: live[OWNER] };
    for (const f of [...CARRIERS, 'CLAUDE.md']) corpus[f] = '# gutted\n';
    expect(checkRemedyContract(corpus)).toHaveLength(12); // 5 + 5 + 2
  });

  /**
   * CONTROL 4 — vocabulary drift. One caller renaming a verdict is exactly
   * how a shared enum rots; the dispatcher then cannot classify the return.
   */
  it('control: dropping ONE vocabulary token from ONE caller fails', () => {
    for (const token of VOCAB) {
      const live = liveCorpus();
      const corpus = {
        ...live,
        'skills/shipping/SKILL.md': live['skills/shipping/SKILL.md'].split(token).join('XXX'),
      };
      const violations = checkRemedyContract(corpus);
      expect(violations, `token "${token}" is not actually pinned`).toEqual([
        `skills/shipping/SKILL.md: missing remedy verdict "${token}"`,
      ]);
    }
  });

  /**
   * CONTROL 5 — the two checks are independently required. Deleting one and
   * keeping the other must fail, or the anchor could ship covering only two
   * of the four shapes (which is exactly what "verify the suggested fix"
   * alone would have done: it catches wrong + under-scoped and misses
   * no-op + stale).
   */
  it('control: each of the two remedy checks is required on its own', () => {
    const live = liveCorpus();

    const noStale = {
      ...live,
      [OWNER]: live[OWNER].split('git show origin/main:').join('git show HEAD:'),
    };
    expect(checkRemedyContract(noStale)).toEqual([
      `${OWNER}: the anchor must prescribe re-reading the cited file:line against origin/main (covers stale + no-op)`,
    ]);

    const noExecute = {
      ...live,
      [OWNER]: live[OWNER].split(/execute the remedy/i).join('consider the remedy'),
    };
    expect(checkRemedyContract(noExecute)).toEqual([
      `${OWNER}: the anchor must prescribe executing the remedy before adopting it (covers wrong + under-scoped)`,
    ]);
  });

  /**
   * CONTROL 6 — the field must be in the REQUIRED-RETURN list, not merely
   * mentioned somewhere in the file. The whole design rests on `Remedy:`
   * being a field the dispatcher validates, the way `Merge state` is.
   */
  it('control: mentioning Remedy: outside the required-return list does not satisfy it', () => {
    const live = liveCorpus();
    const [before, after] = live[OWNER].split('### Required fields in the subagent return');
    const bullet = after.match(/- \*\*`Remedy:`\*\*[\s\S]*?\n(?=- \*\*Merge state)/);
    expect(bullet, 'the Remedy bullet moved — this control no longer bites').not.toBeNull();
    // MOVE it out of the required list, keeping every character in the file.
    // Deleting it would also strip the vocabulary and prove nothing about
    // WHERE the field lives, which is the whole point of the field.
    const corpus = {
      ...live,
      [OWNER]: `${before}${bullet![0]}### Required fields in the subagent return${after.replace(bullet![0], '')}`,
    };
    expect(checkRemedyContract(corpus)).toEqual([
      `${OWNER}: "${FIELD}" is not listed under Required fields in the subagent return`,
    ]);
  });
});
