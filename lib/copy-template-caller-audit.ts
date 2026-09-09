/**
 * A reported warning is only a gate if something reads it
 * (dimagi-internal/ace#2126).
 *
 * ace#2167 made `docs_copy_template` / `slides_copy_template` return
 * `unmatchedReplacements` — the replacement keys that matched NOTHING, i.e. the
 * values that were silently dropped from the rendered artifact. ace#2168 then
 * wired that signal into exactly ONE caller (`pdd-to-work-order`). Measured
 * against `origin/main` at ce31204d, every other producing caller still
 * discarded it:
 *
 *   skills/pdd-to-work-order/SKILL.md        refs=7  unmatchedReplacements=1
 *   skills/training-deck-render/SKILL.md     refs=3  unmatchedReplacements=0
 *   skills/partnership-deck-build/SKILL.md   refs=3  unmatchedReplacements=0
 *   skills/run-surface-audit/SKILL.md        refs=1  unmatchedReplacements=0
 *   agents/idea-to-design.md                 refs=1  unmatchedReplacements=0
 *   agents/partnership-video.md              refs=1  unmatchedReplacements=0
 *
 * That gap is not self-closing: the next caller anyone adds inherits it in
 * silence, which is precisely how ace#2126 happened in the first place. So the
 * fix is not only to wire today's callers — it is to make an unwired one fail
 * CI. This module is that check's pure half.
 *
 * TWO RULES, because either alone has a hole:
 *
 *   1. AUTO — a call site that passes token substitutions is a PRODUCER, and a
 *      producer's file must read `unmatchedReplacements`. This catches someone
 *      adding `replacements` to a call that is currently bare (both deck skills
 *      copy their template bare today, so a registry-only check would sit green
 *      while that changed underneath it).
 *
 *   2. REGISTRY — every file in the repo that mentions one of these atoms must
 *      appear in CALLER_REGISTRY with an explicit classification and a reason.
 *      This catches a NEW file, which the auto rule can only classify once it
 *      already exists and is already wrong. Modelled on `lib/agent-depth.ts`,
 *      where an `Agent(...)` target that appears without being counted fails CI
 *      for the same reason.
 *
 * Producer-vs-reference is a judgment call — most of the six hits above are
 * prose ABOUT the atom, not calls to it — so the registry records the judgment
 * and forces it to be re-made whenever the set of files changes, rather than
 * re-deriving it from a regex on every run.
 */

/** Atoms whose replies carry replacement coverage. */
export const COVERAGE_ATOMS = [
  'docs_copy_template',
  'slides_copy_template',
  'slides_batch_update',
] as const;

export type CoverageAtom = (typeof COVERAGE_ATOMS)[number];

/** The field a caller must read to see a silently-dropped value. */
export const COVERAGE_FIELD = 'unmatchedReplacements';

/**
 * How far past an atom mention to look for the substitution signal.
 *
 * Both call shapes in the repo fit inside this: the inline form
 * (`docs_copy_template(templateDocId=..., replacements={...})`, one line) and
 * the bulleted-argument form ("Call `slides_copy_template` with:" followed by a
 * `- \`replacements\`: ...` list).
 */
export const CALL_WINDOW_LINES = 12;

/**
 * Signals that a call site actually substitutes tokens.
 *
 * `replacements` is the copy atoms' argument. The deck path does not use it —
 * `buildSlidesRequestsV2` emits `replaceAllText` requests that go through
 * `slides_batch_update` — so both spellings count.
 */
const PRODUCING_SIGNALS = ['replacements', 'replaceAllText', 'buildSlidesRequests'];

/**
 * A substitution signal near an atom name is not enough on its own — ACE's
 * docs describe these pipelines in prose constantly, and those passages quote
 * the same words. All three of these are REFERENCES, and a signal-only rule
 * flagged every one of them:
 *
 *   run-surface-audit  "built by `docs_copy_template` (`drive.files.copy` + `replaceAllText`)"
 *   partnership-video  "via ... (`slides_copy_template` -> `slides_get` -> `buildSlidesRequestsV2`)"
 *   qa-and-training    "fills via `slides_batch_update`, returns the"
 *
 * What separates a call from a description is an INVOCATION shape on the atom's
 * own line: an imperative ("Call `atom` with:") or call syntax (`atom(`). Both
 * real shapes in the repo have one; none of the prose does.
 */
function isInvocation(line: string, atom: string): boolean {
  if (new RegExp(`${atom}\\(`).test(line)) return true;
  return new RegExp(`\\b(call|invoke|run)\\s+\`?${atom}\``, 'i').test(line);
}

export type CallerKind = 'producer' | 'reference';

export interface RegistryEntry {
  /** Repo-relative path. */
  file: string;
  kind: CallerKind;
  /** Why this classification — read at review time, not by the code. */
  reason: string;
}

/**
 * Every file in the repo that names a coverage atom, classified.
 *
 * `producer` — the file instructs an agent to CALL the atom in a way that
 * substitutes token values, so a dropped key loses content it computed.
 * `reference` — the file only talks about the atom (an artifact inventory, a
 * folder-placement warning, a QA-strategy table, a template-authoring guide).
 * A reference has no result to read, so requiring it to read one would be
 * noise.
 */
export const CALLER_REGISTRY: RegistryEntry[] = [
  {
    file: 'skills/pdd-to-work-order/SKILL.md',
    kind: 'producer',
    reason:
      'Calls docs_copy_template with the full work-order token map. Wired by ace#2168 — ' +
      'this is the caller whose dropped {{partner_first_reference}} is the ace#2126 repro.',
  },
  {
    file: 'skills/training-deck-render/SKILL.md',
    kind: 'producer',
    reason:
      'Copies the 14-stencil template, then substitutes every slide token via ' +
      'slides_batch_update using buildSlidesRequestsV2 requests. Phase 6 training deck.',
  },
  {
    file: 'skills/partnership-deck-build/SKILL.md',
    kind: 'producer',
    reason:
      'Same 14-stencil pipeline as training-deck-render, for the partnership pitch deck. ' +
      'Copies bare, substitutes via slides_batch_update.',
  },
  {
    file: 'skills/pdd-to-work-order-qa/SKILL.md',
    kind: 'reference',
    reason:
      'Names docs_copy_template in the `rendered_from_template` check row, describing the render ' +
      'path that check VERIFIES the artifact came from. QA reads a finished document out of Drive ' +
      'and never calls the atom, so there is no result to read unmatchedReplacements from. Added ' +
      'with that check (2026-09-09), after a synthesized plain doc shipped as a work order on ' +
      'turmeric-market-study/20260828-1108 and scored 8/8 here.',
  },
  {
    file: 'skills/run-surface-audit/SKILL.md',
    kind: 'reference',
    reason:
      'Names docs_copy_template once, in an inventory line describing how an artifact it ' +
      'AUDITS was built ("`1-design/pdd-to-work-order.gdoc` — built by `docs_copy_template`"). ' +
      'It reads the rendered doc; it never calls the atom, so there is no result to check.',
  },
  {
    file: 'agents/idea-to-design.md',
    kind: 'reference',
    reason:
      'Names the atom in a parentFolderId placement warning ("`drive_create_file` / ' +
      '`docs_copy_template` lands every artifact flat at ..."). The actual call is made by ' +
      'the pdd-to-work-order skill this phase dispatches.',
  },
  {
    file: 'agents/partnership-video.md',
    kind: 'reference',
    reason:
      'Describes the deck pipeline in prose (`slides_copy_template` -> `slides_get` -> ' +
      '`buildSlidesRequestsV2` -> ...) as a cross-reference to partnership-deck-build, ' +
      'which owns and makes the calls.',
  },
  {
    file: 'agents/qa-and-training.md',
    kind: 'reference',
    reason:
      'One prose line summarising what the training-deck-render skill it dispatches does ' +
      '("... the opp folder, fills via `slides_batch_update`, returns the ..."). The phase ' +
      'agent makes no Slides call itself. Found by this audit, not by hand — it was missing ' +
      'from the hand-built caller list this check was written against.',
  },
  {
    file: 'skills/_qa-decisions.md',
    kind: 'reference',
    reason:
      'A QA-strategy registry table. The training-deck-render row names the atoms to explain ' +
      'why that skill uses inline QA. No call site.',
  },
  {
    file: 'skills/pdd-to-work-order/references/style-guide.md',
    kind: 'reference',
    reason:
      'Template-authoring guide for humans updating the gdoc template. States outright: ' +
      '"The runtime skill does not consult this file per-run."',
  },
];

export interface CallSite {
  file: string;
  /** 1-based. */
  line: number;
  atom: CoverageAtom;
  producing: boolean;
  /** The signal that made it producing, or '' when it is a bare mention. */
  signal: string;
}

export interface SourceFile {
  /** Repo-relative path. */
  path: string;
  text: string;
}

export type ViolationKind =
  /** A producing call site in a file that never reads the coverage field. */
  | 'unread-coverage'
  /** A file names a coverage atom but is not classified in CALLER_REGISTRY. */
  | 'unregistered-file'
  /** The auto rule found a producing call in a file the registry calls a reference. */
  | 'misclassified-reference'
  /** CALLER_REGISTRY names a file that no longer mentions any coverage atom. */
  | 'stale-registry-entry';

export interface Violation {
  kind: ViolationKind;
  file: string;
  message: string;
}

/** Find every coverage-atom mention and decide whether it substitutes tokens. */
export function findCallSites(file: SourceFile): CallSite[] {
  const lines = file.text.split('\n');
  const sites: CallSite[] = [];

  lines.forEach((line, i) => {
    for (const atom of COVERAGE_ATOMS) {
      if (!line.includes(atom)) continue;
      const window = lines.slice(i, i + CALL_WINDOW_LINES + 1).join('\n');
      const signal = isInvocation(line, atom)
        ? (PRODUCING_SIGNALS.find((s) => window.includes(s)) ?? '')
        : '';
      sites.push({
        file: file.path,
        line: i + 1,
        atom,
        producing: signal !== '',
        signal,
      });
    }
  });

  return sites;
}

/**
 * Audit a set of files against both rules.
 *
 * Pure: callers supply the file set (the repo scan in the test, fixtures in the
 * unit tests), so the rules can be exercised against inputs that do not exist
 * on disk.
 */
export function auditCopyTemplateCallers(
  files: SourceFile[],
  registry: RegistryEntry[] = CALLER_REGISTRY,
): Violation[] {
  const violations: Violation[] = [];
  const byFile = new Map(registry.map((e) => [e.file, e]));
  const mentioned = new Set<string>();

  for (const file of files) {
    const sites = findCallSites(file);
    if (sites.length === 0) continue;
    mentioned.add(file.path);

    const entry = byFile.get(file.path);
    if (!entry) {
      violations.push({
        kind: 'unregistered-file',
        file: file.path,
        message:
          `${file.path} names ${[...new Set(sites.map((s) => s.atom))].join(', ')} but is not ` +
          `classified in CALLER_REGISTRY (lib/copy-template-caller-audit.ts). Add an entry ` +
          `saying whether it CALLS the atom to substitute tokens ('producer') or only ` +
          `mentions it ('reference'), and why. A producer must read '${COVERAGE_FIELD}'.`,
      });
      continue;
    }

    const producingSites = sites.filter((s) => s.producing);
    if (entry.kind === 'reference' && producingSites.length > 0) {
      const s = producingSites[0];
      violations.push({
        kind: 'misclassified-reference',
        file: file.path,
        message:
          `${file.path}:${s.line} calls ${s.atom} with a token-substitution signal ` +
          `('${s.signal}'), but CALLER_REGISTRY classifies this file as 'reference'. ` +
          `Reclassify it as 'producer' and make it read '${COVERAGE_FIELD}'.`,
      });
      continue;
    }

    if (entry.kind === 'producer' && !file.text.includes(COVERAGE_FIELD)) {
      const s = producingSites[0] ?? sites[0];
      violations.push({
        kind: 'unread-coverage',
        file: file.path,
        message:
          `${file.path}:${s.line} calls ${s.atom} as a PRODUCER but the file never reads ` +
          `'${COVERAGE_FIELD}'. A key that matches nothing is a silent no-op: 200, no error, ` +
          `and no leftover {{token}} for any rendered-artifact scan to find, so the value is ` +
          `dropped and every checkpoint reads green (ace#2126). Read the field and halt on a ` +
          `non-empty list.`,
      });
    }
  }

  for (const entry of registry) {
    if (!mentioned.has(entry.file)) {
      violations.push({
        kind: 'stale-registry-entry',
        file: entry.file,
        message:
          `CALLER_REGISTRY lists ${entry.file}, but no coverage atom is mentioned there any ` +
          `more (moved, renamed, or deleted). Remove the entry or point it at the new path.`,
      });
    }
  }

  return violations;
}
