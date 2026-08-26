/**
 * Release state has exactly one owner (dimagi-internal/ace#1636).
 *
 * Fourth instance of the ace#1010 / #1439 / #1567 class — "a reader depends on
 * an artifact whose producer does not own the evidence" — and the one that
 * retires the artifact rather than re-pointing one more reader.
 *
 * `app-release § Products` declares `apps.<app>.{hq_app_id, build_id, version,
 * is_released, released_at}` in `3-commcare/app-release_summary.md`. That is
 * the sole owner of released build state.
 *
 * `app-release` ALSO used to append a `releases:` cross-reference into
 * `3-commcare/app-deploy_summary.md`, an artifact `app-deploy` owns. Step 7 was
 * skipped on 2 of 2 observed runs (`bednet-check-2-visit/20260820-0832` and
 * `/20260825-1310`) while the release itself was clean — and `llo-launch § Step
 * 4`'s app-verdict-freshness gate read that block as a hard `[BLOCKER]` input.
 * So the Phase 9 launch gate either halted with a factually false blocker, or
 * silently skipped the staleness check and let a stale deep app-UX verdict
 * authorize a go-live. `app-release-eval` had already been re-pointed twice
 * (#1439, #1567) without anyone checking who ELSE read the block.
 *
 * Step 7 is deleted and the block is retired. What this test pins:
 *
 *   1. No skill INSTRUCTS a read or write of a `releases:` block in the deploy
 *      summary. A block that merely documents the retirement is allowed, and
 *      is distinguished by naming the retirement explicitly.
 *   2. `llo-launch`'s app-verdict-freshness gate reads the OWNED artifact.
 *
 * SCOPE NOTE, same posture as `eval-gate-artifact-ownership.test.ts`: this is
 * deliberately narrower than the general class. "A rubric names a key the
 * producer never writes" is prose and not statically decidable. "A skill pairs
 * a specific non-owning artifact with a specific owned key, in an imperative
 * block" is, and it is where all four instances landed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SKILLS_DIR = join(__dirname, '..', '..', 'skills');

/** The artifact that does NOT own release state. */
const NON_OWNER = 'app-deploy_summary.md';
/** The artifact that does. */
const OWNER = 'app-release_summary.md';

/**
 * Markers that turn a mention into documentation-of-the-retirement rather than
 * an instruction. A block carrying one of these is describing history; a block
 * carrying none and naming both `app-deploy_summary.md` and `releases:` is
 * telling a run to read or write the retired cross-reference.
 */
const RETIREMENT_MARKERS = [/ace#1636/i, /retired/i, /legacy/i, /no release state/i];

/** Split into the smallest unit a single instruction can live in. */
function blocks(doc: string): string[] {
  const body = stripChangeLog(doc);
  const out: string[] = [];
  let cur: string[] = [];
  let inFence = false;
  const flush = () => {
    if (cur.length) out.push(cur.join('\n').trim());
    cur = [];
  };
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      cur.push(line);
      continue;
    }
    if (inFence) {
      cur.push(line);
      continue;
    }
    // A table row, or a new top-level list item, starts a new block.
    if (/^\s*\|/.test(line) || /^\s{0,3}(\d+[a-z]?\.|[-*])\s/.test(line)) {
      flush();
      cur.push(line);
      if (/^\s*\|/.test(line)) flush();
      continue;
    }
    if (/^\s*$/.test(line)) {
      // A blank line ends a block only outside a fence; the fence case is
      // handled above. Keep the blank so fenced yaml stays attached.
      cur.push(line);
      continue;
    }
    cur.push(line);
  }
  flush();
  return out.filter(Boolean);
}

function stripChangeLog(doc: string): string {
  const idx = doc.search(/^## Change Log\s*$/m);
  return idx === -1 ? doc : doc.slice(0, idx);
}

function allSkillDocs(): { name: string; text: string }[] {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, path: join(SKILLS_DIR, d.name, 'SKILL.md') }))
    .filter((s) => existsSync(s.path))
    .map((s) => ({ name: s.name, text: readFileSync(s.path, 'utf8') }));
}

describe('release state is owned by app-release_summary.md alone (ace#1636)', () => {
  const docs = allSkillDocs();

  it('has skills to check (guard against the sweep silently finding nothing)', () => {
    expect(docs.length).toBeGreaterThan(50);
    // The two skills the defect actually lived in must be in the sweep.
    expect(docs.map((d) => d.name)).toEqual(
      expect.arrayContaining(['app-release', 'llo-launch', 'app-release-eval']),
    );
  });

  it('no skill instructs a read or write of a `releases:` block in the deploy summary', () => {
    const violations: string[] = [];
    for (const { name, text } of docs) {
      for (const b of blocks(text)) {
        if (!b.includes(NON_OWNER)) continue;
        if (!/\breleases:/.test(b)) continue;
        if (RETIREMENT_MARKERS.some((re) => re.test(b))) continue;
        violations.push(`${name}: ${b.replace(/\s+/g, ' ').slice(0, 160)}`);
      }
    }
    expect(
      violations,
      'A `releases:` block in `app-deploy_summary.md` is retired (ace#1636): ' +
        '`app-deploy` owns that file and never wrote release state into it, and ' +
        'the append was skipped on 2 of 2 observed runs while the release was ' +
        `clean. Release state lives in \`${OWNER}\`'s \`apps.<app>\` frontmatter. ` +
        'If you are documenting the retirement rather than instructing a run, ' +
        'say so in the block (cite ace#1636, or the words "retired" / "legacy").',
    ).toEqual([]);
  });

  it('app-release § Process no longer carries the Step 7 cross-reference write', () => {
    const text = readFileSync(join(SKILLS_DIR, 'app-release', 'SKILL.md'), 'utf8');
    const m = /^## Process\s*$/m.exec(text)!;
    const after = text.slice(m.index + m[0].length);
    const process = after.slice(0, /^## /m.exec(after)!.index);
    expect(
      /Update\s+`?3-commcare\/app-deploy_summary\.md/.test(process),
      'app-release must not write into app-deploy\'s artifact (ace#1636).',
    ).toBe(false);
  });

  it("llo-launch's app-verdict-freshness gate reads the owned artifact", () => {
    const text = readFileSync(join(SKILLS_DIR, 'llo-launch', 'SKILL.md'), 'utf8');
    const gate = blocks(text).filter((b) => /App verdict freshness/.test(b));
    expect(gate.length, 'llo-launch lost its app-verdict-freshness gate').toBe(1);
    expect(
      gate[0].includes(OWNER),
      `The freshness gate must compare the deep verdict's build ids against ` +
        `\`${OWNER}\`'s \`apps.<app>.build_id\` — the contract app-release owns ` +
        '(ace#1439). Reading a cross-reference in another skill\'s artifact is ' +
        'how ace#1636 let a stale deep app-UX verdict reach a go-live.',
    ).toBe(true);
    // The gate may NAME the deploy summary while explaining the retirement,
    // but only alongside a retirement marker — the same allowance the sweep
    // above makes. A bare mention is an instruction to read it.
    expect(
      gate[0].includes(NON_OWNER) && !RETIREMENT_MARKERS.some((re) => re.test(gate[0])),
      'The freshness gate must not read the deploy summary for release state.',
    ).toBe(false);
  });
});
