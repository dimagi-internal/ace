/**
 * Ratchet: nothing ACE ships may teach the pre-2026-09-27 Nova authoring
 * contract (voidcraft-labs/commcare-nova#693, ace#2526).
 *
 * Since that deploy every Nova app MUTATION is staged in private work — it
 * takes `work_id` + `request_id`, never `app_id`, and changes nothing until
 * `save_work`. `create_app` is gone. A skill that still shows
 * `add_fields({app_id, …})` does not fail loudly: Nova refuses the call, the
 * agent "fixes" it by guessing, and the most plausible guess (open work, edit,
 * forget to save) ships an app WITHOUT the edit and with no error anywhere.
 * See playbook/integrations/nova-integration.md § The private-work authoring
 * contract.
 *
 * Two checks:
 *  1. A staged mutation shown with an `app_id` argument (a call-shaped snippet:
 *     `tool({ … app_id …})` or `novaCall('tool', { … app_id …})`).
 *  2. `create_app` named as something to CALL — allowed only in text that
 *     marks it retired.
 *
 * Scope is the text an agent executes from. History (docs/learnings,
 * .claude/pm, CHANGELOG, test fixtures) is out of scope on purpose.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Pinned in scripts/probe-nova-contract.ts as requiring work_id + request_id. */
const STAGED = [
  'create_module', 'create_form', 'add_fields', 'edit_field', 'remove_field', 'move_field',
  'update_form', 'update_module', 'update_app', 'configure_connect', 'set_field_options_source',
  'attach_field_media', 'attach_option_media', 'set_menu_media', 'set_app_logo',
  'update_translations', 'add_language', 'set_form_sections', 'configure_case_list',
  'add_case_list_columns', 'create_lookup_table', 'remove_lookup_table',
];

/**
 * ACE atoms that share a bare Nova name but talk to CommCare HQ
 * (`commcare_create_lookup_table`, …). The `(?<![A-Za-z_])` guard below
 * already excludes a prefixed name; this list documents why.
 */
const SCOPE = ['skills', 'agents', 'commands', 'lib', 'scripts', 'bin', 'playbook'];

function files(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', ...SCOPE], { cwd: ROOT, encoding: 'utf8' });
  return out
    .split('\0')
    .filter((f) => /\.(md|ts|mjs|js)$/.test(f) || f.startsWith('bin/'))
    .filter((f) => !f.includes('/test/') && fs.existsSync(path.join(ROOT, f)));
}

/** Call-shaped snippets: `tool({ ...` or `('tool', { ...`, up to the matching close (bounded). */
function callsWithAppId(text: string, tool: string): string[] {
  const hits: string[] = [];
  const re = new RegExp(`(?<![A-Za-z_])${tool}\\s*\\(\\s*\\{|['"\`]${tool}['"\`]\\s*,\\s*\\{`, 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    // Scan to the balancing brace, capped so prose can't swallow the file.
    let depth = 0;
    let i = text.indexOf('{', m.index);
    const start = i;
    for (; i < text.length && i - start < 1200; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) break;
    }
    const args = text.slice(start, i + 1);
    if (/(?<![A-Za-z_])app_id\b/.test(args) && !/\bwork_id\b/.test(args)) {
      hits.push(`${tool}${args.replace(/\s+/g, ' ').slice(0, 140)}`);
    }
  }
  return hits;
}

const RETIRED_MARKER = /removed|retired|gone|no longer|#693|replac|pre-2026-09-27|before 2026-09-27|there is no|superseded|used to|history|RETIRED_TOOLS|old /i;

describe('no ACE text teaches the pre-#693 Nova authoring contract', () => {
  const all = files();

  it('scans a real corpus', () => {
    expect(all.length).toBeGreaterThan(100);
  });

  it('no staged mutation is shown with app_id instead of work_id', () => {
    const offenders: string[] = [];
    for (const f of all) {
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
      for (const tool of STAGED) {
        for (const hit of callsWithAppId(text, tool)) offenders.push(`${f}: ${hit}`);
      }
    }
    expect(offenders, `staged Nova mutations still addressed by app_id:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('create_app is only mentioned as retired', () => {
    const offenders: string[] = [];
    for (const f of all) {
      const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!/(?<![A-Za-z_])create_app\b/.test(line)) return;
        const ctx = lines.slice(Math.max(0, i - 2), i + 3).join(' ');
        if (!RETIRED_MARKER.test(ctx)) offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 140)}`);
      });
    }
    expect(offenders, `create_app referenced as live:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('the detector fires on what it exists to catch', () => {
  it('flags the 2026-09 fallback example that shipped in agents/commcare-setup.md', () => {
    const old = "await novaCall('create_module', { app_id, name, case_type: null, forms: [...] });";
    expect(callsWithAppId(old, 'create_module')).toHaveLength(1);
  });

  it('flags an MCP-call-shaped snippet', () => {
    expect(callsWithAppId('add_fields({ app_id: A, moduleUuid: M, formUuid: F, fields })', 'add_fields')).toHaveLength(1);
  });

  it('passes the private-work shape and the HQ namesake', () => {
    expect(callsWithAppId('add_fields({ work_id: W, request_id: R, formUuid: F, fields })', 'add_fields')).toEqual([]);
    expect(callsWithAppId("commcare_create_lookup_table({ app_id: 'x' })", 'create_lookup_table')).toEqual([]);
  });
});
