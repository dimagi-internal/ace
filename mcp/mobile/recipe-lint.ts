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

import { parseAllDocuments, isMap, isSeq, type Node } from 'yaml';

/** A single violation surfaced by the linter. */
export interface LintViolation {
  /** Stable rule name — telemetry and SKILL.md reference it. */
  rule:
    | 'inputText-scalar-with-sibling-option'
    | 'unknown-property-textRegex'
    | 'runFlow-guard-scope-mismatch'
    | 'runFlow-unbound-screenshot-name';
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
 * Palette subflows that name a screenshot from a caller-supplied env var,
 * and the env keys every call site MUST bind.
 *
 * WHY A CALL SITE, NOT A DEFAULT (dimagi-internal/ace#1033).
 *
 * A Maestro flow's own top-level `env:` block does NOT behave like a
 * default — it OVERRIDES whatever the caller passed. Measured against the
 * pinned Maestro 2.5.1 source:
 *
 *   - `MaestroFlowParser.parseFlow` emits the subflow's own `env:` as a
 *     `DefineVariablesCommand` PREPENDED to the subflow body:
 *     `[ApplyConfiguration, DefineVariables(subflowEnv), ...body]`.
 *   - `YamlFluentCommand.runFlow` then wraps the caller's env AROUND that
 *     list via `Env.withEnv`, which PREPENDS another one:
 *     `[DefineVariables(callerEnv), ApplyConfiguration,
 *       DefineVariables(subflowEnv), ...body]`.
 *   - `Orchestra.runSubFlow` runs every `DefineVariablesCommand` in LIST
 *     ORDER, and `GraalJsEngine.putEnv` assigns unconditionally. Last
 *     write wins → the SUBFLOW's `env:` clobbers the caller's.
 *
 * (Identical shape for the root flow + CLI `-e`: `TestRunner` prepends the
 * CLI env, so a root flow's own `env:` also wins over `-e`.)
 *
 * Live corroboration: bednet-spot-check/20260728-2222 Phase 6 —
 * `journey-learn.yaml` passed `SCREENSHOT_NAME_PRE_SUBMIT:
 * "journey-learn-result"` / `..._POST_SUBMIT: "journey-learn-submitted"`,
 * and the files that landed on disk were `form-submit-pre.png` /
 * `form-submit-post.png`: the subflow's defaults.
 *
 * So palette subflows carry NO screenshot-name `env:` defaults (they would
 * silently defeat per-journey naming — the #852 fix did exactly that), and
 * the caller is the ONLY source of the name. That makes an unbound call
 * site the remaining failure mode (Maestro renders the unset placeholder
 * as the literal string `undefined`, so the frame lands as
 * `undefined.png`) — which is what this rule catches at authoring time.
 *
 * Keep in sync with the palette: `test/mcp/mobile/static-recipe-invariants.test.ts`
 * derives the required keys from the actual `${SCREENSHOT_NAME*}`
 * references under `mcp/mobile/recipes/static/` and fails on drift.
 */
export const PALETTE_REQUIRED_SCREENSHOT_ENV: Record<string, readonly string[]> = {
  'form-advance.yaml': ['SCREENSHOT_NAME'],
  'form-submit.yaml': ['SCREENSHOT_NAME_PRE_SUBMIT', 'SCREENSHOT_NAME_POST_SUBMIT'],
  'content-form-finish.yaml': ['SCREENSHOT_NAME'],
  'content-form-finish-to-suite.yaml': ['SCREENSHOT_NAME'],
};

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

  // Rule: runFlow-guard-scope-mismatch.
  //
  // Pattern: a `runFlow` whose `when:` guard matches on a bare
  // element (`visible: { id: <x> }`) with NO scope qualifier
  // (`below:` / `above:` / `containsChild:` / `index:`), but whose
  // BODY contains a `scrollUntilVisible` (or `tapOn`) whose element
  // IS scoped (`below:` / `above:` ...) AND is NOT marked
  // `optional: true`.
  //
  // The guard decides whether to enter the block; if it matches on
  // ANY rendered instance of `<x>` (e.g. a stale prior-run tile's
  // button) while the scoped body acts on a DIFFERENT instance (this
  // run's target card, which may not be present in the same section),
  // the non-optional scoped step hard-fails inside an entered block —
  // aborting the whole flow instead of falling through to a sibling
  // branch. The guard scope and the body scope disagree.
  //
  // The fix is one of:
  //   (a) scope the `when:` guard to the same anchor as the body
  //       (`below: text: ${...}` etc.), so the guard only fires for
  //       the target instance; OR
  //   (b) mark the scoped body step `optional: true`, so a
  //       missing-target inside an intentionally-broad guard no-ops
  //       and control falls through.
  //
  // Bug class root-caused live on connect-claim-opp.yaml
  // (malaria-itn-app run 20260528-1607 Phase 6): a stale "Bednet
  // Spot-Check" Resume tile higher in the list matched the unscoped
  // `when: visible: { id: btn_resume }` guard, the block entered, and
  // the non-optional `scrollUntilVisible btn_resume below: text:
  // ${OPP_NAME}` hard-failed because this run's target was a New
  // Opportunity (not in the In-Progress section). Lint rule added so
  // the unscoped-guard / scoped-body class is structurally impossible
  // to reintroduce in any palette or generated recipe.
  for (const v of findGuardScopeMismatches(yaml)) {
    violations.push(v);
  }

  // Rule: runFlow-unbound-screenshot-name.
  //
  // A `runFlow` into a palette subflow that names its screenshot from
  // `${SCREENSHOT_NAME...}` MUST bind every such key in that runFlow's own
  // `env:` block. See PALETTE_REQUIRED_SCREENSHOT_ENV above for the measured
  // Maestro precedence rule this enforces (dimagi-internal/ace#1033, the
  // recurrence of #852 through form-advance.yaml).
  //
  // Unbound, Maestro substitutes the literal string `undefined`, so the
  // frame lands on disk as `undefined.png` — and a second unbound
  // takeScreenshot in the same subflow OVERWRITES the first, silently
  // collapsing a pre/post pair into one image. Both were observed live.
  for (const v of findUnboundScreenshotNames(yaml)) {
    violations.push(v);
  }

  return { ok: violations.length === 0, violations };
}

/** Property keys that scope a matcher to a SPECIFIC node among several
 * sharing an id/text (vs. matching any rendered instance). */
const SCOPE_KEYS = ['below', 'above', 'leftOf', 'rightOf', 'containsChild', 'childOf', 'index'];

/** A matcher node is "scoped" if it carries any SCOPE_KEY. */
function matcherIsScoped(node: unknown): boolean {
  if (!isMap(node)) return false;
  return SCOPE_KEYS.some((k) => node.has(k));
}

/** A matcher node is "bare" (unscoped) if it has a primary anchor
 * (id/text) but no SCOPE_KEY. */
function matcherIsBare(node: unknown): boolean {
  if (!isMap(node)) return false;
  const hasAnchor = node.has('id') || node.has('text');
  return hasAnchor && !SCOPE_KEYS.some((k) => node.has(k));
}

/** Walk every `runFlow` in the recipe and flag the
 * unscoped-guard-with-scoped-non-optional-body antipattern. Returns one
 * violation per offending runFlow (reported at the runFlow's line). */
function findGuardScopeMismatches(yaml: string): LintViolation[] {
  const out: LintViolation[] = [];
  let docs: ReturnType<typeof parseAllDocuments>;
  try {
    docs = parseAllDocuments(yaml);
  } catch {
    // Unparseable YAML is caught by other rules / the parser gate;
    // this structural rule simply abstains.
    return out;
  }

  // Single generic recursion: at every map node, if it carries a
  // `runFlow`, check that runFlow for the antipattern; then recurse
  // into every child value (which reaches nested command lists +
  // nested runFlows exactly once).
  const visit = (node: Node | null): void => {
    if (node == null) return;
    if (isSeq(node)) {
      for (const item of node.items) visit(item as Node);
      return;
    }
    if (!isMap(node)) return;

    const runFlow = node.get('runFlow', true);
    if (isMap(runFlow)) {
      checkRunFlow(node, runFlow);
    }
    // Recurse into all map values to reach nested sequences / runFlows.
    for (const pair of node.items) {
      visit(pair.value as Node);
    }
  };

  const checkRunFlow = (host: Node, runFlow: Node): void => {
    if (!isMap(runFlow)) return;
    const when = runFlow.get('when', true);
    const guardMatcher = isMap(when) ? when.get('visible', true) : null;
    const commands = runFlow.get('commands', true);
    if (!guardMatcher || !matcherIsBare(guardMatcher) || !isSeq(commands)) return;

    for (const cmd of commands.items) {
      if (!isMap(cmd)) continue;
      for (const verb of ['scrollUntilVisible', 'tapOn'] as const) {
        const step = cmd.get(verb, true);
        if (!isMap(step)) continue;
        const isOptional = step.get('optional') === true;
        // scrollUntilVisible wraps its matcher under `element:`;
        // tapOn carries the matcher inline.
        const matcher = step.has('element') ? step.get('element', true) : step;
        if (matcherIsScoped(matcher) && !isOptional) {
          const rangeStart = (host.range && host.range[0]) ?? 0;
          const line = yaml.slice(0, rangeStart).split('\n').length;
          const scopeKeys = SCOPE_KEYS.filter((k) => isMap(matcher) && matcher.has(k)).join('/');
          out.push({
            rule: 'runFlow-guard-scope-mismatch',
            line,
            detail:
              `runFlow at line ${line} has an UNSCOPED \`when: visible:\` guard (matches any rendered instance of the anchor) but its body's \`${verb}\` is SCOPED (${scopeKeys}) and not \`optional: true\` — if the guard matches a stale/sibling instance, the scoped step hard-fails inside the entered block and aborts the flow`,
            remediation:
              `either scope the \`when:\` guard to the same anchor as the body (e.g. add \`below: { text: \${OPP_NAME} }\`), OR mark the scoped \`${verb}\` step \`optional: true\` so a missing target no-ops and control falls through to a sibling branch`,
          });
          // One violation per runFlow is enough.
          return;
        }
      }
    }
  };

  for (const doc of docs) {
    if (doc.contents) visit(doc.contents as Node);
  }
  return out;
}

/** Basename of a `runFlow: file:` reference — tolerates `./x.yaml` and
 * any directory prefix a generated recipe might carry. */
function flowBasename(ref: string): string {
  return ref.trim().replace(/^.*\//, '');
}

/**
 * Walk every `runFlow` in the recipe and flag calls into a screenshot-naming
 * palette subflow that do not bind the subflow's required `SCREENSHOT_NAME*`
 * env keys. One violation per missing key, reported at the runFlow's line.
 */
function findUnboundScreenshotNames(yaml: string): LintViolation[] {
  const out: LintViolation[] = [];
  let docs: ReturnType<typeof parseAllDocuments>;
  try {
    docs = parseAllDocuments(yaml);
  } catch {
    return out;
  }

  const lineOf = (node: Node): number => {
    const start = (node.range && node.range[0]) ?? 0;
    return yaml.slice(0, start).split('\n').length;
  };

  const report = (host: Node, filename: string, missing: string[]): void => {
    const line = lineOf(host);
    const required = PALETTE_REQUIRED_SCREENSHOT_ENV[filename].join(' + ');
    out.push({
      rule: 'runFlow-unbound-screenshot-name',
      line,
      detail:
        `runFlow into \`${filename}\` at line ${line} does not bind ${missing
          .map((k) => `\`${k}\``)
          .join(' + ')} — that palette names its screenshot from those env vars and carries NO defaults (a subflow \`env:\` block OVERRIDES caller-passed \`runFlow: env:\` in Maestro 2.5.1, so defaults there silently defeat per-journey naming — dimagi-internal/ace#1033). Unbound, Maestro writes the frame as the literal \`undefined.png\`, and two unbound shots in one subflow overwrite each other.`,
      remediation:
        `bind every required key in this runFlow's own \`env:\` block with a per-call-site name, e.g.\n- runFlow:\n    file: ${filename}\n    env:\n${PALETTE_REQUIRED_SCREENSHOT_ENV[
          filename
        ]
          .map((k) => `      ${k}: "journey-<leg>-<step>"`)
          .join('\n')}\n(required: ${required})`,
    });
  };

  const checkRunFlow = (host: Node, runFlow: unknown): void => {
    // Scalar shorthand `- runFlow: form-advance.yaml` has nowhere to put
    // `env:` at all, so it is always unbound for these palettes.
    if (typeof runFlow === 'string') {
      const filename = flowBasename(runFlow);
      const required = PALETTE_REQUIRED_SCREENSHOT_ENV[filename];
      if (required) report(host, filename, [...required]);
      return;
    }
    if (!isMap(runFlow)) return;
    const file = runFlow.get('file');
    if (typeof file !== 'string') return;
    const filename = flowBasename(file);
    const required = PALETTE_REQUIRED_SCREENSHOT_ENV[filename];
    if (!required) return;
    const env = runFlow.get('env', true);
    const missing = required.filter((key) => {
      if (!isMap(env)) return true;
      const value = env.get(key);
      return typeof value !== 'string' || value.trim() === '';
    });
    if (missing.length > 0) report(host, filename, missing);
  };

  const visit = (node: Node | null): void => {
    if (node == null) return;
    if (isSeq(node)) {
      for (const item of node.items) visit(item as Node);
      return;
    }
    if (!isMap(node)) return;
    if (node.has('runFlow')) {
      // `get` without keepScalar returns the JS value for a scalar and the
      // node itself for a collection — exactly the two shapes handled below.
      checkRunFlow(node, node.get('runFlow') as unknown);
    }
    for (const pair of node.items) {
      visit(pair.value as Node);
    }
  };

  for (const doc of docs) {
    if (doc.contents) visit(doc.contents as Node);
  }
  return out;
}
