/**
 * Discovering detector for stale archetype enumerations (dimagi-internal/ace#2312).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * `longitudinal-visits` shipped 2026-08-17 (`13a14cfa`). The class "a prose
 * surface enumerates a stale archetype set" has since recurred SIX times:
 * ace#1486 → #1541 → #1630 → #1784 → #2128 → #2294.
 *
 * Two drift tests shipped along the way — `test/skills/archetype-enum-drift.test.ts`
 * and `test/lib/archetype-enum-docs.test.ts` — and both are CORRECT about what they
 * cover. Each pins a hand-maintained list of ~5 files, and the two lists are
 * disjoint. That is the defect:
 *
 *   **A guard against "one fact enumerated in many places" that itself
 *   enumerates places has the very defect it guards against.**
 *
 * A new surface is unguarded by construction. ace#2294 is exactly that —
 * `connect-opp-setup-eval` and `connect-program-setup-eval` each enumerated the
 * pre-2026-08-17 three while both tests stayed green, and one of them carried a
 * SCORED 3-point deduction keyed to a list that excluded the archetype under
 * test. ace#1784's own title says the same about `agents/commcare-setup.md`.
 *
 * So this module does not list sites. It DISCOVERS them: walk the live-guidance
 * roots, find every place that enumerates archetypes, and require each one to
 * enumerate the current set. Adding an archetype makes every stale surface fail
 * at once — including the ones nobody has written down yet.
 *
 * The two list-based tests stay. They are stricter about the files they name
 * (`pdd-to-work-order` needs a `### ` branch per archetype, not merely a
 * mention; `llo-launch`'s placeholder LINE must carry all four). This is the
 * floor under them, not a replacement.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE FALSE-POSITIVE CORPUS, AND WHY THE RULES ARE SHAPED LIKE THIS
 *
 * A rail that is noisy gets disabled, so the shape here is driven by the four
 * false-positive classes ace#2312 measured. A naive "line mentions 2+
 * archetypes" scan returns 43 files, the large majority legitimate:
 *
 *   1. CONTRASTIVE PROSE, not a closed set — "`atomic-visit` uses visit-centric
 *      categories, `focus-group` uses…" (`pdd-to-test-prompts:67`, and the same
 *      shape in `pdd-to-app-journeys`, `llo-uat`, `ocs-agent-setup`,
 *      `flw-data-review`, `pdd-to-learn-app-eval`). Naming two archetypes to
 *      contrast them is correct.
 *   2. A CHANGELOG ROW quoting a historical list — `connect-program-setup:530`
 *      is a 2026-09-05 entry REPORTING the old stale set as the thing it fixed.
 *      Flagging it would demand editing history.
 *   3. A COMPLETE enumeration a delimiter regex splits — `skills/README.md`
 *      reads "`atomic-visit`, `longitudinal-visits`, `focus-group`, and
 *      `multi-stage`"; the `and` breaks a naive delimiter run so the list reads
 *      as 3-of-4. It is complete.
 *   4. An enumeration WRAPPED ACROSS A LINE BREAK, or one whose exception is
 *      named just outside it — `solicitation-create:612` ("For every archetype
 *      except `focus-group` (`atomic-visit`,\n`multi-stage`,
 *      `longitudinal-visits`)"), `agents/synthetic-data-and-workflows:70-77`,
 *      `templates/pdd-template:27`.
 *
 * Four properties of the rules below, each buying off one class:
 *
 *   - **GLUE-ONLY RUNS.** Two archetype mentions belong to the same enumeration
 *     only when nothing but list punctuation and the conjunctions and/or/nor/vs
 *     sits between them. Prose between them means contrast, not a set (class 1),
 *     and treating `and`/`or` as separators fixes class 3.
 *   - **THREE IS A SET; TWO IS A CONTRAST.** With four archetypes, naming three
 *     is an attempt at the whole vocabulary; naming two is how you compare two
 *     things. The threshold is absolute and empirical — it is what takes the
 *     scan from 43 noisy files to 21 with (measured 2026-09-17) no false
 *     positives at all.
 *   - **PARAGRAPH-LEVEL COMPLETENESS.** A run is judged against its enclosing
 *     blank-line-delimited block, not its line. An enumeration whose missing
 *     member is named as the EXCEPTION a sentence earlier, or on the next line
 *     after a wrap, is complete in context (class 4).
 *   - **HISTORY IS FROZEN.** Changelog rows (`| 2026-09-05 | …`) and anything
 *     under a Changelog/History heading are skipped, because a changelog that
 *     tracks the current vocabulary is a changelog that has been falsified
 *     (class 2). `docs/superpowers/{specs,plans}/` is out of scope for the same
 *     reason — a date-stamped design doc records a decision at a time. That
 *     exclusion is worth exactly 7 findings across 5 files.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IT DOES *NOT* DO
 *
 * It does not read whether the branch is CORRECT — only whether the archetype
 * is named at all. A rubric that adds "| `longitudinal-visits` | see
 * atomic-visit |" satisfies it. That is deliberate: the expensive failure has
 * every time been the archetype being ABSENT (a judge with no anchor, a
 * producer with no branch), and a rail that tried to grade the branch text
 * would be an LLM, not a rail.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface ArchetypeEnumeration {
  /** Repo-relative path. */
  file: string;
  /** 1-based line of the first archetype token in the enumeration. */
  line: number;
  /**
   * `section` — a `## Archetypes` heading whose body names some but not all.
   * `run`     — a glue-delimited run of archetype tokens inline in prose.
   */
  kind: 'section' | 'run';
  /** Archetypes the enumeration omits. */
  missing: string[];
  /** Archetypes the enumeration names. */
  named: string[];
  /** A short quotation, for the failure message. */
  excerpt: string;
}

/**
 * Naming this many distinct archetypes reads as an attempt at the complete set.
 *
 * See the header: three is a set, two is a contrast. If the vocabulary ever
 * grows past four this stays 3 — it is the point at which a list stops looking
 * like a comparison, not a fraction of the vocabulary.
 */
export const ENUMERATION_THRESHOLD = 3;

/**
 * Live-guidance roots. Anything a human or an agent reads to learn how ACE
 * behaves TODAY.
 *
 * `docs/` is deliberately absent: `docs/superpowers/{specs,plans}/` are
 * date-stamped records of a decision at a time and `docs/learnings/` quotes
 * history on purpose, exactly like a changelog row.
 */
export const GUIDANCE_ROOTS: readonly string[] = [
  'skills',
  'agents',
  'commands',
  'playbook',
  'templates',
  'lib',
  'mcp',
];

/** Files outside the roots that are live guidance in their own right. */
export const GUIDANCE_FILES: readonly string[] = ['CLAUDE.md'];

/**
 * Only list punctuation and the conjunctions a list uses. Anything else between
 * two archetype mentions means they are being CONTRASTED, not enumerated.
 */
const GLUE = /^[\s`'"*_|/,;:()\[\]{}.—–-]*(?:(?:and|or|nor|vs\.?|versus|then)[\s`'"*_|/,;:()\[\]{}.—–-]*)*$/i;

const HISTORY_HEADING = /^#{1,6}\s+(change ?log|history|revisions?|version history)\b/i;
const CHANGELOG_ROW = /^\s*\|\s*20\d\d-\d\d-\d\d\s*\|/;
const ARCHETYPES_HEADING = /^#{2,6}\s+Archetypes\b/;

function tokenRe(archetypes: readonly string[]): RegExp {
  // Hyphen-aware boundaries: `atomic-visit` must not match inside
  // `non-atomic-visitor`. \b is wrong here because `-` is a word boundary.
  return new RegExp(`(?<![A-Za-z0-9-])(${archetypes.join('|')})(?![A-Za-z0-9-])`, 'g');
}

function distinctNames(text: string, archetypes: readonly string[]): string[] {
  return [...new Set([...text.matchAll(tokenRe(archetypes))].map((m) => m[1]))];
}

/**
 * Every enumeration in one file that omits an archetype.
 *
 * Pure: takes the text, returns findings. The test drives it over the repo AND
 * over the false-positive corpus, so both directions are provable offline.
 */
export function scanArchetypeEnumerations(
  file: string,
  text: string,
  archetypes: readonly string[],
): ArchetypeEnumeration[] {
  const lines = text.split('\n');
  const findings: ArchetypeEnumeration[] = [];

  // Which lines sit under a Changelog / History heading.
  const underHistory: boolean[] = [];
  let history = false;
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) history = HISTORY_HEADING.test(line);
    underHistory.push(history);
  }

  // Blank-line-delimited blocks, and the block each line belongs to. A heading
  // ends a block: an enumeration does not reach across a section boundary.
  const blockOfLine: number[] = new Array(lines.length).fill(-1);
  const blocks: string[] = [];
  let open: string[] = [];
  let openIndex = -1;
  const closeBlock = () => {
    if (open.length > 0) blocks.push(open.join('\n'));
    open = [];
    openIndex = -1;
  };
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '' || /^#{1,6}\s/.test(lines[i])) {
      closeBlock();
      continue;
    }
    if (openIndex === -1) openIndex = blocks.length;
    blockOfLine[i] = openIndex;
    open.push(lines[i]);
  }
  closeBlock();

  // ── Rule A: a `## Archetypes` section is a per-archetype branch table ──────
  //
  // The section is the scope, so prose between the rows does not matter — a
  // three-row table in a four-archetype vocabulary is missing a row. This is
  // the rule that catches ace#2294, which no run-level rule can see: the rows
  // of `| \`atomic-visit\` | Default. Grades per-delivery payment… |` are
  // separated by sentences, not by commas.
  for (let i = 0; i < lines.length; i++) {
    if (!ARCHETYPES_HEADING.test(lines[i])) continue;
    let end = i + 1;
    for (; end < lines.length; end++) if (/^#{1,6}\s/.test(lines[end])) break;
    const body = lines
      .slice(i, end)
      .filter((l) => !CHANGELOG_ROW.test(l))
      .join('\n');
    const named = distinctNames(body, archetypes);
    if (named.length < ENUMERATION_THRESHOLD) continue; // "archetype-agnostic" prose
    const missing = archetypes.filter((a) => !named.includes(a));
    if (missing.length === 0) continue;
    findings.push({
      file,
      line: i + 1,
      kind: 'section',
      missing,
      named,
      excerpt: `${lines[i].trim()} — names ${named.join(', ')}`,
    });
  }

  // ── Rule B: glue-delimited inline runs ────────────────────────────────────
  const hits = [...text.matchAll(tokenRe(archetypes))];
  const lineIndexAt = (offset: number) => text.slice(0, offset).split('\n').length - 1;
  let start = 0;
  while (start < hits.length) {
    let end = start;
    while (end + 1 < hits.length) {
      const gap = text.slice(hits[end].index! + hits[end][0].length, hits[end + 1].index!);
      if (!GLUE.test(gap)) break;
      end++;
    }
    const named = [...new Set(hits.slice(start, end + 1).map((h) => h[1]))];
    const lineIndex = lineIndexAt(hits[start].index!);
    const skip =
      named.length < ENUMERATION_THRESHOLD ||
      underHistory[lineIndex] ||
      CHANGELOG_ROW.test(lines[lineIndex]);
    if (!skip) {
      const context =
        blockOfLine[lineIndex] >= 0 ? blocks[blockOfLine[lineIndex]] : lines[lineIndex];
      const inContext = distinctNames(context, archetypes);
      const missing = archetypes.filter((a) => !named.includes(a) && !inContext.includes(a));
      if (missing.length > 0) {
        findings.push({
          file,
          line: lineIndex + 1,
          kind: 'run',
          missing,
          named,
          excerpt: text
            .slice(hits[start].index!, hits[end].index! + hits[end][0].length)
            .replace(/\s+/g, ' ')
            .slice(0, 120),
        });
      }
    }
    start = end + 1;
  }

  findings.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));
  return findings;
}

function walk(dir: string, keep: (p: string) => boolean): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, keep));
    else if (keep(full)) out.push(full);
  }
  return out;
}

/**
 * Every live-guidance file, DISCOVERED from the filesystem.
 *
 * This is the half that makes the rail O(1) in archetypes rather than
 * O(instances): nothing here names a file, so a surface written tomorrow is in
 * scope the moment it exists.
 */
export function guidanceFiles(repoRoot: string): string[] {
  const out: string[] = [];
  for (const root of GUIDANCE_ROOTS) {
    out.push(
      ...walk(
        join(repoRoot, root),
        (p) => (p.endsWith('.md') || p.endsWith('.ts')) && !p.endsWith('.test.ts'),
      ),
    );
  }
  for (const file of GUIDANCE_FILES) out.push(join(repoRoot, file));
  return out;
}

/** Scan the whole repo. Returns findings grouped by repo-relative path. */
export function scanRepo(
  repoRoot: string,
  archetypes: readonly string[],
): Map<string, ArchetypeEnumeration[]> {
  const byFile = new Map<string, ArchetypeEnumeration[]>();
  for (const abs of guidanceFiles(repoRoot)) {
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const rel = abs.slice(repoRoot.length).replace(/^\//, '');
    const found = scanArchetypeEnumerations(rel, text, archetypes);
    if (found.length > 0) byFile.set(rel, found);
  }
  return byFile;
}

/** How many archetype tokens the scan saw at all — a liveness signal. */
export function countArchetypeMentions(repoRoot: string, archetypes: readonly string[]): number {
  let n = 0;
  for (const abs of guidanceFiles(repoRoot)) {
    try {
      n += [...readFileSync(abs, 'utf8').matchAll(tokenRe(archetypes))].length;
    } catch {
      /* unreadable file is not a mention */
    }
  }
  return n;
}
