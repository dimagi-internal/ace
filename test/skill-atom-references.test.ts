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

  // ---- Doctor probe / field-key / Android-view-ID names (PR-S
  //      detector-widening surfaced these once agents/+playbook/integrations/
  //      came into scope) ----
  'drive_shared',                  // bin/ace-doctor probe label (PASS/FAIL on Shared-Drive parent guard)
  'ocs_chatbot',                   // field key in run_state.yaml.phases.ocs-setup.products.ocs_chatbot
  'connect_primary_phone_input',   // org.commcare.dalvik:id/connect_primary_phone_input AutoCompleteTextView
  'slides_create_presentation',    // playbook/integrations/slides-integration.md: documented as "does not exist as an MCP atom"
  'commcare_cli_jar',              // bin/ace-doctor probe label for the commcare-cli.jar presence/freshness check

  // ---- Known drift candidates (resolved as of 2026-05-25) ----
  //
  // PR-N (2026-05-25) resolved: connect_delete_opportunity (skill
  // reworded to manual UI deletion + connect_create_opportunity);
  // docs_finalize_bold + drive_extract_pdf_text (skill text changed
  // from backticked to italicized "planned, not yet built" form so
  // the drift detector regex no longer matches).
  //
  // PR-Q (2026-05-25) resolved the remaining 6: connect_list_program_applications,
  // connect_delete_payment_unit, commcare_linked_app_copy,
  // commcare_list_form_repeaters, commcare_list_conditional_alerts,
  // ocs_update_pipeline_node — all reworded from backticked to
  // italicized "(not yet built)" form. Allowlist is now drift-free;
  // any future entry here should ship with a follow-up cleanup PR.
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

function extractDocMentions(): Map<string, Set<string>> {
  // Returns a map: token → set of source-doc paths that mention it.
  // Scans every markdown file in the three locations skills reference
  // atoms from: `skills/*/SKILL.md`, `agents/*.md`, and
  // `playbook/integrations/*.md`. The PR-S widening added the latter
  // two — same drift class, just a different surface (procedure docs
  // and integration playbooks can paraphrase atoms as easily as
  // skills can).
  const tokenPattern = new RegExp(
    '`((?:' +
      ATOM_PREFIXES.map((p) => p.replace(/_$/, '')).join('|') +
      ')_[a-z][a-z0-9_]*)`',
    'g',
  );
  const mentions = new Map<string, Set<string>>();
  const sources: string[] = [];
  const skillsDir = path.join(REPO_ROOT, 'skills');
  for (const d of fs.readdirSync(skillsDir)) {
    const p = path.join(skillsDir, d, 'SKILL.md');
    if (fs.existsSync(p)) sources.push(p);
  }
  for (const dirRel of ['agents', 'playbook/integrations']) {
    const dirAbs = path.join(REPO_ROOT, dirRel);
    if (!fs.existsSync(dirAbs)) continue;
    for (const f of fs.readdirSync(dirAbs)) {
      const p = path.join(dirAbs, f);
      if (p.endsWith('.md')) sources.push(p);
    }
  }
  for (const p of sources) {
    const txt = fs.readFileSync(p, 'utf-8');
    let m: RegExpExecArray | null;
    while ((m = tokenPattern.exec(txt)) !== null) {
      const tok = m[1];
      if (!mentions.has(tok)) mentions.set(tok, new Set());
      // Use the repo-relative path so failure messages name the
      // offending file precisely.
      mentions.get(tok)!.add(path.relative(REPO_ROOT, p));
    }
  }
  return mentions;
}

describe('docs → atom reference integrity', () => {
  const atoms = extractRegisteredAtoms();
  const mentions = extractDocMentions();

  it('every atom-shaped token mentioned in a skill/agent/playbook doc is either a registered atom or in the allowlist', () => {
    const offenders: Array<{ token: string; files: string[] }> = [];
    for (const [token, fileSet] of mentions) {
      if (atoms.has(token)) continue;
      if (ALLOWLIST.has(token)) continue;
      offenders.push({ token, files: [...fileSet].sort() });
    }
    if (offenders.length > 0) {
      const summary = offenders
        .map((o) => `  - \`${o.token}\`  — mentioned in: ${o.files.join(', ')}`)
        .join('\n');
      throw new Error(
        `${offenders.length} atom-shaped token(s) referenced in skills/agents/playbook are neither registered atoms nor in the allowlist:\n${summary}\n\n` +
          `Fix options:\n` +
          `  (a) Register the atom in the relevant mcp/*-server.ts (the real fix), OR\n` +
          `  (b) If the token is a field/env-var/Android-id/recipe-type that just LOOKS atom-shaped, add it to ALLOWLIST in test/skill-atom-references.test.ts with a one-line comment.\n` +
          `  (c) If the doc mentions an atom name that no longer exists, update the doc text.`,
      );
    }
    expect(offenders).toEqual([]);
  });

  it('every allowlist entry is actually referenced by at least one doc (no stale entries)', () => {
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

/**
 * Preventer for the dead-field-read class of skill bug.
 *
 * `opp.yaml.last_run_id` was retired 2026-05-10 (per
 * `lib/artifact-manifest.ts`: "Earlier shapes also carried `last_run_id`
 * and a `runs:` array; both were dropped because no consumer reads them
 * — ace-web enumerates runs by listing the filesystem under runs/.").
 * Three Phase 7 skills (`synthetic-data-generate`, `synthetic-summary`,
 * `synthetic-narrative-plan`) kept reading it and were silently broken
 * on any opp created after the retire. Replacement: the
 * `mcp__plugin_ace_ace-gdrive__resolve_current_run_id` atom (lists
 * `<opp>/runs/` and picks the newest folder name).
 *
 * Rule: no SKILL.md may use `<last_run_id>` as a path-template
 * placeholder. Prose references to "the old `opp.yaml.last_run_id`
 * read" are fine — those are historical context, not active code-path
 * usage.
 */
describe('SKILL.md dead-field preventers', () => {
  it('no SKILL.md uses `<last_run_id>` as a path-template placeholder', () => {
    const skillDir = path.join(REPO_ROOT, 'skills');
    const offenders: { skill: string; lines: number[] }[] = [];
    for (const entry of fs.readdirSync(skillDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillPath = path.join(skillDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;
      const src = fs.readFileSync(skillPath, 'utf-8');
      const lines: number[] = [];
      src.split('\n').forEach((line, i) => {
        if (line.includes('<last_run_id>')) lines.push(i + 1);
      });
      if (lines.length > 0) offenders.push({ skill: entry.name, lines });
    }
    if (offenders.length > 0) {
      throw new Error(
        `Skills using the dead \`<last_run_id>\` placeholder ` +
          `(replace with \`<run_id>\` resolved via the ` +
          `\`mcp__plugin_ace_ace-gdrive__resolve_current_run_id\` atom):\n  ` +
          offenders
            .map((o) => `${o.skill}: lines ${o.lines.join(', ')}`)
            .join('\n  '),
      );
    }
    expect(offenders).toEqual([]);
  });
});
