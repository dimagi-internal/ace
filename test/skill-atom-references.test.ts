/**
 * Skill → atom drift detector.
 *
 * Skills paraphrase MCP atom names inline ("call `connect_create_opportunity`,
 * passing …"). When an atom gets renamed or removed and the skill author
 * doesn't update the doc, the skill silently steers operators / agents
 * toward a nonexistent atom. This test catches that class of drift at
 * CI time.
 *
 * Approach:
 *   1. Build the live atom registry by parsing `server.tool('<name>', …)`
 *      calls in every `mcp/*-server.ts` (same parse the registration-
 *      coverage test uses).
 *   2. Scan every `skills/*\/SKILL.md` for backtick-wrapped tokens that
 *      LOOK atom-shaped (prefix matches a real MCP namespace).
 *   3. For each mentioned token:
 *      - If it's in the registry → fine.
 *      - If it's in the explicit allowlist (field name, env var, Android
 *        view ID, recipe-type tag) → fine.
 *      - Otherwise → DRIFT: skill references an atom-shaped name that
 *        isn't a real atom.
 *
 * Adding a new MCP atom that some skill should reference: the test will
 * pass automatically once the atom is registered.
 *
 * Adding a non-atom token that happens to be atom-shaped (a new
 * Android resource id, a new env-var, etc.): add it to ALLOWLIST below
 * with a one-line comment explaining what it is.
 *
 * Source of the bug class: `feedback_mcp_vs_skill_doc_drift` user memory
 * (canonical case: 0.9.4 `connect-opp-setup` `location` field — skill
 * said "meters threshold," atom takes a boolean toggle). This test
 * catches the RENAME / REMOVE half of the drift class; the SEMANTIC
 * half (skill describes a real atom's params wrong) needs a separate
 * inspection.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const SERVER_FILES = [
  'mcp/connect-server.ts',
  'mcp/ocs-server.ts',
  'mcp/google-drive-server.ts',
  'mcp/mobile-server.ts',
  'mcp/connect-labs-server.ts',
];

// Token prefixes that look "atom-shaped" — every MCP namespace registered
// in ACE plus the CommCare-via-Connect bridge prefix.
const ATOM_PREFIXES = [
  'connect_',
  'ocs_',
  'drive_',
  'sheets_',
  'docs_',
  'slides_',
  'commcare_',
  'mobile_',
];

/**
 * Allowlist of atom-shaped tokens that are NOT MCP atoms — fields, env
 * vars, Android resource IDs, recipe-type tags, etc. Each entry has a
 * one-line comment so a future reader can audit.
 *
 * If the test fails citing a new unknown token, either:
 *   (a) register the atom in the relevant server (the real fix), or
 *   (b) add the token here with a comment explaining what it is.
 *
 * If you find an entry here that is genuinely DRIFT (skill references
 * an atom-shaped name that should be an atom but isn't), delete the
 * entry and the test will surface the offending skill(s) — file an
 * issue or fix the skill.
 */
const ALLOWLIST = new Set([
  // ---- Field names / payload keys (not atoms) ----
  'connect_opportunity_id',  // bookkeeping field in run_state.yaml + opp.yaml
  'connect_program_id',      // bookkeeping field
  'connect_type',            // schema field on Connect modules
  'connect_markers',         // schema field set on forms
  'connect_username',        // env var (CONNECT_USERNAME)

  // ---- Env vars (atom-shaped only by coincidence) ----
  'connect_apk_version',     // ACE_CONNECT_APK_VERSION (lowercased in skill prose)
  'drive_root_folder_id',    // ACE_DRIVE_ROOT_FOLDER_ID

  // ---- Android view IDs referenced by mobile skills ----
  'connect_fragment_jobs_list',  // org.commcare.dalvik:id/connect_fragment_jobs_list

  // ---- Training-deck template kinds (recipe types, not atoms) ----
  'mobile_flow',  // template_kind for training-deck-render
  'mobile_zoom',  // template_kind for training-deck-render

  // ---- Known drift candidates (TODO: investigate / resolve) ----
  // Skills reference these as if they were atoms, but no atom is
  // registered. Either the atom should be added, or the skill text
  // should be reworded. Tracked here so the test can ship in detection
  // mode without immediately failing on pre-existing drift.
  //
  // Resolved in PR-N (2026-05-25): connect_delete_opportunity (skill
  // reworded to manual UI deletion + connect_create_opportunity);
  // docs_finalize_bold + drive_extract_pdf_text (skill text changed
  // from backticked to italicized "planned, not yet built" form so
  // the drift detector regex no longer matches).
  'connect_list_program_applications',  // skills/connect-opp-setup — recovery action; no atom
  'connect_delete_payment_unit',        // skills/connect-opp-setup — recovery action; no atom
  'commcare_linked_app_copy',           // skills/interview-cohort-create
  'commcare_list_form_repeaters',       // skills/interview-opp-verify
  'commcare_list_conditional_alerts',   // mcp/connect-server.ts comment marks atom DEFERRED
  'ocs_update_pipeline_node',           // skills/interview-cohort-create
]);

function extractRegisteredAtoms(): Set<string> {
  const atoms = new Set<string>();
  const re = /\bserver\.tool\s*\(\s*['"]([a-z][a-z0-9_]*)['"]/g;
  for (const f of SERVER_FILES) {
    const src = fs.readFileSync(path.join(REPO_ROOT, f), 'utf-8');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) atoms.add(m[1]);
  }
  return atoms;
}

function extractSkillMentions(): Map<string, Set<string>> {
  // Returns a map: token → set of skill names that mention it.
  const tokenPattern = new RegExp(
    '`((?:' +
      ATOM_PREFIXES.map((p) => p.replace(/_$/, '')).join('|') +
      ')_[a-z][a-z0-9_]*)`',
    'g',
  );
  const mentions = new Map<string, Set<string>>();
  const skillsDir = path.join(REPO_ROOT, 'skills');
  for (const d of fs.readdirSync(skillsDir)) {
    const p = path.join(skillsDir, d, 'SKILL.md');
    if (!fs.existsSync(p)) continue;
    const txt = fs.readFileSync(p, 'utf-8');
    let m: RegExpExecArray | null;
    while ((m = tokenPattern.exec(txt)) !== null) {
      const tok = m[1];
      if (!mentions.has(tok)) mentions.set(tok, new Set());
      mentions.get(tok)!.add(d);
    }
  }
  return mentions;
}

describe('skill → atom reference integrity', () => {
  const atoms = extractRegisteredAtoms();
  const mentions = extractSkillMentions();

  it('every atom-shaped token mentioned in a SKILL.md is either a registered atom or in the allowlist', () => {
    const offenders: Array<{ token: string; skills: string[] }> = [];
    for (const [token, skillSet] of mentions) {
      if (atoms.has(token)) continue;
      if (ALLOWLIST.has(token)) continue;
      offenders.push({ token, skills: [...skillSet].sort() });
    }
    if (offenders.length > 0) {
      const summary = offenders
        .map((o) => `  - \`${o.token}\`  — mentioned in: ${o.skills.join(', ')}`)
        .join('\n');
      throw new Error(
        `Skill references ${offenders.length} atom-shaped token(s) that are neither registered atoms nor in the allowlist:\n${summary}\n\n` +
          `Fix options:\n` +
          `  (a) Register the atom in the relevant mcp/*-server.ts (the real fix), OR\n` +
          `  (b) If the token is a field/env-var/Android-id/recipe-type that just LOOKS atom-shaped, add it to ALLOWLIST in test/skill-atom-references.test.ts with a one-line comment.\n` +
          `  (c) If the skill mentions an atom name that no longer exists, update the skill text.`,
      );
    }
    expect(offenders).toEqual([]);
  });

  it('every allowlist entry is actually referenced by at least one skill (no stale entries)', () => {
    const stale: string[] = [];
    for (const tok of ALLOWLIST) {
      if (!mentions.has(tok)) stale.push(tok);
    }
    if (stale.length > 0) {
      throw new Error(
        `${stale.length} ALLOWLIST entries are no longer referenced by any skill — remove them:\n  ` +
          stale.join(', '),
      );
    }
    expect(stale).toEqual([]);
  });

  it('snapshot — total registered atoms across MCP servers', () => {
    // Soft snapshot so an accidental large delta is visible in PR review.
    // Update intentionally when shipping atoms.
    expect(atoms.size).toBeGreaterThan(100);
  });
});
