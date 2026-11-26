/**
 * dimagi-internal/ace — a malformed ruling store must be refused AT THE WRITE.
 *
 * ## The live incident
 *
 * Opp `accra-vendor-survey`, run `20261125-1637`, Phase 1 (2026-11-26).
 * `inputs/decision-overrides.yaml` was authored carrying eleven operator
 * rulings forwarded from the tekzal round-1 run. One of the eleven bound its
 * ruling to a prior run's `run_state.yaml` key and spelled the ref with the
 * YAML key's own underscores:
 *
 *     feedback_ref: 20261013-2314-run_state/blockers_for_operator
 *
 * `DecisionOverrideRowSchema.feedback_ref` is kebab-case on BOTH sides of the
 * slash (`lib/decision-overrides.ts`), so the file is invalid. And validation
 * there is all-or-nothing BY DESIGN — a malformed overrides file means a
 * reviewer's saved intent would otherwise be silently dropped, so ACE halts
 * the decisions write rather than ship a run that ignores an expert's review.
 *
 * So ONE bad ref discarded ALL ELEVEN rulings and hard-blocked the phase.
 *
 * ## Why the fix is here and not at a synthesizer
 *
 * There is no synthesizer. Nothing in this repo and nothing in ace-web ever
 * emits a `feedback_ref` into `decision-overrides.yaml` — ace-web's
 * `make_override_row` (`apps/opps/decision_overrides.py`) writes a fixed field
 * list that does not include it. Both ruling stores under `<opp>/inputs/` are
 * hand-authored through `drive_create_file` / `drive_update_file` /
 * `drive_upload_binary` / `update_yaml_file`, which is exactly the authoring
 * path `lib/qa-result-write-guard.ts` already exists to police for
 * `*-qa_result.yaml`, `*_verdict.yaml` and unparseable YAML (ace#2866).
 *
 * These two files were the hole left in that guard, and they are the worst
 * kind to leave: they parse, so `yamlParseWriteRefusal` passes them, and the
 * only reader that checks their SHAPE runs deep inside a phase, days later,
 * where its refusal is fatal to the whole file.
 *
 * Refusing the write — never rewriting it — is deliberate. `feedback_ref` is
 * a BINDING KEY naming a specific reviewer comment; silently kebab-casing it
 * would bind an operator's ruling to whatever comment the corrected spelling
 * happens to name, which is the data-integrity property the fail-loud
 * contract exists to protect. The refusal SUGGESTS the kebab spelling and
 * leaves the choice to the author.
 */
import { describe, it, expect } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';

import {
  rulingStoreWriteRefusal,
  qaResultWriteRefusal,
  verdictWriteRefusal,
  yamlParseWriteRefusal,
} from '../../lib/qa-result-write-guard';
import { parseDecisionOverridesYaml } from '../../lib/decision-overrides';
import { kebabFeedbackRef } from '../../lib/feedback-ledger';

/** The verbatim shape that blocked `accra-vendor-survey/20261125-1637`. */
const BAD_REF = '20261013-2314-run_state/blockers_for_operator';
const GOOD_REF = '20261013-2314-run-state/blockers-for-operator';

function overridesFile(refs: (string | undefined)[]): string {
  return stringifyYaml({
    schema_version: 1,
    kind: 'decision-overrides',
    opp: 'accra-vendor-survey',
    updated_at: '2026-11-25T16:37:00Z',
    overrides: refs.map((ref, i) => ({
      id: `carried-ruling-${i + 1}`,
      override: 'Follow the operator ruling',
      override_reasoning: 'Carried forward from the round-1 run.',
      ...(ref ? { feedback_ref: ref } : {}),
      decided_by: 'stewari@dimagi.com',
      decided_at: '2026-10-13',
      source_run_id: '20261013-2314',
    })),
  });
}

describe('rulingStoreWriteRefusal — the accra-vendor-survey incident', () => {
  it('REFUSES the verbatim bad row at the write, naming the field and the value', () => {
    const refusal = rulingStoreWriteRefusal('decision-overrides.yaml', overridesFile([BAD_REF]));
    expect(refusal).toBeTruthy();
    expect(refusal).toMatch(/INVALID_DECISION_OVERRIDES/);
    expect(refusal).toContain('feedback_ref');
    // The offending VALUE, not just the field path — otherwise the author has
    // to diff eleven rows against a regex to find which one it is.
    expect(refusal).toContain(BAD_REF);
    expect(refusal).toMatch(/Nothing was written/);
  });

  it('suggests the kebab-case spelling rather than silently rewriting it', () => {
    const refusal = rulingStoreWriteRefusal('decision-overrides.yaml', overridesFile([BAD_REF]));
    expect(refusal).toContain(GOOD_REF);
  });

  it('is the ONLY thing that would have caught it — the file parses fine', () => {
    const text = overridesFile([BAD_REF]);
    expect(yamlParseWriteRefusal('decision-overrides.yaml', text)).toBeNull();
    expect(qaResultWriteRefusal('decision-overrides.yaml', text)).toBeNull();
    expect(verdictWriteRefusal('decision-overrides.yaml', text)).toBeNull();
  });

  it('the refused bytes are exactly what the phase-time reader rejects', () => {
    // Same verdict, one write earlier. Without the guard this throw is the
    // FIRST signal, and by then it is all-or-nothing over the whole file.
    expect(() => parseDecisionOverridesYaml(overridesFile([BAD_REF]))).toThrow(/feedback_ref/);
  });

  it('one bad ref among ten good ones is what makes write-time the right place', () => {
    const refs = [...Array(10).keys()].map((i) => `20260727-sophie-feintuch/item-${i}`);
    expect(rulingStoreWriteRefusal('decision-overrides.yaml', overridesFile(refs))).toBeNull();
    const refusal = rulingStoreWriteRefusal(
      'decision-overrides.yaml',
      overridesFile([...refs, BAD_REF]),
    );
    expect(refusal).toContain(BAD_REF);
  });

  it('accepts the corrected file', () => {
    expect(rulingStoreWriteRefusal('decision-overrides.yaml', overridesFile([GOOD_REF]))).toBeNull();
    expect(rulingStoreWriteRefusal('decision-overrides.yaml', overridesFile([undefined]))).toBeNull();
  });

  it('refuses the other v1 breakages the same way', () => {
    const unparseable = 'schema_version: 1\nkind: decision-overrides\nopp: x\noverrides: [';
    expect(rulingStoreWriteRefusal('decision-overrides.yaml', unparseable)).toMatch(
      /INVALID_DECISION_OVERRIDES/,
    );
    const futureVersion = overridesFile([GOOD_REF]).replace('schema_version: 1', 'schema_version: 2');
    expect(rulingStoreWriteRefusal('decision-overrides.yaml', futureVersion)).toMatch(
      /INVALID_DECISION_OVERRIDES/,
    );
  });

  it('names only files it owns — every other YAML is untouched', () => {
    const text = overridesFile([BAD_REF]);
    for (const name of ['run_state.yaml', 'opp.yaml', 'decisions.yaml', 'notes.md', '']) {
      expect(rulingStoreWriteRefusal(name, text)).toBeNull();
    }
    // A path-qualified name still matches on the basename — the atoms pass a
    // bare name today, but a caller that passes `inputs/decision-overrides.yaml`
    // must not slip through.
    expect(rulingStoreWriteRefusal('inputs/decision-overrides.yaml', text)).toMatch(
      /INVALID_DECISION_OVERRIDES/,
    );
  });
});

describe('rulingStoreWriteRefusal — operator-rulings.yaml, the same class', () => {
  function rulingsFile(id: string): string {
    return stringifyYaml({
      schema_version: 1,
      kind: 'operator-rulings',
      opp: 'accra-vendor-survey',
      rulings: [
        {
          id,
          ruling: 'Devices are costed separately and asked about.',
          overrides: 'devices-assumed',
          decided_by: 'stewari@dimagi.com',
          decided_at: '2026-10-04',
          applies_to: ['pdd'],
        },
      ],
    });
  }

  it('REFUSES an underscored ruling id — it becomes the second half of a feedback_ref', () => {
    // `rulingDecisionRow` stamps `feedback_ref: operator-rulings/<id>`
    // (lib/operator-rulings.ts), so an id the ruling file accepted but the
    // decisions schema would not is the same defect one file over.
    const refusal = rulingStoreWriteRefusal('operator-rulings.yaml', rulingsFile('devices_costed_separately'));
    expect(refusal).toMatch(/INVALID_OPERATOR_RULINGS/);
    expect(refusal).toContain('devices_costed_separately');
    expect(refusal).toMatch(/Nothing was written/);
  });

  it('accepts a well-formed ruling store', () => {
    expect(rulingStoreWriteRefusal('operator-rulings.yaml', rulingsFile('devices-costed-separately'))).toBeNull();
  });
});

describe('kebabFeedbackRef', () => {
  it('kebab-cases both halves and leaves a valid ref alone', () => {
    expect(kebabFeedbackRef(BAD_REF)).toBe(GOOD_REF);
    expect(kebabFeedbackRef(GOOD_REF)).toBe(GOOD_REF);
    expect(kebabFeedbackRef('20260727-sophie-feintuch/c')).toBe('20260727-sophie-feintuch/c');
  });

  it('returns null when there is no single-slash ref to suggest a spelling for', () => {
    expect(kebabFeedbackRef('no-slash-at-all')).toBeNull();
    expect(kebabFeedbackRef('too/many/parts')).toBeNull();
    expect(kebabFeedbackRef('___/___')).toBeNull();
  });
});
