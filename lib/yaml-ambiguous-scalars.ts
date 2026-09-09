/**
 * YAML 1.1-vs-1.2 ambiguous scalar detector — a RAW TEXT scan.
 *
 * ## Why this cannot be done on the parsed object
 *
 * ACE's state docs (`run_state.yaml`, `opp.yaml`, `decisions.yaml`, every
 * `*_verdict.yaml`) are read by TWO different YAML dialects:
 *
 *   - the `yaml` npm package and js-yaml 4.x, on the plugin side, resolve the
 *     **YAML 1.2 core schema** — `yes` is the STRING `"yes"`;
 *   - PyYAML, on ace-web's Python side, resolves **YAML 1.1** — bare `yes` is
 *     the BOOLEAN `true`.
 *
 * So an unquoted `yes` in the file means two different things depending on who
 * reads it. That divergence is invisible to `lib/run-state-validator.ts`'s
 * usual input, because by the time the validator sees a parsed object the
 * quoting is gone: under a 1.2 parser `question_value: yes` and
 * `question_value: "yes"` produce the SAME JS value. The only place the
 * distinction survives is the serialized text — hence this module scans text.
 *
 * Canonical case: dimagi-internal/ace#2296. `bednet-check-2-visit/20260908-1544`
 * recorded the Phase 4 payability predicate as
 * `phases.connect-setup.products.connect.opportunity.verification
 *  .form_field_rules[0].question_value: yes` — unquoted. The live Connect
 * config was correct (`connect_set_verification_flags` declares
 * `question_value: z.string()`), but the AUDIT RECORD of a payment-critical
 * predicate read as `"yes"` to the plugin and `True` to PyYAML. The sharp edge
 * is a read-modify-write: a YAML 1.1 reader that loads and re-dumps the file
 * turns the predicate into a boolean, which `z.string()` then rejects (loud,
 * fine) or which silently records the wrong predicate (not fine).
 *
 * ## What is, and is NOT, flagged
 *
 * FLAGGED — `yaml11-bool`: `y n yes no on off` in any case. These are plain
 * strings to a 1.2 parser and booleans to a 1.1 parser. This is the whole
 * defect class; every one of them is a genuine cross-parser divergence.
 *
 * FLAGGED — `sexagesimal`: `1:30`, `12:30:15`. Integer (base-60) in YAML 1.1,
 * string in 1.2. Note this does NOT match an ISO timestamp
 * (`2026-09-08T15:44:00Z`) — the whole scalar must be digit groups joined by
 * colons — so run_state's `completed_at` values are untouched.
 *
 * FLAGGED — `lossy-number`: a bare numeric scalar whose TEXT does not survive a
 * parse (`1.10` → `1.1`, `2.0` → `2`). Both dialects agree on the value, so it
 * is not a divergence, but the recorded text is not what any reader gets back —
 * which is exactly wrong for a version-like scalar. Quote it, or write the
 * number you mean.
 *
 * NOT FLAGGED — ISO TIMESTAMPS (`2026-09-08T21:44:35Z`, `2026-09-08`). These
 * genuinely DO diverge — YAML 1.1 has a `!!timestamp` type and resolves them to
 * a date, the YAML 1.2 core schema leaves them a string — but the divergence is
 * benign (both readers get the same instant) and `run_state.yaml` carries dozens
 * of them (`created`, `completed_at`, `checked_at`, `started_at`, `last_actor_at`
 * on every phase and step). Flagging them would bury the finding that matters
 * under a warning per timestamp. They are handled at the PRODUCER instead:
 * `update_yaml_file` serializes with `{version: '1.1'}`, which quotes any string
 * a 1.1 reader would re-resolve — timestamps included. The differential-oracle
 * test carries this as the one declared exclusion, so it stays auditable.
 *
 * NOT FLAGGED — `true false` in any case. The filed issue listed these in the
 * ambiguous set; they are not. Both YAML 1.1 and the YAML 1.2 core schema
 * resolve them to the same boolean, so there is no parser divergence to catch,
 * and `run_state.yaml` legitimately contains hundreds of them (`is_test: true`,
 * `invite_row_present: true`). Flagging them would swamp every phase-boundary
 * fence in every run with warnings about correct YAML — the exact "a correct
 * finding turned into a run-stopper" failure mode. The type-safety half of that
 * concern (a BOOLEAN landing in a field whose contract is `z.string()`) is
 * covered where the declared type is actually known: `lib/phase-products-schema.ts`.
 * There are explicit negative-control tests pinning this.
 *
 * The module is PURE — no I/O. Callers hand it text.
 */

/** Kinds of finding, ordered most-to-least severe in intent. */
export type AmbiguousScalarKind = 'yaml11-bool' | 'sexagesimal' | 'lossy-number';

export interface AmbiguousScalar {
  /** Dotted path with `[i]` for sequence elements, e.g. `a.b[0].c`. */
  path: string;
  /** 1-based line number in the scanned text. */
  line: number;
  /** The offending scalar exactly as written. */
  raw: string;
  kind: AmbiguousScalarKind;
  /** How the two dialects disagree, or why the text is lossy. */
  detail: string;
}

/**
 * Tokens that resolve to a BOOLEAN under YAML 1.1 and to a STRING under the
 * YAML 1.2 core schema. This is the authoritative divergent set; `true`/`false`
 * are deliberately absent (see the module docstring).
 */
export const YAML_11_BOOL_TOKENS: readonly string[] = [
  'y', 'Y',
  'n', 'N',
  'yes', 'Yes', 'YES',
  'no', 'No', 'NO',
  'on', 'On', 'ON',
  'off', 'Off', 'OFF',
];

/**
 * Tokens both dialects agree are booleans. Listed so the exclusion is a
 * declared decision rather than an omission, and so tests can assert they are
 * NOT flagged.
 */
export const CROSS_DIALECT_BOOL_TOKENS: readonly string[] = [
  'true', 'True', 'TRUE',
  'false', 'False', 'FALSE',
];

const BOOL_SET = new Set<string>(YAML_11_BOOL_TOKENS);

/** Whole-scalar base-60 integer: `1:30`, `12:30:15`. Not an ISO timestamp. */
const SEXAGESIMAL_RE = /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/;

/** Whole-scalar decimal number, e.g. `1.10`, `8.5`. */
const DECIMAL_RE = /^[-+]?[0-9][0-9_]*\.[0-9]+$/;

/** Block-scalar header: `|`, `>`, `|-`, `>+2`, … */
const BLOCK_SCALAR_RE = /^[|>][+-]?[0-9]*\s*(?:#.*)?$/;

/**
 * Classify one already-isolated scalar as written. Returns null when the
 * scalar is unambiguous (or quoted, or empty).
 */
export function classifyAmbiguousScalar(
  rawValue: string,
): { kind: AmbiguousScalarKind; raw: string; detail: string } | null {
  // Strip a trailing comment. Every token we care about is whitespace-free, so
  // "value #comment" only matters when the value itself has no spaces.
  const m = rawValue.match(/^(\S+)(?:\s+#.*)?$/);
  if (!m) return null;
  const raw = m[1];
  if (!raw) return null;

  // Quoted, anchored, aliased or tagged scalars are explicit — nothing to do.
  const first = raw[0];
  if (first === '"' || first === "'" || first === '&' || first === '*' || first === '!') return null;

  if (BOOL_SET.has(raw)) {
    return {
      kind: 'yaml11-bool',
      raw,
      detail:
        `unquoted \`${raw}\` is the string "${raw}" to a YAML 1.2 reader ` +
        `(the plugin's \`yaml\`/js-yaml) and the boolean ` +
        `${/^(y|yes|on)$/i.test(raw) ? 'true' : 'false'} to a YAML 1.1 reader (PyYAML, ace-web). ` +
        `Quote it to mean the string, or write true/false to mean the boolean.`,
    };
  }

  if (SEXAGESIMAL_RE.test(raw)) {
    return {
      kind: 'sexagesimal',
      raw,
      detail:
        `unquoted \`${raw}\` is a base-60 INTEGER to a YAML 1.1 reader and the ` +
        `string "${raw}" to a YAML 1.2 reader. Quote it.`,
    };
  }

  if (DECIMAL_RE.test(raw)) {
    const n = Number(raw.replace(/_/g, ''));
    if (Number.isFinite(n) && String(n) !== raw) {
      return {
        kind: 'lossy-number',
        raw,
        detail:
          `unquoted \`${raw}\` parses to ${n}, so the recorded text is not what ` +
          `any reader gets back. If it is a version or an identifier, quote it; ` +
          `if it is a number, write ${n}.`,
      };
    }
  }

  return null;
}

interface Frame {
  /** Column the frame's content starts at. */
  indent: number;
  /** Path segment: `foo` for a mapping key, `[3]` for a sequence element. */
  seg: string;
  /** True for sequence-element frames (so successive `-` reuse the frame). */
  seq: boolean;
  /** Current index, sequence frames only. */
  index: number;
}

function renderPath(stack: Frame[]): string {
  let out = '';
  for (const f of stack) {
    if (f.seq) out += f.seg;
    else out += out ? `.${f.seg}` : f.seg;
  }
  return out;
}

function unquoteKey(key: string): string {
  const t = key.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Scan serialized YAML for scalars whose meaning (or whose recorded text)
 * depends on which reader opens the file.
 *
 * Deliberately a line scanner rather than a CST walk: the point is to see the
 * bytes on disk exactly as a foreign parser would, and a line scan cannot be
 * fooled by the very resolution rules under test. It handles block mappings,
 * block sequences, comments and block scalars — the shapes `YAML.stringify`
 * emits — and quietly ignores multi-line flow collections, which ACE's writers
 * do not produce.
 */
export function findAmbiguousYamlScalars(text: string): AmbiguousScalar[] {
  const findings: AmbiguousScalar[] = [];
  if (!text) return findings;

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const stack: Frame[] = [];
  /**
   * Set while inside multi-line scalar CONTENT — a `|`/`>` block scalar, or the
   * continuation lines of a folded plain/quoted scalar. Every line at or past
   * this column is prose, not structure.
   *
   * Without this, `YAML.stringify`'s line folding turns prose into phantom
   * structure: a wrapped `summary:` whose continuation reads `Note: no`
   * scans as a mapping with the value `no` and reports a finding in a string,
   * and a continuation beginning `...]` (a real line in
   * bednet-check-2-visit/20260908-1544) reads as a YAML document-end marker
   * and resets the whole path stack.
   */
  let scalarContentMinIndent: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const indent = line.length - line.replace(/^ */, '').length;

    if (scalarContentMinIndent !== null) {
      if (indent >= scalarContentMinIndent) continue;
      scalarContentMinIndent = null;
    }

    const rest0 = line.slice(indent);
    let rest = rest0;
    if (rest.startsWith('#')) continue;
    // Document markers only count in column 0 and only as the whole token.
    if (indent === 0 && /^(?:---|\.\.\.)(?:\s|$)/.test(rest)) {
      stack.length = 0;
      continue;
    }

    // A sequence entry may be followed on the same line by a mapping key
    // (`- name: x`). Consume the dash, then treat what follows as content at
    // its true column.
    let contentIndent = indent;
    const dash = rest.match(/^-(?:\s+|$)/);
    if (dash) {
      // Pop deeper frames, and any sibling sequence frame at this column, but
      // NOT a mapping key at the same column (`key:` then `- item` at indent 0).
      while (stack.length) {
        const top = stack[stack.length - 1];
        if (top.indent > indent || (top.indent === indent && top.seq)) {
          if (top.indent === indent && top.seq) break;
          stack.pop();
        } else break;
      }
      const top = stack[stack.length - 1];
      if (top && top.seq && top.indent === indent) {
        top.index += 1;
        top.seg = `[${top.index}]`;
      } else {
        stack.push({ indent, seg: '[0]', seq: true, index: 0 });
      }
      contentIndent = indent + dash[0].length;
      rest = rest.slice(dash[0].length);
      if (!rest.trim() || rest.trimStart().startsWith('#')) continue;
    }

    // `key: value` / `key:` — a key cannot contain ': ' or start with a quote
    // we fail to close, and ACE's writers emit simple keys.
    const kv = rest.match(/^((?:"[^"]*"|'[^']*'|[^:#]+?))\s*:(\s+(.*))?$/);
    if (kv) {
      const key = unquoteKey(kv[1]);
      const value = kv[3] !== undefined ? kv[3] : '';

      // Pop every frame at or deeper than this key's column — sequence frames
      // included. Popping only mapping frames leaks a sequence frame for the
      // rest of the document and every subsequent path is wrong.
      while (stack.length && stack[stack.length - 1].indent >= contentIndent) {
        stack.pop();
      }
      stack.push({ indent: contentIndent, seg: key, seq: false, index: 0 });

      if (BLOCK_SCALAR_RE.test(value.trim())) {
        scalarContentMinIndent = contentIndent + 1;
        continue;
      }
      if (value.trim()) {
        // A key with an inline value has no children, so everything deeper is
        // this scalar's own folded continuation.
        scalarContentMinIndent = contentIndent + 1;
        const hit = classifyAmbiguousScalar(value);
        if (hit) {
          findings.push({ path: renderPath(stack), line: i + 1, raw: hit.raw, kind: hit.kind, detail: hit.detail });
        }
      }
      continue;
    }

    // A bare sequence scalar (`- yes`) — the dash frame is already on the stack.
    if (dash) {
      scalarContentMinIndent = contentIndent + 1;
      const hit = classifyAmbiguousScalar(rest);
      if (hit) {
        findings.push({ path: renderPath(stack), line: i + 1, raw: hit.raw, kind: hit.kind, detail: hit.detail });
      }
    }
  }

  return findings;
}
