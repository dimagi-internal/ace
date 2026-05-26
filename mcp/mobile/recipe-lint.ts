// mcp/mobile/recipe-lint.ts
//
// Static, parse-free lint pass on Maestro recipe YAML text. Catches
// known-broken structural shapes that produce unhelpful parser errors
// at runtime and have a documented incident class behind them.
//
// Why parse-free: the canonical case today (`inputText-scalar-with-
// sibling-option`) makes the YAML itself ambiguous to YAML parsers —
// some accept it and silently drop the sibling key, others throw with
// "expected <block end>, but found '<block mapping start>'". Detecting
// the shape via text inspection is deterministic regardless of which
// parser sees it next.
//
// Usage: `mobile_validate_recipe` calls this BEFORE shelling out to
// Maestro's validator. A violation produces a structured error with
// the rule name + remediation, so the calling agent doesn't have to
// translate Maestro's parser error back into "you wrote inputText
// wrong."

/** A single violation surfaced by the linter. */
export interface LintViolation {
  /** Stable rule name — telemetry and SKILL.md reference it. */
  rule: 'inputText-scalar-with-sibling-option' | 'unknown-property-textRegex';
  /** 1-based line number of the offending list-item start. */
  line: number;
  /** Human-readable detail. Stable enough to grep for. */
  detail: string;
  /** Canonical fix. */
  remediation: string;
}

export interface LintResult {
  ok: boolean;
  violations: LintViolation[];
}

/**
 * Lint a Maestro recipe YAML body for known-broken structural shapes.
 * Pure function — no I/O, same input always produces the same output.
 */
export function lintRecipeText(yaml: string): LintResult {
  const violations: LintViolation[] = [];
  const lines = yaml.split('\n');

  // Rule: inputText-scalar-with-sibling-option.
  //
  // Pattern (one violation per occurrence):
  //   <indent>- inputText: <scalar>
  //   <indent>  <key>: <value>          ← sibling under the SAME list item
  //
  // The scalar form `- inputText: "x"` opens a list item that's only
  // the inputText call. A sibling key under the same `-` is parsed as
  // a separate mapping → Maestro's parser surfaces it as a parse error.
  // The fix is the mapping form: `- inputText:\n    text: "x"\n    optional: true`.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comment lines.
    if (/^\s*#/.test(line)) continue;
    // Match `<indent>- inputText: <scalar>` — scalar is a quoted string
    // OR a bare token (not the start of a mapping). A trailing block-
    // start (`inputText:` followed by nothing, then a child) is the
    // CANONICAL form, not the bug — exclude it.
    const m = line.match(/^(\s*)-(\s+)inputText:\s+(.+?)\s*$/);
    if (!m) continue;
    const [, leadingIndent, , value] = m;
    // If the value is empty or a block-scalar indicator, the next line
    // is the mapping body — that's the correct form.
    if (value === '' || value === '|' || value === '>') continue;
    // Look at the next non-blank, non-comment line. If it's indented
    // *deeper* than the `-` (i.e. nested under the same list item),
    // and it parses as `<key>: <value>`, we have a sibling key under a
    // scalar inputText — the bug.
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      if (/^\s*$/.test(next)) continue;
      if (/^\s*#/.test(next)) continue;
      // A new list item (same or shallower indent + `-`) ends this list
      // item, no violation.
      const nextIndentMatch = next.match(/^(\s*)/);
      const nextIndent = nextIndentMatch ? nextIndentMatch[1].length : 0;
      const dashStartIndent = leadingIndent.length;
      if (nextIndent <= dashStartIndent && /^\s*-\s/.test(next)) break;
      // A shallower-or-equal line that isn't a sibling-of-this-item
      // also ends the item.
      if (nextIndent <= dashStartIndent) break;
      // Sibling key under the SAME list item: must be deeper than the
      // dash and parse as `key: value`.
      if (nextIndent > dashStartIndent && /^\s*[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(next)) {
        violations.push({
          rule: 'inputText-scalar-with-sibling-option',
          line: i + 1,
          detail:
            `\`- inputText: ${value.trim()}\` (line ${i + 1}) is a scalar form but a sibling key follows on line ${j + 1} — Maestro rejects this with "expected <block end>, but found '<block mapping start>'"`,
          remediation:
            `use the mapping form: replace with \`- inputText:\n    text: ${value.trim()}\n    <option>: <value>\``,
        });
      }
      break;
    }
  }

  // Rule: unknown-property-textRegex.
  //
  // Maestro 2.5.1 (current pin in both local + cloud AMI) does NOT
  // accept `textRegex` as a property on any matcher. A recipe that
  // uses it surfaces at parse time as:
  //
  //     > Unknown Property: textRegex
  //
  // and the WHOLE recipe fails before any step runs. The canonical
  // intent ("match if any of these texts appear") can be expressed via
  // `text:` (substring/regex-aware in Maestro's own matcher) on a
  // single strong anchor, OR via the cli's regex form `id: <selector>`
  // when an id is available. Either way, raw `textRegex:` is never
  // valid.
  //
  // Bug class introduced 2026-05-25 on `connect-register-from-otp.yaml`
  // line 293 — bednet-spot-check/20260525-2022 Phase 6 hit it during
  // `mobile_ensure_avd_running`'s auto-bootstrap and halted the whole
  // run before any Phase 6 work could fire. Lint rule added so the
  // class is structurally impossible to reintroduce.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line)) continue;
    // Match a YAML key `textRegex:` at any indent.
    if (/^\s*textRegex\s*:/.test(line)) {
      violations.push({
        rule: 'unknown-property-textRegex',
        line: i + 1,
        detail:
          `\`textRegex\` (line ${i + 1}) is not a valid Maestro property on Maestro 2.5.1. The recipe will fail at parse time with "Unknown Property: textRegex" before any step runs.`,
        remediation:
          `Replace with \`text: "<single-anchor>"\` (Maestro's text matcher is substring/regex-aware on a single anchor) or use \`id: "<resource-id>"\` when a stable resource id is available. To wait on any-of-N text alternatives, sequence multiple \`extendedWaitUntil\` blocks (each with \`optional: true\`) or just pick the strongest single anchor.`,
      });
    }
  }

  return { ok: violations.length === 0, violations };
}
