/**
 * Tests for `lib/yaml-ambiguous-scalars.ts` — the raw-text detector for
 * scalars whose meaning depends on which YAML dialect reads the file.
 *
 * Regression anchor: dimagi-internal/ace#2296. The Phase 4 payability
 * predicate reached Drive as an UNQUOTED `yes`, which the plugin's YAML 1.2
 * readers see as the string `"yes"` and PyYAML (ace-web's Python side) sees as
 * the boolean `true`. `question_value` is what decides whether a follow-up
 * visit is payable, so its audit record was parser-dependent on a
 * payment-critical field.
 *
 * The controls in `§ the verbatim block` are byte-for-byte from
 * `ACE/bednet-check-2-visit/runs/20260908-1544/run_state.yaml` (lines 929-947,
 * revision 102) so the regression is anchored to real output rather than to a
 * hand-typed approximation of it.
 *
 * The differential oracle at the bottom is the strongest of these: it does not
 * trust a hand-maintained token list at all. It parses the same text under both
 * dialects using the `yaml` package's own resolvers and asserts the detector
 * flags every path on which they disagree.
 */

import { describe, it, expect } from 'vitest';
import YAML from 'yaml';
import {
  findAmbiguousYamlScalars,
  classifyAmbiguousScalar,
  YAML_11_BOOL_TOKENS,
  CROSS_DIALECT_BOOL_TOKENS,
} from '../../lib/yaml-ambiguous-scalars.js';

/** Verbatim from the run, with the surrounding nesting that produces the path. */
const VERBATIM_BARE = `phases:
  connect-setup:
    products:
      connect:
        opportunity:
          payment_units:
            - payment_unit_uuid: c4b59b66-999d-4139-8746-14c83bc1cc6e
              name: Verified follow-up day
              amount: 12
              org_amount: 0
              max_total: 17
              max_daily: 1
              required_deliver_units:
                - 6862
          verification:
            form_field_rules:
              - name: consent_confirmed=yes
                question_path: form.consent_to_continue.consent_confirmed
                question_value: yes
                deliver_unit_id: 6862
            form_field_rules_saved: 1
        ace_test_user:
          phone: "+74260000101"
          invite_row_present: true
          connect_user_id: null
`;

/** The same block with the one-character fix applied. */
const VERBATIM_QUOTED = VERBATIM_BARE.replace('question_value: yes', 'question_value: "yes"');

const PREDICATE_PATH =
  'phases.connect-setup.products.connect.opportunity.verification.form_field_rules[0].question_value';

describe('findAmbiguousYamlScalars — the verbatim block (ace#2296)', () => {
  it('flags the bare `yes` payability predicate, and names its full path', () => {
    const found = findAmbiguousYamlScalars(VERBATIM_BARE);
    expect(found).toHaveLength(1);
    expect(found[0].path).toBe(PREDICATE_PATH);
    expect(found[0].raw).toBe('yes');
    expect(found[0].kind).toBe('yaml11-bool');
    // Line 18 of this fixture is `question_value: yes`.
    expect(VERBATIM_BARE.split('\n')[found[0].line - 1].trim()).toBe('question_value: yes');
  });

  it('does NOT flag the same block once the predicate is quoted', () => {
    expect(findAmbiguousYamlScalars(VERBATIM_QUOTED)).toEqual([]);
  });

  it('is the ONLY finding in the block — `true`, `null`, the uuid and the phone are clean', () => {
    // Every other scalar in the real block is either an unambiguous boolean,
    // an unambiguous null, a number, or already quoted. A detector that fired
    // on any of them would emit noise on every phase boundary of every run.
    const paths = findAmbiguousYamlScalars(VERBATIM_BARE).map((f) => f.path);
    expect(paths).toEqual([PREDICATE_PATH]);
  });

  it('the two dialects really do disagree on the bare form and agree on the quoted one', () => {
    const at = (text: string) =>
      (YAML.parse(text) as any).phases['connect-setup'].products.connect.opportunity.verification
        .form_field_rules[0].question_value;
    const at11 = (text: string) =>
      (YAML.parse(text, { version: '1.1' }) as any).phases['connect-setup'].products.connect
        .opportunity.verification.form_field_rules[0].question_value;

    expect(at(VERBATIM_BARE)).toBe('yes');
    expect(at11(VERBATIM_BARE)).toBe(true); // the defect
    expect(at(VERBATIM_QUOTED)).toBe('yes');
    expect(at11(VERBATIM_QUOTED)).toBe('yes'); // fixed
  });
});

describe('findAmbiguousYamlScalars — the ambiguous token set', () => {
  it.each(YAML_11_BOOL_TOKENS)('flags bare `%s` (string in 1.2, boolean in 1.1)', (token) => {
    const found = findAmbiguousYamlScalars(`question_value: ${token}\n`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ path: 'question_value', raw: token, kind: 'yaml11-bool' });
  });

  it.each(YAML_11_BOOL_TOKENS)('does NOT flag `%s` once double-quoted', (token) => {
    expect(findAmbiguousYamlScalars(`question_value: "${token}"\n`)).toEqual([]);
  });

  it.each(YAML_11_BOOL_TOKENS)('does NOT flag `%s` once single-quoted', (token) => {
    expect(findAmbiguousYamlScalars(`question_value: '${token}'\n`)).toEqual([]);
  });

  // ace#2296 listed `true|false` in the ambiguous set. They are NOT ambiguous:
  // YAML 1.1 and the YAML 1.2 core schema both resolve them to the same
  // boolean, so there is no cross-parser divergence to catch — and run_state
  // legitimately carries hundreds of them. Flagging them would put a warning
  // on correct YAML in every phase boundary fence of every run.
  it.each(CROSS_DIALECT_BOOL_TOKENS)(
    'does NOT flag bare `%s` — both dialects agree it is a boolean',
    (token) => {
      expect(findAmbiguousYamlScalars(`is_test: ${token}\n`)).toEqual([]);
      expect(YAML.parse(`v: ${token}`).v).toBe(YAML.parse(`v: ${token}`, { version: '1.1' }).v);
    },
  );

  it('flags a sexagesimal (base-60 integer in 1.1, string in 1.2)', () => {
    const found = findAmbiguousYamlScalars('duration: 1:30\n');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ path: 'duration', raw: '1:30', kind: 'sexagesimal' });
    expect(YAML.parse('v: 1:30').v).toBe('1:30');
    expect(YAML.parse('v: 1:30', { version: '1.1' }).v).toBe(90);
  });

  it('does NOT flag an ISO timestamp — run_state is full of them', () => {
    expect(findAmbiguousYamlScalars('completed_at: 2026-09-08T15:44:00Z\n')).toEqual([]);
    expect(findAmbiguousYamlScalars('created: 2026-09-08\n')).toEqual([]);
  });

  it('flags a number whose recorded TEXT does not survive a parse', () => {
    const found = findAmbiguousYamlScalars('apk_version: 1.10\n');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ path: 'apk_version', kind: 'lossy-number' });
    expect(YAML.parse('v: 1.10').v).toBe(1.1); // the trailing zero is gone
  });

  it('does NOT flag ordinary decimals — eval scores must stay quiet', () => {
    // Every `\d+\.\d+` in the real bednet run_state is an eval score.
    for (const score of ['9.15', '8.5', '7.48', '8.62', '9.5']) {
      expect(findAmbiguousYamlScalars(`score: ${score}\n`)).toEqual([]);
    }
  });

  it('flags a bare ambiguous token in a SEQUENCE element', () => {
    const found = findAmbiguousYamlScalars('answers:\n  - yes\n  - "no"\n  - off\n');
    expect(found.map((f) => [f.path, f.raw])).toEqual([
      ['answers[0]', 'yes'],
      ['answers[2]', 'off'],
    ]);
  });
});

describe('findAmbiguousYamlScalars — false-positive controls', () => {
  // `YAML.stringify` FOLDS long strings across lines. Every one of these
  // controls is prose that reads as structure to a naive line scan; each cost
  // a real misread while this detector was being built.
  it('does not scan the folded continuation of a plain scalar as structure', () => {
    const text = 'phases:\n  p:\n    summary: A long note about the gate\n      Note: no evidence was captured\n';
    expect(findAmbiguousYamlScalars(text)).toEqual([]);
  });

  it('does not treat a continuation beginning `...]` as a document-end marker', () => {
    // Verbatim shape from bednet-check-2-visit/20260908-1544 line 666, which
    // reset the path stack and corrupted every path after it.
    const text =
      'phases:\n  idea-to-design:\n' +
      '    note: the bracketed\n      ...] citation is never verified; the PDD cites idea.md\n' +
      '  connect-setup:\n    products:\n      x: yes\n';
    const found = findAmbiguousYamlScalars(text);
    expect(found).toHaveLength(1);
    expect(found[0].path).toBe('phases.connect-setup.products.x');
  });

  it('does not scan block-scalar content', () => {
    const text = 'notes: |\n  yes\n  question_value: no\nstatus: done\n';
    expect(findAmbiguousYamlScalars(text)).toEqual([]);
  });

  it('does not scan comments', () => {
    expect(findAmbiguousYamlScalars('# question_value: yes\nstatus: done\n')).toEqual([]);
  });

  it('ignores a trailing comment when classifying the value', () => {
    const found = findAmbiguousYamlScalars('question_value: yes  # from the CCZ\n');
    expect(found).toHaveLength(1);
    expect(found[0].raw).toBe('yes');
  });

  it('is clean on an empty or whitespace-only document', () => {
    expect(findAmbiguousYamlScalars('')).toEqual([]);
    expect(findAmbiguousYamlScalars('\n\n  \n')).toEqual([]);
  });
});

describe('classifyAmbiguousScalar', () => {
  it('returns null for an anchor, alias or tag rather than guessing', () => {
    expect(classifyAmbiguousScalar('&anchor')).toBeNull();
    expect(classifyAmbiguousScalar('*alias')).toBeNull();
    expect(classifyAmbiguousScalar('!!str yes')).toBeNull();
  });

  it('returns null for a multi-word plain scalar containing an ambiguous word', () => {
    expect(classifyAmbiguousScalar('yes it was')).toBeNull();
  });
});

describe('findAmbiguousYamlScalars — differential oracle', () => {
  /**
   * Walk both parses and collect every leaf path where the two dialects
   * disagree. This is ground truth that owes nothing to the token list.
   */
  function divergentPaths(text: string): string[] {
    const a = YAML.parse(text);
    const b = YAML.parse(text, { version: '1.1' });
    const out: string[] = [];
    const walk = (x: any, y: any, path: string): void => {
      if (Array.isArray(x) && Array.isArray(y)) {
        for (let i = 0; i < x.length; i++) walk(x[i], y[i], `${path}[${i}]`);
      } else if (x && y && typeof x === 'object' && typeof y === 'object') {
        for (const k of Object.keys(x)) walk(x[k], y[k], path ? `${path}.${k}` : k);
      } else if (x !== y && !(x instanceof Date && y instanceof Date)) {
        out.push(path);
      }
    };
    walk(a, b, '');
    return out.sort();
  }

  const DOC = `run_id: 20260908-1544
predicate: yes
negated: no
toggle: on
disabled: off
short_y: y
short_n: n
quoted_yes: "yes"
real_bool: true
count: 12
score: 8.5
started_at: 2026-09-08T21:44:35Z
answers:
  - yes
  - "no"
nested:
  deeper:
    value: OFF
`;

  /**
   * The ONE declared exclusion. ISO timestamps really do diverge (1.1 resolves
   * `!!timestamp`, 1.2 core leaves a string) but the divergence is benign and
   * run_state carries dozens per file, so flagging them would bury the finding
   * that matters. They are fixed at the producer instead — `update_yaml_file`
   * stringifies with `{version: '1.1'}`, which quotes them. Listing the
   * exclusion here rather than in the detector keeps it auditable: adding a
   * second silent exclusion fails this test.
   */
  const TIMESTAMP_KEYS = ['started_at'];

  it('flags every path on which YAML 1.1 and YAML 1.2 disagree (bar the declared timestamp exclusion)', () => {
    const divergent = divergentPaths(DOC);
    // Sanity: the oracle must actually have found the divergences, or this
    // test would pass vacuously.
    expect(divergent).toContain('predicate');
    expect(divergent.length).toBeGreaterThanOrEqual(8);

    const flagged = findAmbiguousYamlScalars(DOC).map((f) => f.path).sort();
    const unflagged = divergent.filter((p) => !flagged.includes(p));
    expect(unflagged).toEqual(TIMESTAMP_KEYS);
  });

  it('the timestamp exclusion is a real divergence, and the producer fix covers it', () => {
    expect(YAML.parse('started_at: 2026-09-08T21:44:35Z').started_at).toBe('2026-09-08T21:44:35Z');
    expect(YAML.parse('started_at: 2026-09-08T21:44:35Z', { version: '1.1' }).started_at)
      .toBeInstanceOf(Date);
    // Serializing the 1.2 value under 1.1 rules quotes it, so both dialects
    // then read the same string back.
    const requoted = YAML.stringify({ started_at: '2026-09-08T21:44:35Z' }, { version: '1.1' });
    expect(requoted.trim()).toBe('started_at: "2026-09-08T21:44:35Z"');
    expect(YAML.parse(requoted, { version: '1.1' }).started_at).toBe('2026-09-08T21:44:35Z');
  });

  it('flags nothing that the two dialects agree on', () => {
    const divergent = new Set(divergentPaths(DOC));
    for (const f of findAmbiguousYamlScalars(DOC)) {
      if (f.kind === 'yaml11-bool' || f.kind === 'sexagesimal') {
        expect(divergent.has(f.path)).toBe(true);
      }
    }
  });
});
