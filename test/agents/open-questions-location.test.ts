/**
 * dimagi-internal/ace#1753 — the durable open-questions ledger has ONE home,
 * and it is the opp root.
 *
 * ## The defect this pins
 *
 * `agents/ace-orchestrator.md § Phase boundary fence` used to instruct the
 * orchestrator to write `<run-folder>/open-questions.md`, justified by the
 * claim that "the summary page reads `open-questions.md` from the run-folder
 * root by name". That claim was false, and had been for a month:
 *
 *   - ace-web `apps/opps/summary.py § _read_open_questions` iterates
 *     `(opp_folder_id, run_folder_id)` — the OPP folder first, the run folder
 *     only as a fallback "so any older run that did write a run-local copy
 *     keeps rendering". On any real opp the opp-root ledger exists, so the
 *     run-local copy is never the one served.
 *   - `lib/run-readme.ts` lists `open-questions.md` in `OPP_LEVEL_PATHS` and
 *     filters it out of the run README.
 *   - `lib/artifact-manifest.ts` declares its path as `open-questions.md`,
 *     described verbatim as "Opp-level (NOT under runs/<run-id>/)".
 *
 * Every consumer agreed; the fence was the lone dissenter. A run that
 * followed it (`hh-poverty-targeting/20260827-0323`) wrote a document that
 * appeared on none of the 17 links the summary page emits — and, worse,
 * invited the wrong repair, because a `DOC-LITERAL-MARKDOWN` finding raised
 * against the opp-root ledger looks like it belongs to the run-local file
 * sitting next to the audit.
 *
 * ## Evidence class
 *
 * STATIC TEXT + the in-repo manifest. Nothing here is sent to, or matched
 * against, an external system: the claim is about which path ACE's own docs
 * instruct and which path its own manifest declares (CLAUDE.md § the trigger
 * is the CLAIM, not the directory). The cross-repo half — that ace-web
 * prefers the opp folder — is asserted by ace-web's own
 * `test_open_questions_read_from_opp_folder_not_run_folder`, and is quoted
 * here rather than re-tested, because this repo cannot import it.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_MANIFEST } from '../../lib/artifact-manifest.js';
import { generateRunReadme } from '../../lib/run-readme.js';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/**
 * Instructional surfaces. Docs that RECORD the defect (CHANGELOG, this test,
 * design specs under `docs/`) are not scanned — a ratchet that cannot
 * describe what it forbids is unmaintainable.
 */
const INSTRUCTIONAL_DIRS = ['agents', 'skills', 'commands'];

function walk(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const e of entries) {
    const abs = join(dir, e);
    if (statSync(abs).isDirectory()) walk(abs, acc);
    else if (e.endsWith('.md')) acc.push(abs);
  }
  return acc;
}

function instructionalFiles(): string[] {
  return INSTRUCTIONAL_DIRS.flatMap((d) => walk(join(REPO, d)));
}

/**
 * A run-folder open-questions path, in the shapes ACE's docs actually write.
 * Narrow on purpose: `runs/<run-id>/` and `<run-folder>/` are the two forms
 * the manifest and the orchestrator use for the run root, and the third is
 * the prose claim that produced the defect.
 */
const RUN_FOLDER_OPEN_QUESTIONS: readonly RegExp[] = [
  /<run-folder>\/open-questions\.md/i,
  /runs\/<run-id>\/open-questions\.md/i,
  /open-questions\.md`? from the run-folder root/i,
];

describe('open-questions.md lives at the opp root (ace#1753)', () => {
  it('no instructional doc directs a write into the run folder', () => {
    const offenders: string[] = [];
    for (const abs of instructionalFiles()) {
      const rel = relative(REPO, abs).split(sep).join('/');
      readFileSync(abs, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const re of RUN_FOLDER_OPEN_QUESTIONS) {
            if (re.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
          }
        });
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('the boundary fence names the opp-root ledger as the destination', () => {
    const text = readFileSync(join(REPO, 'agents/ace-orchestrator.md'), 'utf8');
    const idx = text.indexOf('**Open-questions doc (run-end, once).**');
    expect(idx, 'the boundary-fence open-questions paragraph is gone').toBeGreaterThan(-1);
    const para = text.slice(idx, idx + 2600);
    expect(para).toContain('<opp>/open-questions.md');
    expect(para).toMatch(/never write a run-folder copy/i);
    // The reason must travel with the rule: without it the next reader
    // re-derives "the page renders empty" and puts the write back.
    expect(para).toContain('_read_open_questions');
  });

  it('the manifest declares an opp-root path, not a run-folder one', () => {
    const entry = ARTIFACT_MANIFEST.find((a) => a.path === 'open-questions.md');
    expect(entry, 'open-questions.md is missing from ARTIFACT_MANIFEST').toBeDefined();
    expect(entry!.path).not.toContain('/');
    expect(
      ARTIFACT_MANIFEST.filter((a) => a.path.endsWith('open-questions.md')).map((a) => a.path),
    ).toEqual(['open-questions.md']);
  });

  it('the run README does not advertise a run-folder copy', () => {
    expect(generateRunReadme('20260827-0323')).not.toContain('open-questions.md');
  });
});
