/**
 * ace#1918 — every producer of a MEASURED >40,000-char artifact must compose
 * it to a local file and hand the write `localFilePath`, not emit it inline.
 *
 * Why a test and not prose: `localFilePath` shipped as a purely additive handle
 * in ace#1780 and the atom descriptions have recommended it since, but a
 * preference in prose runs well under 100% (CLAUDE.md § self-heal sweep
 * measured 58% vs 71% for exactly this shape). #1907 measured the corpus,
 * concluded the create-atom ceiling is a SEQUENCED change, and split the
 * conversion out as #1918. This file is the conversion, made checkable.
 *
 * Scope discipline — this asserts the CALLER is wired, which is the half that
 * keeps getting dropped. PR #2055 shipped `write_to_path` on
 * `commcare_get_form_source` AND its caller in the same change precisely
 * because an atom with no caller is a capability nobody uses; the same trap
 * applies here in reverse, where the atom has had the handle for weeks and the
 * producers never took it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../..');

/**
 * Producers of an artifact the 2026-09-02 Drive corpus measured above 40,000
 * characters, whose write goes through a resolver-backed atom.
 *
 * `resampled` is the max seen re-measuring 6 recent runs on 2026-09-06 (the
 * ace#1918 premise check). Three artifacts came in well below 40,000 in that
 * smaller sample — the size tracks app/deck/journey size, so a below-threshold
 * sample refutes "always large", never "can be large". The 1,572-artifact
 * corpus remains the wider evidence and the conversion is additive either way.
 */
const PRODUCERS = [
  {
    skill: 'ocs-chatbot-qa',
    artifact: 'ocs-chatbot-qa_transcript-deep.md',
    corpusMax: 224_003,
    resampled: 157_979,
    atoms: ['drive_create_file', 'drive_update_file'],
  },
  {
    skill: 'pdd-to-test-prompts',
    artifact: 'pdd-to-test-prompts.md',
    corpusMax: 59_737,
    resampled: 66_294,
    atoms: ['drive_create_file'],
  },
  {
    skill: 'training-deck-generate',
    artifact: 'training-deck-spec.yaml',
    corpusMax: 55_719,
    resampled: 26_711,
    atoms: ['drive_create_file'],
  },
  {
    skill: 'solicitation-create',
    artifact: 'solicitation-create_published.md',
    corpusMax: 51_920,
    resampled: 51_920,
    atoms: ['drive_create_file'],
  },
  {
    skill: 'pdd-to-deliver-app-eval',
    artifact: 'pdd-to-deliver-app-eval_verdict.yaml',
    corpusMax: 44_716,
    resampled: 25_817,
    atoms: ['drive_create_file'],
  },
  {
    skill: 'app-screenshot-capture',
    artifact: 'app-screenshot-capture_manifest.yaml',
    corpusMax: 43_778,
    resampled: 18_331,
    atoms: ['drive_create_file'],
  },
] as const;

function skillText(skill: string): string {
  return readFileSync(join(REPO_ROOT, 'skills', skill, 'SKILL.md'), 'utf8');
}

describe('every >40k producer instructs localFilePath (ace#1918)', () => {
  it.each(PRODUCERS.map((p) => [p.skill, p] as const))(
    '%s composes to a local file and passes localFilePath',
    (_name, p) => {
      const text = skillText(p.skill);
      expect(text, `${p.skill} never mentions localFilePath`).toMatch(/localFilePath/);
      // The handle alone is not the instruction: "compose to a LOCAL FILE"
      // is what stops an agent from generating the document into the call
      // args and then also writing it to disk, which pays the cost twice.
      expect(text, `${p.skill} does not say to compose to a local file first`)
        .toMatch(/LOCAL FILE/);
      expect(text, `${p.skill} does not cite the issue`).toMatch(/ace#1918/);
    },
  );

  it.each(PRODUCERS.map((p) => [p.skill, p] as const))(
    '%s still names the atom it writes through',
    (_name, p) => {
      const text = skillText(p.skill);
      for (const atom of p.atoms) {
        expect(text, `${p.skill} no longer names ${atom}`).toMatch(
          new RegExp(atom.replace(/_/g, '_')),
        );
      }
    },
  );

  it('the fixture only lists artifacts the corpus actually measured >40,000', () => {
    for (const p of PRODUCERS) expect(p.corpusMax, p.artifact).toBeGreaterThan(40_000);
  });

  it('records that three of the six re-sampled BELOW 40,000, without dropping them', () => {
    // Honesty pin: the 2026-09-06 re-sample of 6 recent runs did not reproduce
    // the corpus max for three artifacts. That is a size-varies finding, not a
    // refutation, and it is written down here so nobody later reads the
    // conversion as "all six are always huge".
    const below = PRODUCERS.filter((p) => p.resampled < 40_000).map((p) => p.skill).sort();
    expect(below).toEqual([
      'app-screenshot-capture',
      'pdd-to-deliver-app-eval',
      'training-deck-generate',
    ]);
    const above = PRODUCERS.filter((p) => p.resampled >= 40_000).map((p) => p.skill).sort();
    expect(above).toEqual(['ocs-chatbot-qa', 'pdd-to-test-prompts', 'solicitation-create']);
  });
});

describe("ocs-chatbot-qa's deep path: the one that needed care", () => {
  const text = skillText('ocs-chatbot-qa');

  it('keeps the deep path INCREMENTAL — it may not become a single-shot create', () => {
    // ace#1918 asked the question explicitly. Step 3 resume-from-partial reads
    // the Drive file the previous session's appends produced; a single write at
    // suite end leaves nothing to resume from, i.e. deletes the only property
    // the mode exists for.
    expect(text).toMatch(/deep path (?:STAYS|stays) incremental/i);
    expect(text).toMatch(/resume-from-partial/);
  });

  it('states that inline appends are REFUSED, not merely expensive', () => {
    // This is the half that makes it a live defect rather than a preference:
    // drive_update_file carries UPDATE_FILE_INLINE_CEILING = 40,000 today, and
    // a deep transcript passes that mid-suite.
    expect(text).toMatch(/oversized_inline_content|REFUSES\s+inline/);
    expect(text).toMatch(/UPDATE_FILE_INLINE_CEILING|40,000/);
  });

  it('keeps CAS on the converted append path', () => {
    expect(text).toMatch(/localFilePath[^\n]*ifMatchRevisionId|ifMatchRevisionId[^\n]*localFilePath/);
  });
});

describe('decisions-render is NOT a producer here — the filed table was wrong', () => {
  // ace#1918 listed `decisions.gdoc` (63,142 chars) under `decisions-render`
  // with atom `drive_create_doc_from_markdown`. Re-derived against current
  // main: the skill's Step 2 forbids exactly that call and routes the whole
  // render through the `render_decisions_log` ATOM, which reads decisions.yaml
  // off Drive and does the Docs batchUpdate server-side. No document body ever
  // passes through the model, so there is nothing to convert and no create-atom
  // ceiling could ever fire on it. Pinned so the row is not re-added.
  const text = skillText('decisions-render');

  it('routes through the render_decisions_log atom', () => {
    expect(text).toMatch(/render_decisions_log/);
  });

  it('explicitly forbids hand-rendering through drive_create_doc_from_markdown', () => {
    expect(text).toMatch(/\*\*Do NOT\*\* hand-render[\s\S]{0,120}drive_create_doc_from_markdown/);
  });
});
