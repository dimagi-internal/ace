/**
 * dimagi-internal/ace#2866 — a `.yaml` write that produces a file no YAML
 * reader can parse.
 *
 * `opp.yaml` for turmeric-market-study-ghana was scaffolded as raw text
 * through `drive_create_file`, carrying a `notes:` item whose PROSE first line
 * ended in a colon. YAML reads that line as an implicit mapping key and the
 * continuation line then fails. Nothing checked it at write time and nothing
 * checks it at read time, so it stayed invisible until Phase 4 tried to record
 * `connect.program` — the opp's only durable cross-run Connect reference —
 * through `update_yaml_file`, which is read-parse-merge-write and therefore
 * could not write it either:
 *
 *     Error: Implicit keys need to be on a single line at line 19, column 5
 *
 * A later run of the opp would have re-read `opp.yaml`, found no
 * `connect.program`, and created a SECOND Connect programme.
 *
 * `update_yaml_file` already defends its OWN serializer against the sibling
 * YAML-1.1 hazard (ace#2296). The gap was that `opp.yaml`, `decisions.yaml`
 * and friends are authored as raw TEXT through the three generic write atoms,
 * which bypass the serializer entirely. The guard closes the emit path rather
 * than detecting the damage afterwards.
 */
import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  yamlParseWriteRefusal,
  qaResultWriteRefusal,
  verdictWriteRefusal,
} from '../../lib/qa-result-write-guard';

// The live shape, verbatim from the issue.
const BROKEN_OPP_YAML = `opportunity: turmeric-market-study-ghana
display_name: Turmeric Market Study — Ghana
created_at: '2026-10-12'
notes:
  - No connect.program is recorded here on purpose. Phase 4 must CREATE one:
    country, currency and delivery_type are create-time-only on a Connect
    programme, so Ghana/GHS cannot be applied to an existing one.
`;

const REPAIRED_OPP_YAML = `opportunity: turmeric-market-study-ghana
display_name: Turmeric Market Study — Ghana
created_at: '2026-10-12'
notes:
  - "No connect.program is recorded here on purpose. Phase 4 must CREATE one:
    country, currency and delivery_type are create-time-only on a Connect
    programme, so Ghana/GHS cannot be applied to an existing one."
connect:
  program:
    id: f22679e0-55c3-4642-9429-1cad6fb14e35
`;

describe('yamlParseWriteRefusal — the write cannot emit unparseable YAML (ace#2866)', () => {
  it('the live opp.yaml really is unparseable — the premise, not an assumption', () => {
    // If this ever stops throwing, the guard below is testing nothing.
    expect(() => parseYaml(BROKEN_OPP_YAML)).toThrow(/[Ii]mplicit key/);
  });

  it('refuses the trailing-colon prose line', () => {
    const refusal = yamlParseWriteRefusal('opp.yaml', BROKEN_OPP_YAML);
    expect(refusal).toMatch(/^INVALID_YAML: opp\.yaml does not parse as YAML/);
    expect(refusal).toMatch(/Nothing was written/);
  });

  it('names the trailing colon specifically, because that is the shape observed', () => {
    // A generic "invalid YAML" sends the author hunting; the cause is one
    // character and the remedy is to quote the scalar.
    expect(yamlParseWriteRefusal('opp.yaml', BROKEN_OPP_YAML)).toMatch(
      /PROSE line ending in a colon/,
    );
  });

  it('allows the repaired file', () => {
    expect(yamlParseWriteRefusal('opp.yaml', REPAIRED_OPP_YAML)).toBeNull();
    expect(parseYaml(REPAIRED_OPP_YAML).connect.program.id).toBe(
      'f22679e0-55c3-4642-9429-1cad6fb14e35',
    );
  });

  it('covers every YAML state file, not just opp.yaml', () => {
    for (const name of ['run_state.yaml', 'decisions.yaml', 'opp.yml', 'OPP.YAML']) {
      expect(yamlParseWriteRefusal(name, BROKEN_OPP_YAML)).toMatch(/INVALID_YAML/);
    }
  });

  it('ignores files that are not YAML by name', () => {
    for (const name of ['pdd.md', 'summary.txt', 'notes.source.md', 'app.json']) {
      expect(yamlParseWriteRefusal(name, BROKEN_OPP_YAML)).toBeNull();
    }
  });

  it('catches a duplicated key, which different readers resolve differently', () => {
    // Same class: Python's reader keeps the last value, a strict reader
    // rejects, and the two disagree about what the file says.
    expect(yamlParseWriteRefusal('run_state.yaml', 'a: 1\nb: 2\na: 3\n')).toMatch(
      /INVALID_YAML/,
    );
  });

  describe('does not over-reach', () => {
    it('allows an empty file — update_yaml_file treats empty as {}', () => {
      expect(yamlParseWriteRefusal('opp.yaml', '')).toBeNull();
      expect(yamlParseWriteRefusal('opp.yaml', '\n\n')).toBeNull();
    });

    it('allows a top-level sequence — shape is not this guard\'s business', () => {
      expect(yamlParseWriteRefusal('things.yaml', '- a\n- b\n')).toBeNull();
    });

    it('allows a multi-document file', () => {
      expect(yamlParseWriteRefusal('multi.yaml', 'a: 1\n---\nb: 2\n')).toBeNull();
    });

    it('allows a leading --- document marker', () => {
      expect(yamlParseWriteRefusal('opp.yaml', '---\nopportunity: x\n')).toBeNull();
    });

    it('allows prose values that merely CONTAIN a colon', () => {
      // Only a TRAILING colon is the hazard; "a: b: c" inline is fine quoted,
      // and a mid-sentence colon in a quoted scalar is always fine.
      expect(
        yamlParseWriteRefusal('opp.yaml', 'note: "Phase 4: create the programme"\n'),
      ).toBeNull();
    });
  });

  describe('guard ordering', () => {
    it('leaves the narrower QA/verdict messages in front', () => {
      // A broken -qa_result.yaml should still get the actionable
      // INVALID_QA_RESULT message, not the generic floor. The server chains
      // `qa ?? verdict ?? yaml`, so assert the narrower one fires on its own.
      expect(qaResultWriteRefusal('demo-data-setup-qa_result.yaml', BROKEN_OPP_YAML)).toMatch(
        /INVALID_QA_RESULT/,
      );
      expect(verdictWriteRefusal('idea-to-pdd-eval_verdict.yaml', BROKEN_OPP_YAML)).toMatch(
        /INVALID_VERDICT/,
      );
      // ...and the floor catches what neither of them is keyed to.
      expect(qaResultWriteRefusal('opp.yaml', BROKEN_OPP_YAML)).toBeNull();
      expect(verdictWriteRefusal('opp.yaml', BROKEN_OPP_YAML)).toBeNull();
      expect(yamlParseWriteRefusal('opp.yaml', BROKEN_OPP_YAML)).toMatch(/INVALID_YAML/);
    });
  });
});
