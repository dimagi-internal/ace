import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Class-level preventer for the ace#1010 / ace#1439 / ace#1567 class:
//
//   an `-eval` rubric bases a verdict on evidence the producer skill's
//   contract does not own.
//
// Three instances, all in `app-release-eval`, all over four months:
//
//   ace#1010 — `build_id_traceability` graded `run_state.yaml`, which
//     `app-release` explicitly disclaims writing (the orchestrator writes it
//     at the boundary fence, AFTER the per-step evals). Every clean release
//     scored 6/10 on it: a fixed 0.8-point downward bias.
//   ace#1439 — `both_apps_released` required `is_released` /
//     `latest_released_version` inside the DEPLOY summary's `releases:`
//     block, where neither has ever been written. `is_released` lives in
//     `app-release_summary.md`, the artifact `app-release` owns.
//   ace#1567 — Step 2's `incomplete` gate keyed on the deploy summary's
//     `releases:` block, so a fully released, fully documented run read as
//     "skill did not run". Worse than a deduction: in `opp-eval`,
//     `incomplete` is "not gradable", so the run neither gets its pass nor
//     surfaces the real finding.
//
// ace#1439 declined to land a test, on the grounds that the general class
// ("a rubric names an artifact key the producer never writes") is not
// cheaply testable as static analysis — rubric criteria are prose. That is
// still true of the DIMENSION half: a dimension may legitimately name
// another skill's artifact as a corroborating cross-check, and no regex can
// tell corroboration from a required leg.
//
// The VERDICT-GATE half is tractable, and it is where the third instance
// landed. A gate that emits `verdict: incomplete` is asserting "the producer
// did not run" — a claim only the producer's OWN artifact can settle. So:
//
//   every artifact an `-eval` names in its `incomplete` gate must be
//   declared in the producer's `## Products` (or its `-qa` sibling's, or
//   the eval's own, or be shared run state).
//
// That is narrower than the full class and says so. It catches instance
// four in the same place, and in any of the other 26 rubrics it checks.
//
// Coverage ledger: 12 `-eval` skills are SKIPPED because their producer
// declares no `## Products` section at all, so there is no ownership fact to
// check against (cycle-grade, learnings-summary, llo-uat, llo-launch,
// solicitation-review, flw-data-review, run-surface-audit, and the evals
// with no same-named producer). Declaring those contracts is the ace#1439
// direction and would extend this check for free; until then the guard
// below pins the checked count so coverage cannot silently degrade to zero.

const SKILLS_DIR = join(__dirname, '..', '..', 'skills');

/**
 * Artifacts that are shared run/opp state rather than any one skill's
 * product. Many skills write parts of these, so ownership says nothing.
 * (ace#1010's separate rule — do not GRADE `run_state.yaml` in a per-step
 * eval — is about dimensions, not gates, and is not what this test checks.)
 */
const SHARED_STATE = new Set(['run_state.yaml', 'opp.yaml', 'decisions.yaml', 'known-issues.md']);

/** `3-commcare/app-release_summary.md`, `angles.yaml`, `provenance.yaml`, … */
const ARTIFACT = /[\w][\w./-]*\.(?:md|yaml|yml|json)/g;

/**
 * Split a SKILL.md into the smallest blocks a claim can live in.
 *
 * A list item (numbered or bulleted) plus its indented continuation is one
 * block; a table row is one block; a top-level paragraph is one block. Kept
 * tight on purpose — merging the verdict-tier bullets into a single block
 * would let an artifact named in the `fail` tier be read as if it were named
 * in the `incomplete` tier.
 */
export function blocks(doc: string): string[] {
  const lines = stripChangeLog(doc).split('\n');
  const out: string[] = [];
  let cur: string | null = null;
  let blank = false;

  const flush = () => {
    if (cur !== null) out.push(cur);
    cur = null;
  };

  for (const line of lines) {
    const isListStart = /^\s{0,3}(\d+\.|[-*])\s/.test(line);
    const isTableRow = /^\s*\|/.test(line);
    const isTopLevel = /^\S/.test(line);

    if (isListStart || isTableRow) {
      flush();
      cur = line;
      if (isTableRow) flush();
      blank = false;
      continue;
    }

    if (/^\s*$/.test(line)) {
      blank = true;
      if (cur !== null) cur += '\n' + line;
      continue;
    }

    // A top-level line after a blank line starts a new block rather than
    // continuing the previous list item.
    if (isTopLevel && blank) flush();
    blank = false;
    cur = cur === null ? line : cur + '\n' + line;
  }

  flush();
  return out.map((b) => b.trim()).filter(Boolean);
}

/** Change Log rows narrate history, including gates that have since moved. */
export function stripChangeLog(doc: string): string {
  const idx = doc.search(/^## Change Log\s*$/m);
  return idx === -1 ? doc : doc.slice(0, idx);
}

/**
 * Artifact basenames named in a stretch of prose.
 *
 * Repo-internal references (`skills/…`, `lib/…`, `docs/…`, `test/…`) and
 * `_`-prefixed shared templates (`_eval-template.md`) are not run artifacts
 * and carry no ownership.
 */
export function artifactsIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const m of text.matchAll(ARTIFACT)) {
    const full = m[0];
    if (/(?:^|[^\w])(?:skills|lib|docs|test|scripts|templates)\//.test(full)) continue;
    const base = full.split('/').pop()!;
    if (base.startsWith('_')) continue;
    found.add(base);
  }
  return found;
}

/** Artifacts a skill declares under `## Products`, or null if it declares none. */
export function declaredProducts(slug: string): Set<string> | null {
  const path = join(SKILLS_DIR, slug, 'SKILL.md');
  if (!existsSync(path)) return null;
  const doc = readFileSync(path, 'utf8');
  const idx = doc.search(/^## Products\s*$/m);
  if (idx === -1) return null;
  const rest = doc.slice(idx + 1);
  const end = rest.search(/^## /m);
  return artifactsIn(rest.slice(0, end === -1 ? rest.length : end));
}

/** A block that emits or defines `verdict: incomplete`. */
const INCOMPLETE_GATE = /verdict:\s*`?incomplete|`incomplete`\s*[—-]/;

export function incompleteGateArtifacts(doc: string): Set<string> {
  const found = new Set<string>();
  for (const block of blocks(doc)) {
    if (!INCOMPLETE_GATE.test(block)) continue;
    for (const a of artifactsIn(block)) found.add(a);
  }
  return found;
}

function ownershipIndex(): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const slug of readdirSync(SKILLS_DIR)) {
    const products = declaredProducts(slug);
    if (!products) continue;
    for (const artifact of products) {
      if (!index.has(artifact)) index.set(artifact, []);
      index.get(artifact)!.push(slug);
    }
  }
  return index;
}

describe('eval verdict-gate artifact ownership', () => {
  const evals = readdirSync(SKILLS_DIR)
    .filter((d) => d.endsWith('-eval'))
    .sort();

  const checkable = evals.filter((slug) => declaredProducts(slug.replace(/-eval$/, '')) !== null);

  it('finds the eval skills whose producer declares a product contract', () => {
    expect(evals.length).toBeGreaterThan(30);
    // Guard against the check silently degrading to zero coverage if the
    // `## Products` convention or the `-eval` naming convention moves.
    expect(checkable.length).toBeGreaterThanOrEqual(25);
  });

  it('no incomplete gate keys on an artifact the producer does not own', () => {
    const owners = ownershipIndex();
    const offenders: string[] = [];

    for (const slug of checkable) {
      const producer = slug.replace(/-eval$/, '');
      const produced = declaredProducts(producer)!;
      const qa = declaredProducts(`${producer}-qa`) ?? new Set<string>();
      const own = declaredProducts(slug) ?? new Set<string>();
      const doc = readFileSync(join(SKILLS_DIR, slug, 'SKILL.md'), 'utf8');

      for (const artifact of incompleteGateArtifacts(doc)) {
        if (
          SHARED_STATE.has(artifact) ||
          produced.has(artifact) ||
          qa.has(artifact) ||
          own.has(artifact) ||
          artifact.endsWith('-eval_verdict.yaml')
        ) {
          continue;
        }

        const otherOwners = (owners.get(artifact) ?? []).filter((s) => s !== producer);
        offenders.push(
          `${slug}: \`incomplete\` gate keys on \`${artifact}\`` +
            (otherOwners.length
              ? ` — owned by \`${otherOwners.join('`, `')}\`, not by \`${producer}\``
              : ` — declared as a product by no skill`) +
            `. \`${producer}\` owns: ${[...produced].join(', ') || '(nothing)'}. ` +
            `An \`incomplete\` verdict claims the producer did not run; only the producer's own artifact can settle that (ace#1567).`,
        );
      }
    }

    expect(offenders).toEqual([]);
  });

  it('app-release-eval anchors on the artifact app-release owns (ace#1567 regression)', () => {
    const doc = readFileSync(join(SKILLS_DIR, 'app-release-eval', 'SKILL.md'), 'utf8');
    const gated = incompleteGateArtifacts(doc);

    expect([...gated]).toContain('app-release_summary.md');
    expect([...gated]).not.toContain('app-deploy_summary.md');
  });
});

describe('parser behaviour', () => {
  it('keeps each verdict-tier bullet a separate block', () => {
    const doc = [
      '   - `partial` — overall high but a live probe failed; see other.md.',
      '   - `incomplete` — mine.md missing.',
    ].join('\n');
    expect(incompleteGateArtifacts(doc)).toEqual(new Set(['mine.md']));
  });

  it('reads an artifact out of a wrapped numbered gate step', () => {
    const doc = [
      '2. **Detect missing artifacts.** If `3-commcare/mine.md` is missing,',
      '   emit `verdict: incomplete` immediately.',
      '',
      '3. **Grade.** Cross-check against `3-commcare/theirs.md`.',
    ].join('\n');
    expect(incompleteGateArtifacts(doc)).toEqual(new Set(['mine.md']));
  });

  it('does not carry a top-level paragraph into the preceding list item', () => {
    const doc = [
      '1. **Read inputs.** From `3-commcare/theirs.md`.',
      '',
      'Precedence: emit `verdict: incomplete` only on `3-commcare/mine.md`.',
    ].join('\n');
    expect(incompleteGateArtifacts(doc)).toEqual(new Set(['mine.md']));
  });

  it('ignores repo-internal references and shared templates', () => {
    const doc = 'If QA failed, emit `verdict: incomplete`. See `skills/_eval-template.md` and `lib/verdict-schema.ts`.';
    expect(incompleteGateArtifacts(doc)).toEqual(new Set());
  });

  it('ignores gates recorded in the Change Log', () => {
    const doc = [
      '## Change Log',
      '',
      '| 2026-04-29 | Added step-2 detection: emit `verdict: incomplete` if `legacy.md` is missing. |',
    ].join('\n');
    expect(incompleteGateArtifacts(doc)).toEqual(new Set());
  });
});
