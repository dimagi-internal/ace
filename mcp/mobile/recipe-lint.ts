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
    | 'runFlow-unbound-screenshot-name'
    | 'pre-submit-screenshot-name-claims-outcome'
    | 'repeat-palette-invocation-without-discriminator'
    | 'selector-inline-key-position'
    | 'selector-value-position-type-mismatch';
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

/** Optional inputs a caller can inject to unlock map-aware rules. */
export interface LintOptions {
  /**
   * `logical-name -> declared type` from the ACTIVE selector map
   * (`mcp/mobile/selectors/connect-<apk>.yaml`), as produced by
   * `loadSelectorTypes` in `recipe-resolver.ts`.
   *
   * The linter stays a pure function, so the map is injected rather than
   * read. Omit it and `selector-value-position-type-mismatch` abstains —
   * every other rule is unaffected.
   */
  selectorTypes?: Record<string, 'id' | 'text' | 'point'>;
}

/**
 * Palette subflows whose screenshot names depend on a caller-supplied env var
 * — either the whole name or a discriminating suffix — and the env keys every
 * call site MUST bind.
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
  // ace#1668. `WALK_LABEL` is a SUFFIX on otherwise-fixed capture names rather
  // than the whole name, but it lands here for exactly the same reason and
  // must be enforced the same way. The ace#1651 fix that introduced it
  // declared it OPTIONAL, on the stated premise that "unbound, Maestro
  // substitutes the empty string". It does not — the premise above
  // ("Maestro renders the unset placeholder as the literal string
  // `undefined`") applies to every unbound var, this one included, and the
  // very next run wrote `deliver-form-walk-form-listundefined.png` +3
  // (hh-poverty-targeting/20260824-1404). A subflow `env:` default cannot fix
  // it either — per the precedence rule above it would clobber BOTH legs to
  // the same value and re-create the #1651 overwrite. Required at the call
  // site is the only shape that works.
  'deliver-form-walk.yaml': ['WALK_LABEL'],
};

/**
 * Per-key remediation example. Most required keys ARE the whole frame name;
 * `WALK_LABEL` is a suffix, so the generic `"journey-<leg>-<step>"` example
 * would teach the wrong shape (ace#1668).
 */
const SCREENSHOT_ENV_EXAMPLE: Record<string, string> = {
  WALK_LABEL: '"-<leg>"    # e.g. "-register" / "-followup"; a lone leg still binds one',
};

/**
 * Palette subflows whose captures are FIXED strings plus one optional
 * per-invocation discriminator — and the env key that carries it.
 *
 * WHY (dimagi-internal/ace#1651). `PALETTE_REQUIRED_SCREENSHOT_ENV` above
 * covers palettes whose screenshot name is *entirely* caller-supplied, so an
 * unbound call site is visible (`undefined.png`). This registry covers the
 * OTHER shape: a palette that names its own frames, which is perfectly fine
 * until the SAME palette is invoked twice in one recipe — at which point the
 * second invocation silently overwrites the first's files. Nothing fails and
 * nothing warns; the manifest simply holds fewer moments than the walk
 * observed.
 *
 * Measured on bednet-check-2-visit/20260825-1310 (ACE 0.13.987, a PASSING
 * run): `deliver-form-walk.yaml` ran both legs of a register-then-followup
 * Deliver smoke, its stdout reported all three captures COMPLETED in each leg,
 * and exactly one file of each name survived carrying leg B's `takenAt`. Leg
 * A's registration frames — the evidence the training deck and `app-ux-eval`
 * draw on — were destroyed. The only frames that survived were the two whose
 * names interpolate `${MODULE_NAME}`, i.e. the ones that already had a
 * discriminator by accident.
 *
 * The rule below therefore fires only on the shape that actually loses data:
 * the SAME palette invoked more than once in one recipe, with the
 * discriminator unbound or bound to the same value twice. A single invocation
 * is untouched, which is what keeps the discriminator optional and the
 * unbound default byte-identical to the pre-#1651 names.
 */
export const PALETTE_INVOCATION_DISCRIMINATOR: Record<string, string> = {
  'deliver-form-walk.yaml': 'WALK_LABEL',
};

/**
 * Lint a Maestro recipe YAML body for known-broken structural shapes.
 * Pure function — no I/O, same input always produces the same output.
 */
export function lintRecipeText(yaml: string, options: LintOptions = {}): LintResult {
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

  // Rule: pre-submit-screenshot-name-claims-outcome.
  //
  // `SCREENSHOT_NAME_PRE_SUBMIT` is, by construction, the frame taken while
  // still ON THE LAST QUESTION — `form-submit.yaml` shoots it before the tap
  // that advances. So a name claiming it shows a result/score/outcome is
  // always false, and it is false in the one direction that matters: it reads
  // as the certification screen, so anything consuming the manifest by name
  // captions it as one (dimagi-internal/ace#1853).
  //
  // Observed twice, on two independent runs, both times as a PRE_SUBMIT frame
  // named `…-result` that is an ordinary question:
  //   - spark-facilitator/20260828-0703 — `journey-learn-m6-assessment-result`
  //     is the 12th assessment ITEM (#1853's own evidence).
  //   - hh-poverty-targeting/20260828-0702 — `journey-learn-gate-result` sits
  //     in the manifest between `journey-learn-gate-q9-answered` and
  //     `journey-learn-gate-submitted`, i.e. it is the PRE_SUBMIT frame.
  //
  // The score screen now IS captured (it lands at `<PRE_SUBMIT>-result`), but
  // that made the collision worse, not better: bind PRE_SUBMIT to
  // `…-assessment-result` and the genuine outcome frame becomes
  // `…-assessment-result-result` while the misleading name keeps the clean one.
  // Capturing the pixels and naming them are two defects; #1853 reported both
  // and only the first was fixed.
  for (const v of findMisleadingPreSubmitNames(yaml)) {
    violations.push(v);
  }

  // Rule: repeat-palette-invocation-without-discriminator.
  //
  // A palette in PALETTE_INVOCATION_DISCRIMINATOR names its own frames from
  // fixed strings. Invoking it twice in one recipe without giving each call
  // site a DISTINCT discriminator makes the second invocation overwrite the
  // first's screenshots — silently, on a passing run (ace#1651).
  for (const v of findRepeatPaletteInvocations(yaml)) {
    violations.push(v);
  }

  // Rules: selector-inline-key-position + selector-value-position-type-mismatch.
  //
  // Both are static checks over the recipe text (plus, for the second, the
  // active selector map) — no device, no Maestro (dimagi-internal/ace#1690).
  for (const v of findSelectorPlacementDefects(yaml, options.selectorTypes)) {
    violations.push(v);
  }

  return { ok: violations.length === 0, violations };
}

/** Matcher keys a value-position selector can legitimately sit under. */
const MATCHER_TYPE_KEYS = new Set(['id', 'text', 'point']);

/**
 * Flag the two `${SELECTOR:...}` PLACEMENT defects that survive both the
 * resolver and every existing lint rule (dimagi-internal/ace#1690).
 *
 * The resolver (`recipe-resolver.ts` § resolveSelectorsInYaml) supports two
 * placeholder forms, and each has a placement precondition the resolver
 * itself cannot check, because it is a blind text substitution:
 *
 *   1. KEY position — a bare `${SELECTOR:name}` resolves to the WHOLE
 *      matcher, key included: `text: "RECORD LOCATION"`. That is only
 *      raw-YAML-valid when the placeholder is the sole content of its line.
 *      Written INLINE after a step key —
 *
 *          - tapOn: ${SELECTOR:geopoint-record-location}
 *
 *      — it resolves to `- tapOn: text: "RECORD LOCATION"`, which no YAML
 *      parser accepts. Measured on spark-facilitator/20260820-0817 Phase 6:
 *      Maestro rejected the chunk with
 *      `chunk-10.yaml:45 ... ^ mapping values are not allowed here`
 *      after the recipe had already been dispatched to a device.
 *      The correct shape is the nested block:
 *
 *          - tapOn:
 *              ${SELECTOR:geopoint-record-location}
 *
 *   2. VALUE position — a quoted `"${SELECTOR:name}"` resolves to the bare
 *      value only, leaving the key the AUTHOR wrote in place. So the author
 *      is now responsible for a fact the map owns: which key the value
 *      belongs under. Same run wrote
 *      `id: "${SELECTOR:camera-take-photo}"` for a selector the map declares
 *      `type: text` (`connect-2.63.2.yaml:337`), producing `id: "TAKE
 *      PICTURE"` — perfectly valid YAML, and permanently unmatchable,
 *      because no view carries that string as a resource-id.
 *
 * Both rules are deliberately NARROW — they fire only on the exact shapes
 * above. A bare placeholder alone on its line, a value-position placeholder
 * under the key its map entry declares, a placeholder inside a comment, and
 * a placeholder under a key the map has no opinion about (`childOf:`,
 * `below:`) are all untouched. Every recipe under
 * `mcp/mobile/recipes/**` lints clean with these rules on.
 */
function findSelectorPlacementDefects(
  yaml: string,
  selectorTypes?: Record<string, 'id' | 'text' | 'point'>,
): LintViolation[] {
  const out: LintViolation[] = [];
  const lines = yaml.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Whole-line comments carry prose that legitimately quotes both forms
    // (every palette header does) — never lint prose.
    if (/^\s*#/.test(line)) continue;

    const re = /\$\{SELECTOR:([a-z0-9-]+)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const name = m[1];
      const before = line.slice(0, m.index);
      const after = line.slice(m.index + m[0].length);
      // A `#` anywhere earlier on the line means we are inside a trailing
      // comment. Abstain rather than risk a false positive on prose.
      if (before.includes('#')) continue;

      const quoted = before.endsWith('"') && after.startsWith('"');

      if (quoted) {
        // VALUE position. The enclosing key is whatever precedes the opening
        // quote on this line. Only the same-line `key: "<sel>"` shape is
        // checked — that is the shape recipes actually use.
        if (!selectorTypes) continue;
        const keyMatch = before
          .slice(0, before.length - 1)
          .match(/([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*$/);
        if (!keyMatch) continue;
        const key = keyMatch[1];
        if (!MATCHER_TYPE_KEYS.has(key)) continue;
        const declared = selectorTypes[name];
        // An unknown name is the resolver's problem (it reports `unresolved`),
        // not this rule's.
        if (!declared || declared === key) continue;
        out.push({
          rule: 'selector-value-position-type-mismatch',
          line: i + 1,
          detail:
            `value-position \`${key}: "\${SELECTOR:${name}}"\` on line ${i + 1} sits under \`${key}:\`, ` +
            `but the active selector map declares \`${name}\` as \`type: ${declared}\`. The value-position ` +
            `form substitutes ONLY the value and leaves the key you wrote, so this resolves to a ` +
            `\`${key}:\` matcher holding a ${declared} value — valid YAML that can never match a view ` +
            `(dimagi-internal/ace#1690: \`id: "TAKE PICTURE"\`).`,
          remediation:
            `use the key the map declares: \`${declared}: "\${SELECTOR:${name}}"\` — or drop to the ` +
            `key-position form on its own line (\`\${SELECTOR:${name}}\` under \`- tapOn:\`), which ` +
            `emits the correct key for you. If you believe the map is wrong, fix the map entry's ` +
            `\`type:\` against a live \`mobile_capture_ui_dump\`, not the recipe.`,
        });
        continue;
      }

      // KEY position. Valid only as the sole content of its line; the failure
      // shape is an inline placeholder sitting where a scalar VALUE is
      // expected, i.e. directly after a `<key>:`.
      const prefix = before.replace(/\s+$/, '');
      if (prefix === '' || prefix === '-') continue; // sole content of the line — the canonical form.
      if (!/(^|\s|-)[A-Za-z_][A-Za-z0-9_-]*\s*:$/.test(prefix)) continue;
      const key = prefix.replace(/:$/, '').replace(/^.*?([A-Za-z_][A-Za-z0-9_-]*)$/, '$1');
      out.push({
        rule: 'selector-inline-key-position',
        line: i + 1,
        detail:
          `bare \`\${SELECTOR:${name}}\` on line ${i + 1} sits INLINE after \`${key}:\`. The bare ` +
          `(key-position) form resolves to a COMPLETE matcher — key and value — so this becomes ` +
          `\`${key}: <type>: "<value>"\`, which no YAML parser accepts. Maestro fails the whole chunk ` +
          `at parse time with "mapping values are not allowed here" ` +
          `(dimagi-internal/ace#1690, spark-facilitator/20260820-0817 Phase 6).`,
        remediation:
          `put the placeholder on its OWN line, nested under the key:\n- ${key}:\n    \${SELECTOR:${name}}\n` +
          `Or, if you need sibling matcher keys (\`below:\` / \`childOf:\` / \`index:\`), use the ` +
          `VALUE-position form under the key the selector map declares for \`${name}\`, e.g. ` +
          `\`text: "\${SELECTOR:${name}}"\`.`,
      });
    }
  }

  return out;
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
          .map((k) => `      ${k}: ${SCREENSHOT_ENV_EXAMPLE[k] ?? '"journey-<leg>-<step>"'}`)
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

/**
 * Words that claim a frame shows the OUTCOME of a form rather than a step in
 * it. Matched as whole hyphen/underscore-delimited segments, so a legitimate
 * `journey-learn-m6-resulting-action` or a form genuinely called "Score Card"
 * is not caught by substring accident.
 *
 * Deliberately short. This is a naming rule for one specific frame, and the
 * cost of a false positive is a confused author, so it names only the words
 * that have actually been observed misleading a reader: `result`, `results`,
 * `score`, `passed`, `failed`, `certified`, `outcome`, `grade`.
 */
const OUTCOME_CLAIMING_SEGMENTS = new Set([
  'result',
  'results',
  'score',
  'passed',
  'failed',
  'certified',
  'outcome',
  'grade',
]);

/**
 * Flag a `SCREENSHOT_NAME_PRE_SUBMIT` binding whose name claims to show an
 * outcome. That frame is taken on the last question, before the advancing tap,
 * so the claim is structurally false (dimagi-internal/ace#1853).
 *
 * Authoring-time only: this reads the recipe text, never the device. Under
 * CLAUDE.md's device-truth trigger it is the ace#1235 shape — nothing here
 * changes what is sent to, or matched against, a device.
 */
function findMisleadingPreSubmitNames(yaml: string): LintViolation[] {
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

  const check = (host: Node, runFlow: unknown): void => {
    if (!isMap(runFlow)) return;
    const file = runFlow.get('file');
    if (typeof file !== 'string') return;
    if (flowBasename(file) !== 'form-submit.yaml') return;
    const env = runFlow.get('env', true);
    if (!isMap(env)) return;
    const name = env.get('SCREENSHOT_NAME_PRE_SUBMIT');
    if (typeof name !== 'string') return;

    const offending = name
      .split(/[-_]/)
      .map((s) => s.toLowerCase())
      .filter((s) => OUTCOME_CLAIMING_SEGMENTS.has(s));
    if (offending.length === 0) return;

    const line = lineOf(host);
    const suggestion = name.replace(
      /[-_](result|results|score|passed|failed|certified|outcome|grade)\b/gi,
      '-last-item',
    );
    out.push({
      rule: 'pre-submit-screenshot-name-claims-outcome',
      line,
      detail:
        `runFlow into \`form-submit.yaml\` at line ${line} binds ` +
        `\`SCREENSHOT_NAME_PRE_SUBMIT: ${name}\`, whose \`${offending[0]}\` segment claims ` +
        `the frame shows an outcome. It cannot: that screenshot is taken while still on the ` +
        `LAST QUESTION, before the tap that advances. On a score-gated quiz the real outcome ` +
        `frame is the separate \`${name}-result\` capture inside the FINISH branch, so this ` +
        `name both mis-describes its own frame and collides with the one that is honest ` +
        `(dimagi-internal/ace#1853).`,
      remediation:
        `name the pre-submit frame for what it shows, e.g. ` +
        `\`SCREENSHOT_NAME_PRE_SUBMIT: ${suggestion}\`. The score screen needs no binding of ` +
        `its own — \`form-submit.yaml\` derives it as \`<PRE_SUBMIT>-result\` inside the ` +
        `score-gated FINISH branch.`,
    });
  };

  const visit = (node: Node | null): void => {
    if (node == null) return;
    if (isSeq(node)) {
      for (const item of node.items) visit(item as Node);
      return;
    }
    if (!isMap(node)) return;
    if (node.has('runFlow')) check(node, node.get('runFlow', true) as unknown);
    for (const pair of node.items) visit(pair.value as Node);
  };

  for (const doc of docs) {
    if (doc.contents) visit(doc.contents as Node);
  }
  return out;
}

/**
 * Flag every palette in PALETTE_INVOCATION_DISCRIMINATOR that is invoked more
 * than once in one recipe without a DISTINCT discriminator per call site
 * (dimagi-internal/ace#1651).
 *
 * Two offending shapes, both reported at the SECOND (and any later) call site,
 * because that is the invocation whose captures destroy the earlier one's:
 *
 *   1. the discriminator env key is missing/blank at any call site; or
 *   2. two call sites bind it to the SAME value.
 *
 * A single invocation is never reported — the discriminator is optional by
 * design so the unbound default stays byte-identical to the pre-#1651 names.
 */
function findRepeatPaletteInvocations(yaml: string): LintViolation[] {
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

  /** Every call site of a tracked palette, in document order. */
  const calls: { filename: string; line: number; value: string | null }[] = [];

  const record = (host: Node, runFlow: unknown): void => {
    let filename: string;
    let env: unknown = null;
    if (typeof runFlow === 'string') {
      filename = flowBasename(runFlow);
    } else if (isMap(runFlow)) {
      const file = runFlow.get('file');
      if (typeof file !== 'string') return;
      filename = flowBasename(file);
      env = runFlow.get('env', true);
    } else {
      return;
    }
    const key = PALETTE_INVOCATION_DISCRIMINATOR[filename];
    if (!key) return;
    let value: string | null = null;
    if (isMap(env)) {
      const raw = env.get(key);
      if (typeof raw === 'string' && raw.trim() !== '') value = raw;
    }
    calls.push({ filename, line: lineOf(host), value });
  };

  const visit = (node: Node | null): void => {
    if (node == null) return;
    if (isSeq(node)) {
      for (const item of node.items) visit(item as Node);
      return;
    }
    if (!isMap(node)) return;
    if (node.has('runFlow')) record(node, node.get('runFlow') as unknown);
    for (const pair of node.items) visit(pair.value as Node);
  };

  for (const doc of docs) {
    if (doc.contents) visit(doc.contents as Node);
  }

  // Group by palette; a palette invoked once is always fine.
  const byFile = new Map<string, typeof calls>();
  for (const c of calls) {
    const list = byFile.get(c.filename) ?? [];
    list.push(c);
    byFile.set(c.filename, list);
  }

  for (const [filename, list] of byFile) {
    if (list.length < 2) continue;
    const key = PALETTE_INVOCATION_DISCRIMINATOR[filename];
    const seen = new Set<string>();
    // The FIRST call site is the one whose frames survive; report each
    // LATER one, since that is the invocation doing the overwriting.
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const collides = c.value === null || seen.has(c.value);
      if (c.value !== null) seen.add(c.value);
      if (i === 0 || !collides) continue;
      const why =
        c.value === null
          ? `binds no \`${key}\``
          : `binds \`${key}: "${c.value}"\`, the same value an earlier call site already used`;
      out.push({
        rule: 'repeat-palette-invocation-without-discriminator',
        line: c.line,
        detail:
          `runFlow into \`${filename}\` at line ${c.line} is invocation #${i + 1} of that palette ` +
          `in this recipe and ${why}. That palette names its captures from FIXED strings plus ` +
          `\`\${${key}}\`, so without a distinct discriminator this invocation OVERWRITES the ` +
          `earlier one's screenshots — silently, on a passing run (dimagi-internal/ace#1651: a ` +
          `register-then-followup Deliver smoke lost leg A's registration frames on every run).`,
        remediation:
          `give every call site of \`${filename}\` a DISTINCT \`${key}\`, including the leading ` +
          `separator, e.g.\n- runFlow:\n    file: ${filename}\n    env:\n      ${key}: "-register"\n` +
          `...\n- runFlow:\n    file: ${filename}\n    env:\n      ${key}: "-followup"\n` +
          `Keep it a \`[a-z0-9-]\` slug — the name resolves as a file path.`,
      });
    }
  }

  return out;
}
