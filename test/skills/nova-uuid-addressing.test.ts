/**
 * Nova uuid-addressing lint — a repo-grep invariant over `skills/**\/*.md`.
 *
 * Nova redeployed on 2026-07-31 and moved its ENTIRE MCP surface from
 * index-based to uuid-based addressing in one shot (dimagi-internal/ace#1132).
 * Verified against `POST https://mcp.commcare.app/mcp` `tools/list`: 63 tools,
 * and **zero of them accept any `*Index` parameter**. A call spelled
 * `get_form({app_id, moduleIndex, formIndex})` is rejected server-side:
 *
 *   MCP error -32602: Invalid arguments for tool get_field:
 *     path: ["moduleUuid"]  expected string, received undefined
 *     code: "unrecognized_keys"  keys: ["moduleIndex","formIndex","fieldId"]
 *
 * ACE skills are markdown procedure documents an LLM executes verbatim, so a
 * skill that spells a Nova call with an index param **names an uncallable
 * operation** — the agent copies it, the call 400s, and the phase stalls.
 * Prose is not testable, but a *call expression* is: it's a known tool name
 * followed by an argument object. This lint asserts no skill passes an index
 * param inside one.
 *
 * Sibling of the `agents/*.md` status-enum lint (PR #1151): same shape —
 * a deterministic grep over LLM-executed markdown, catching a class that
 * would otherwise only surface as a live tool rejection mid-run.
 *
 * It also forbids `generate_scaffold(` outright: that tool does not exist on
 * the live surface at all (it is `generate_schema`), so any call form is dead.
 *
 * Deliberately NOT asserted here: prose that *mentions* `moduleIndex` etc.
 * outside a call (changelog rows, "no tool accepts moduleIndex" warnings).
 * Those are the migration's own documentation and must stay greppable.
 *
 * Canonical contract: `playbook/integrations/nova-integration.md
 * § The 2026-07-31 uuid-addressing migration`.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SKILLS_DIR = path.join(REPO_ROOT, 'skills');

/**
 * Nova tools that take an addressing argument. Names as registered live
 * (`mcp__plugin_nova_nova__*`), plus the two legacy singular spellings that
 * still appear in older skill prose (`add_case_list_column`,
 * `add_search_input`) so an index passed to one is still caught.
 */
const NOVA_ADDRESSED_TOOLS = [
  'get_module',
  'get_form',
  'get_field',
  'add_fields',
  'edit_field',
  'move_field',
  'remove_field',
  'update_form',
  'update_module',
  'update_app',
  'remove_form',
  'remove_module',
  'configure_connect',
  'add_case_list_columns',
  'add_case_list_column',
  'update_case_list_column',
  'remove_case_list_column',
  'reorder_case_list_columns',
  'add_search_inputs',
  'add_search_input',
  'update_search_input',
  'remove_search_input',
  'set_case_list_filter',
  'set_case_search_display',
  'set_case_search_advanced',
  'set_field_options_source',
  'attach_field_media',
  'get_case_operations',
  'add_case_operations',
  'update_case_operation',
  'set_menu_media',
  'generate_schema',
];

/** Index-style params. None of these exist on any live Nova tool. */
const FORBIDDEN_PARAMS = ['moduleIndex', 'formIndex', 'fieldIndex', 'fieldId', 'form_id'];

/**
 * Argument window for a call: from the tool name's `(` up to the first `)`,
 * bounded to 200 chars so an unclosed paren in prose can't swallow the rest
 * of the file. Skill markdown wraps calls across lines, so newlines count.
 */
const WINDOW = 200;

interface Violation {
  file: string;
  line: number;
  tool: string;
  param: string;
  excerpt: string;
}

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(full));
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function scan(body: string, relPath: string): Violation[] {
  const violations: Violation[] = [];
  // Optional `nova_` / `nova.` prefix — some skills spell the atoms that way.
  // A closing backtick may sit between the name and its arg list — skills
  // routinely write ``get_form` (one call per `(moduleIndex, formIndex)`)``.
  const callRe = new RegExp(
    `\\b(?:nova[_.])?(${NOVA_ADDRESSED_TOOLS.join('|')})\`?\\s*\\(`,
    'g',
  );
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(body)) !== null) {
    const tool = m[1];
    const argStart = m.index + m[0].length;
    const close = body.indexOf(')', argStart);
    const end = close === -1 ? argStart + WINDOW : Math.min(close, argStart + WINDOW);
    const args = body.slice(argStart, end);
    for (const param of FORBIDDEN_PARAMS) {
      if (new RegExp(`\\b${param}\\b`).test(args)) {
        violations.push({
          file: relPath,
          line: body.slice(0, m.index).split('\n').length,
          tool,
          param,
          excerpt: `${tool}(${args.replace(/\s+/g, ' ').trim()})`,
        });
      }
    }
  }
  return violations;
}

const SKILL_MD = markdownFiles(SKILLS_DIR).map((f) => ({
  abs: f,
  rel: path.relative(REPO_ROOT, f),
  body: fs.readFileSync(f, 'utf-8'),
}));

describe('Nova uuid addressing (ace#1132)', () => {
  it('finds skill markdown to lint (guards against a vacuous pass)', () => {
    expect(SKILL_MD.length).toBeGreaterThan(50);
    // The lint is only meaningful if these files actually spell Nova calls.
    const withNovaCalls = SKILL_MD.filter((f) => /\bget_form\s*\(/.test(f.body));
    expect(withNovaCalls.length).toBeGreaterThan(2);
  });

  it('no skill passes an index param to a Nova tool', () => {
    const violations = SKILL_MD.flatMap((f) => scan(f.body, f.rel));
    const report = violations
      .map((v) => `  ${v.file}:${v.line} — \`${v.param}\` passed to \`${v.tool}\`\n      ${v.excerpt}`)
      .join('\n');
    expect(
      violations,
      violations.length === 0
        ? ''
        : `Nova is uuid-addressed since 2026-07-31 — no live tool accepts an index ` +
            `param. These calls are rejected server-side with \`unrecognized_keys\`.\n` +
            `Use moduleUuid / formUuid / fieldUuid, resolved once from ` +
            `get_app({app_id}) (its blueprint prints [uuid …] on every module, form, ` +
            `and field) or search_blueprint({query, app_id}).\n${report}`,
    ).toEqual([]);
  });

  it('no skill calls generate_scaffold (the tool is generate_schema)', () => {
    const offenders = SKILL_MD.filter((f) => /\bgenerate_scaffold\s*\(/.test(f.body)).map(
      (f) => f.rel,
    );
    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `\`generate_scaffold\` is not a Nova tool — the live surface exposes ` +
            `\`generate_schema\`. Offending files:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  // The uuid lint above only inspects argument lists of spelled-out tool
  // CALLS, so it cannot see a shape documented in prose or in a decision
  // table. That blind spot let `user_score: "#form/user_score"` survive the
  // 2026-07-31 migration in app-connect-coverage Step 2 while Step 4a's
  // example already used the structured form — a self-inconsistent skill.
  it('no skill documents a Connect expression sub-config as a bare string', () => {
    // user_score / entity_id / entity_name are Expression slots: each takes
    // `{ parts: [...] }`. A quote straight after the colon is a string.
    const bareStringRe = /\b(user_score|entity_id|entity_name)\s*:\s*["']/g;
    const offenders = SKILL_MD.flatMap((f) => {
      const hits: string[] = [];
      let m: RegExpExecArray | null;
      // Fresh regex per file — /g lastIndex is stateful across .exec calls.
      const re = new RegExp(bareStringRe.source, 'g');
      while ((m = re.exec(f.body)) !== null) {
        const line = f.body.slice(0, m.index).split('\n').length;
        hits.push(`  ${f.rel}:${line} — \`${m[1]}\` given a string`);
      }
      return hits;
    });
    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `Connect expression sub-configs are structured since 2026-07-31 ` +
            `(ace#1132/#1133): \`user_score\`, \`entity_id\` and \`entity_name\` each ` +
            `take \`{ parts: [...] }\` with \`field-ref\` / \`case-ref\` / \`path-ref\` / ` +
            `\`text\` parts — an XPath string is rejected by Nova.\n` +
            `Note Nova's own field description still calls user_score "an XPath", ` +
            `which is a doc bug on its side; the schema is authoritative.\n` +
            `${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
