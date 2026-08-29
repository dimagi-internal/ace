/**
 * Skill → atom PARAMETER drift detector.
 *
 * The sibling of `skill-atom-references.test.ts`, which catches the
 * RENAME / REMOVE half of the drift class (a skill naming an atom that no
 * longer exists). Its own header names the gap this file closes:
 *
 *   > This test catches the RENAME / REMOVE half of the drift class; the
 *   > SEMANTIC half (skill describes a real atom's params wrong) needs a
 *   > separate inspection.
 *
 * That gap is not theoretical. `skills/connect-opp-setup/SKILL.md` § Step 3a
 * shipped a literal code block in which EVERY parameter name of both calls
 * was wrong and one required parameter was missing entirely
 * (`target_organization_slug` for `organization`; `target_organization_slug`
 * + `program_application_id` for `organization_slug` + `application_id`; no
 * `program_id`). It stayed green because the block only executes on the
 * FIRST Phase 4 run of a program in a fresh PM org — every later run
 * short-circuits on "Organization already has an application for this
 * program" and never reaches the accept call. See ace#1800.
 *
 * Approach — deliberately narrow, to stay signal and not noise:
 *   1. Read the generated catalog `docs/atom-schemas.md` for each atom's
 *      real parameter names. That file is itself CI-gated for staleness by
 *      `test/scripts/dump-atom-schemas.test.ts`, so it cannot silently rot.
 *   2. In every `skills/*_/SKILL.md`, look ONLY inside fenced code blocks,
 *      and only at lines of the shape `<indent><key>: <value>` that sit
 *      inside a `<atom_name>(` … `)` call. Prose mentions, tables, and bare
 *      backtick references are all ignored — those are the other test's job.
 *   3. Any key that is not a real parameter of that atom is DRIFT.
 *
 * This is a RATCHET. `KNOWN_DRIFT` records violations that predate the
 * detector so it can land green; new drift fails immediately. Pay the
 * ledger down, never extend it to make a new violation pass.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

/**
 * Violations that predate this detector. Each entry is
 * `<skill>:<atom>:<param>`. Do NOT add to this list to silence a new
 * failure — fix the skill instead.
 */
const KNOWN_DRIFT = new Set<string>([
  // `skills/interview-cohort-create` (a standalone /ace:interview-cohort-create
  // flow, not part of /ace:run) documents a `connect_create_opportunity` call
  // whose top-level shape predates the REST automation API: it passes fields
  // that now live nowhere on the atom (`long_description`, `max_users`) or
  // moved inside the `learn_app` / `deliver_app` sub-objects (`hq_server`,
  // `api_key`) or onto the PROGRAM, which owns them as durable identity
  // (`country`, `currency`). Real drift, surfaced by this detector on the day
  // it landed, left in the ledger rather than fixed blind — that skill drives a
  // live Connect Interviews cohort and its correct shape wants an operator who
  // runs it. Tracked on ace#1800.
  'interview-cohort-create:connect_create_opportunity:long_description',
  'interview-cohort-create:connect_create_opportunity:country',
  'interview-cohort-create:connect_create_opportunity:currency',
  'interview-cohort-create:connect_create_opportunity:hq_server',
  'interview-cohort-create:connect_create_opportunity:api_key',
  'interview-cohort-create:connect_create_opportunity:max_users',
  'interview-cohort-create:connect_update_opportunity:delivery_type',

  // `skills/app-test-cases` documents `mobile_run_recipe` in snake_case
  // (`recipe_path`, `env_vars`) where the atom is camelCase (`recipePath`,
  // `envVars`), and passes a `dry_run_selectors` that the atom has no
  // parameter for at all. Surfaced by this detector on the day it landed.
  // Left in the ledger rather than fixed blind: `dry_run_selectors` may be
  // describing an intent the atom never grew, which is a question for whoever
  // owns the mobile recipe surface, not a rename. Tracked on ace#1800.
  'app-test-cases:mobile_run_recipe:recipe_path',
  'app-test-cases:mobile_run_recipe:env_vars',
  'app-test-cases:mobile_run_recipe:dry_run_selectors',
]);

/** Parse `docs/atom-schemas.md` → atom name → set of real parameter names. */
function loadAtomParams(): Map<string, Set<string>> {
  const catalog = fs.readFileSync(
    path.join(REPO_ROOT, 'docs/atom-schemas.md'),
    'utf-8',
  );
  const byAtom = new Map<string, Set<string>>();
  let current: string | null = null;

  for (const line of catalog.split('\n')) {
    const heading = line.match(/^###\s+`([A-Za-z0-9_]+)`\s*$/);
    if (heading) {
      current = heading[1];
      byAtom.set(current, new Set());
      continue;
    }
    if (!current) continue;
    // Table rows look like: | `field` | `z.string` | **required** | desc |
    const row = line.match(/^\|\s*`([A-Za-z0-9_.]+)`\s*\|/);
    if (row) byAtom.get(current)!.add(row[1].split('.')[0]);
  }
  return byAtom;
}

/**
 * Extract `{atom, param}` pairs from the fenced code blocks of one
 * SKILL.md. Only `key: value` lines strictly inside a `atom(` … `)` call
 * are considered.
 */
function extractCalls(
  md: string,
  atomNames: Set<string>,
): Array<{ atom: string; param: string }> {
  const out: Array<{ atom: string; param: string }> = [];
  const lines = md.split('\n');

  const delta = (s: string): number => {
    let d = 0;
    for (const ch of s) {
      if (ch === '(' || ch === '{' || ch === '[') d += 1;
      else if (ch === ')' || ch === '}' || ch === ']') d -= 1;
    }
    return d;
  };

  let inFence = false;
  let openAtom: string | null = null;
  let depth = 0;
  let baseDepth = 0;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      openAtom = null;
      continue;
    }
    if (!inFence) continue;

    if (!openAtom) {
      // `connect_foo(` / `connect_foo({` / `mcp__…__connect_foo({` opening a call.
      // NOTE the hyphen in the character class: the fully-qualified form is
      // `mcp__plugin_ace_ace-connect__connect_send_llo_invite`, and a
      // hyphen-less class silently matched only the tail after `ace-`,
      // which resolves to no atom — so every prefixed call was skipped and
      // this detector missed the very block it was written for.
      const call = line.match(/([A-Za-z0-9_-]+)\s*\((.*)$/);
      if (call) {
        const bare = call[1].replace(/^mcp__[A-Za-z0-9_-]*?__/, '');
        if (atomNames.has(bare)) {
          openAtom = bare;
          // 1 for the atom's own paren, plus whatever the rest of the line opens.
          depth = 1 + delta(call[2]);
          baseDepth = depth;
          if (depth <= 0) openAtom = null;
        }
      }
      continue;
    }

    // Record ONLY keys of the top-level argument object. Without this depth
    // guard the scanner descends into nested literals — every key of a
    // `decisions_append_rows` ROW read as a top-level param of the atom.
    if (depth === baseDepth) {
      const kv = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/);
      if (kv) out.push({ atom: openAtom, param: kv[1] });
    }

    depth += delta(line);
    if (depth <= 0) openAtom = null;
  }
  return out;
}

describe('skill → atom parameter drift', () => {
  const atomParams = loadAtomParams();
  const atomNames = new Set(atomParams.keys());

  it('parses a non-trivial atom catalog', () => {
    expect(atomNames.size).toBeGreaterThan(50);
    // Spot-check the two atoms ace#1800 was about.
    expect([...(atomParams.get('connect_send_llo_invite') ?? [])].sort()).toEqual(
      ['organization', 'organization_slug', 'program_id'],
    );
    expect(
      [...(atomParams.get('connect_accept_program_application') ?? [])].sort(),
    ).toEqual(['application_id', 'organization_slug', 'program_id']);
  });

  it('every parameter a SKILL.md code block passes to an atom is a real parameter of that atom', () => {
    const skillsDir = path.join(REPO_ROOT, 'skills');
    const violations: string[] = [];

    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(skillsDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;

      const md = fs.readFileSync(file, 'utf-8');
      for (const { atom, param } of extractCalls(md, atomNames)) {
        const real = atomParams.get(atom)!;
        if (real.has(param)) continue;
        const key = `${entry.name}:${atom}:${param}`;
        if (KNOWN_DRIFT.has(key)) continue;
        violations.push(
          `${entry.name}/SKILL.md passes \`${param}\` to \`${atom}\`, which takes only: ${[...real].sort().join(', ')}`,
        );
      }
    }

    expect(violations, violations.join('\n')).toEqual([]);
  });
});
