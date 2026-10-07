/**
 * The open-questions ledger is retired, and NOTHING reads it — except the
 * one-time migration tool. Open asks are a filter over decision rows, never a
 * file.
 *
 * ## History this pins
 *
 *  - ace#1753: the ledger had one home (the opp root), and the fence once
 *    told the orchestrator to write a run-folder copy no surface displayed.
 *  - 2026-10-04 (docs/superpowers/specs/2026-10-04-open-questions-into-decisions-design.md):
 *    every question became a decision row, but the fold kept two legacy
 *    models alive — a generated `ACE/<opp>/open-asks.yaml` (a second store
 *    for what is only a filter), and a "legacy read" of an un-migrated
 *    `open-questions.md` at Phase 1. No opp was ever migrated, so ledger
 *    content kept being carried forward into every new run.
 *  - 2026-10-07, operator decision (ace#2757): *"why isn't that just a
 *    filter of decisions … when we created the new system we should not have
 *    carried forward any legacy models so fix that."* `open-asks.yaml` is
 *    gone, `lib/open-questions-inline.ts` is gone, and
 *    `scripts/migrate-open-questions.ts` (+ `lib/open-questions-migrate.ts`)
 *    is the only code that opens a ledger.
 *
 * ## Evidence class
 *
 * STATIC TEXT over ACE's own code and instructional docs. Nothing here is sent
 * to or matched against an external system. Docs that RECORD the history
 * (CHANGELOG, specs under `docs/`, this test) are not scanned.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_MANIFEST } from '../../lib/artifact-manifest.js';
import { generateRunReadme } from '../../lib/run-readme.js';
import { classifyOppRootEntry } from '../../lib/opp-root-files.js';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

function walk(dir: string, keep: (name: string) => boolean, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e === 'node_modules') continue;
    const abs = join(dir, e);
    if (statSync(abs).isDirectory()) walk(abs, keep, acc);
    else if (keep(e)) acc.push(abs);
  }
  return acc;
}

const rel = (abs: string) => relative(REPO, abs).split(sep).join('/');

/** Instructional surfaces an agent executes. */
function instructionalFiles(): string[] {
  return ['agents', 'skills', 'commands'].flatMap((d) => walk(join(REPO, d), (n) => n.endsWith('.md')));
}

/** Executable code. Tests are not scanned (fixtures name the files on purpose). */
function codeFiles(): string[] {
  return ['lib', 'mcp', 'scripts', 'bin', 'hooks'].flatMap((d) =>
    walk(join(REPO, d), (n) => /\.(ts|mjs|js|py|sh)$/.test(n) && !/\.test\.ts$/.test(n)),
  );
}

function offendingLines(files: string[], patterns: readonly RegExp[]): string[] {
  const out: string[] = [];
  for (const abs of files) {
    readFileSync(abs, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const re of patterns) if (re.test(line)) out.push(`${rel(abs)}:${i + 1}  ${line.trim()}`);
      });
  }
  return out;
}

/** The only code allowed to name or open a ledger file. */
const LEDGER_CODE_ALLOWLIST: Record<string, string> = {
  'scripts/migrate-open-questions.ts': 'the one-time migration tool — the only ledger reader',
  'lib/open-questions-migrate.ts': 'the migration tool\'s library (holds the ledger parser)',
  'lib/opp-root-files.ts': 'QUARANTINE entry only — keeps Step 5b from moving the retired files into inputs/; reads nothing',
};

describe('no skill, agent or lib reads open-questions.md except the migration tool (ace#2757)', () => {
  it('the Phase 1 legacy reader is deleted', () => {
    expect(existsSync(join(REPO, 'lib/open-questions-inline.ts'))).toBe(false);
  });

  it('only the migration script imports the ledger parser', () => {
    const importers = codeFiles().filter((abs) => /open-questions-migrate(\.js)?['"]/.test(readFileSync(abs, 'utf8')));
    expect(importers.map(rel)).toEqual(['scripts/migrate-open-questions.ts']);
  });

  it('no code outside the allowlist names a ledger or open-asks.yaml as a string', () => {
    // String literals only — a backticked name in a comment that records
    // history is not a reader.
    const LITERAL = /['"]open-questions(\.archived)?\.md['"]|['"]open-asks\.yaml['"]|OPEN_ASKS_FILENAME/;
    const offenders = codeFiles()
      .filter((abs) => !(rel(abs) in LEDGER_CODE_ALLOWLIST))
      .filter((abs) => LITERAL.test(readFileSync(abs, 'utf8')))
      .map(rel);
    expect(offenders, `ledger literal outside the allowlist: ${offenders.join(', ')}`).toEqual([]);
  });

  it('no agent, skill or command instructs reading a ledger, or calls a retired reader', () => {
    const READS: readonly RegExp[] = [
      /drive_read_file[^\n]*open-questions(\.archived)?\.md/,
      /open-questions(\.archived)?\.md[^\n]*drive_read_file/,
      /extractOpenSection|selectOpenRows|classifyOpenQuestionsInline|OPEN_QUESTIONS_INLINE_CAP_CHARS|open-questions-inline/,
      /`## Open` (rows|section)/,
      /decisions_open_asks\([^)]*mode:/,
      /mode: 'emit'/,
      /checkOpenQuestionsWriteShape|checkOpenQuestionsPlainLanguage/,
      /§ The durable open-questions doc/,
      /drive_create_doc_from_markdown[^\n]*open-questions\.md/,
    ];
    // A row of a case-history table (`| ace#NNNN | … |`) cites a defect; it
    // instructs nothing.
    const offenders = offendingLines(instructionalFiles(), READS).filter((l) => !/^\S+:\d+ {2}\| ace#\d+ \|/.test(l));
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('the retired files are a quarantine entry in the opp-root registry, not live state', () => {
    for (const name of ['open-questions.md', 'open-questions.archived.md', 'open-asks.yaml']) {
      const entry = classifyOppRootEntry(name);
      expect(entry?.label, name).toBe('retired open-questions files');
      expect(entry?.why).toMatch(/QUARANTINE/);
      expect(entry?.why).toMatch(/No run reads them/);
    }
  });
});

describe('open asks are a filter over decisions, never a file (ace#2757)', () => {
  it('the manifest declares neither open-asks.yaml nor the ledger', () => {
    const paths = ARTIFACT_MANIFEST.map((a) => a.path);
    expect(paths.filter((p) => /open-asks|open-questions/.test(p))).toEqual([]);
  });

  it('the run README advertises neither', () => {
    const md = generateRunReadme('20260827-0323');
    expect(md).not.toContain('open-questions.md');
    expect(md).not.toContain('open-asks.yaml');
  });

  it('the run-end fence and Phase 1 call decisions_open_asks read-only, and write no file', () => {
    const text = readFileSync(join(REPO, 'agents/ace-orchestrator.md'), 'utf8');
    const runEnd = text.indexOf('**Open asks (run-end, once).**');
    expect(runEnd, 'the boundary-fence open-asks paragraph is gone').toBeGreaterThan(-1);
    const para = text.slice(runEnd, runEnd + 1500);
    expect(para).toContain('decisions_open_asks(runFolderId, opportunity, run_id, checkCarried: true)');
    expect(para).toMatch(/Nothing is written for open asks/);
    expect(para).toMatch(/never read a value back out of it/i);

    const p1 = text.indexOf('**Open asks from the previous run — a check, never an input.**');
    expect(p1).toBeGreaterThan(-1);
    const p1para = text.slice(p1, p1 + 2500);
    expect(p1para).toContain('decisions_open_asks(runFolderId, opportunity, run_id, throughPhase: 1)');
    expect(p1para).toMatch(/nothing reads it/);
    expect(text).not.toContain('**Legacy ledger (opps not yet migrated).**');
  });

  it('decisions_open_asks takes no mode and declares no write', () => {
    const src = readFileSync(join(REPO, 'mcp/decisions-server.ts'), 'utf8');
    const reg = src.slice(src.indexOf("'decisions_open_asks',"));
    const schema = reg.slice(0, reg.indexOf('async (args)'));
    expect(schema).not.toMatch(/\bmode:/);
    expect(schema).toContain('writes nothing');
  });

  it('idea-to-pdd states the producer rule and takes no prior-run ledger input', () => {
    const skill = readFileSync(join(REPO, 'skills/idea-to-pdd/SKILL.md'), 'utf8');
    expect(skill).toContain('## Asks are decision rows (the open-questions ledger is retired)');
    expect(skill).toMatch(/a default you build on is a decision row/i);
    expect(skill).not.toContain('Prior runs (legacy only)');
    expect(skill).not.toContain('Legacy ledger rows, when the orchestrator passes them');
  });
});
