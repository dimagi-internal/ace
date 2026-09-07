/**
 * The class-level preventer for ace#2126.
 *
 * `test/mcp/gdrive/copy-template-coverage.test.ts` proves the ATOM reports an
 * unmatched replacement key. It cannot prove anyone READS the report — and a
 * reported warning is only a gate if something reads it. ace#2168 wired exactly
 * one caller; five other files named the atoms and none of them looked at the
 * field. Nothing would have failed if the next caller had been added the same
 * way, which is how the original defect got in.
 *
 * The fixture suites below exercise the rules against synthetic inputs (so the
 * assertions are seen to FIRE, not merely to stay green), and the repo suite
 * runs them over the real tree.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  auditCopyTemplateCallers,
  findCallSites,
  CALLER_REGISTRY,
  COVERAGE_ATOMS,
  COVERAGE_FIELD,
  type RegistryEntry,
  type SourceFile,
} from '../../lib/copy-template-caller-audit.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// --------------------------------------------------------------------------
// Fixtures — prove each rule fires
// --------------------------------------------------------------------------

const PRODUCER_DOC: SourceFile = {
  path: 'skills/fake-producer/SKILL.md',
  text: [
    '5. **Render the template.**',
    '   - `docs_copy_template(templateDocId=<TEMPLATE_ID>, title="out.gdoc", replacements={...})`',
    '   - Then read the doc back.',
  ].join('\n'),
};

const PRODUCER_ENTRY: RegistryEntry = {
  file: PRODUCER_DOC.path,
  kind: 'producer',
  reason: 'fixture',
};

describe('findCallSites', () => {
  it('flags an inline call that passes replacements', () => {
    const sites = findCallSites(PRODUCER_DOC);
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({
      atom: 'docs_copy_template',
      line: 2,
      producing: true,
      signal: 'replacements',
    });
  });

  it('flags the bulleted-argument call shape, where the signal is lines below', () => {
    const sites = findCallSites({
      path: 'skills/fake/SKILL.md',
      text: [
        '6. **Copy template.** Call `slides_copy_template` with:',
        '   - `templatePresentationId`: `ACE_TRAINING_DECK_TEMPLATE_ID`',
        '   - `title`: `"deck"`',
        '   - `parentFolderId`: the run folder',
        '   - `replacements`: the deck-wide token map',
      ].join('\n'),
    });
    expect(sites[0]).toMatchObject({ producing: true, signal: 'replacements' });
  });

  it('does NOT flag a bare prose mention as producing', () => {
    const sites = findCallSites({
      path: 'skills/fake/SKILL.md',
      text: '- `1-design/pdd-to-work-order.gdoc` — built by `docs_copy_template`\n- next line',
    });
    expect(sites).toHaveLength(1);
    expect(sites[0].producing).toBe(false);
  });

  it('counts the deck path, whose substitution runs through slides_batch_update', () => {
    const sites = findCallSites({
      path: 'skills/fake/SKILL.md',
      text: [
        '11. **Execute the batch update.**',
        '    Call `slides_batch_update` with all requests from step 10.',
        '    Those are the `replaceAllText` requests from `buildSlidesRequestsV2`.',
      ].join('\n'),
    });
    expect(sites[0]).toMatchObject({ atom: 'slides_batch_update', producing: true });
  });

  // The three prose shapes that a signal-only rule flagged as calls. All are
  // verbatim from the repo; all are descriptions, not invocations.
  it.each([
    [
      'run-surface-audit',
      '- **`1-design/pdd-to-work-order.gdoc`** — built by `docs_copy_template`\n  (`drive.files.copy` + `replaceAllText`), Doc to Doc',
    ],
    [
      'partnership-video',
      '   - Renders to Google Slides via the 14-stencil ACE template machinery\n     (`slides_copy_template` → `slides_get` → `buildSlidesRequestsV2` →\n     `slides_batch_update`)',
    ],
    ['qa-and-training', '  the opp folder, fills via `slides_batch_update`, returns the'],
  ])('treats %s prose as a reference, not a call', (_name, text) => {
    const sites = findCallSites({ path: 'skills/fake/SKILL.md', text });
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.every((s) => !s.producing)).toBe(true);
  });

  it('sees a signal far below the call as OUT of the window', () => {
    const filler = Array(20).fill('   (unrelated prose)').join('\n');
    const sites = findCallSites({
      path: 'skills/fake/SKILL.md',
      text: `Call \`docs_copy_template\` here.\n${filler}\nreplacements={...}`,
    });
    expect(sites[0].producing).toBe(false);
  });
});

describe('auditCopyTemplateCallers', () => {
  it('FAILS a producer that never reads the coverage field', () => {
    const v = auditCopyTemplateCallers([PRODUCER_DOC], [PRODUCER_ENTRY]);
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe('unread-coverage');
    expect(v[0].message).toContain(COVERAGE_FIELD);
    expect(v[0].message).toContain('skills/fake-producer/SKILL.md:2');
  });

  it('passes the same producer once it reads the field', () => {
    const wired: SourceFile = {
      ...PRODUCER_DOC,
      text: `${PRODUCER_DOC.text}\n   - Read \`${COVERAGE_FIELD}\` on the result; halt if non-empty.`,
    };
    expect(auditCopyTemplateCallers([wired], [PRODUCER_ENTRY])).toEqual([]);
  });

  it('FAILS a file that names an atom without being classified at all', () => {
    const v = auditCopyTemplateCallers([PRODUCER_DOC], []);
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe('unregistered-file');
    expect(v[0].message).toContain('CALLER_REGISTRY');
  });

  it('FAILS a file the registry calls a reference that actually substitutes tokens', () => {
    const v = auditCopyTemplateCallers(
      [PRODUCER_DOC],
      [{ file: PRODUCER_DOC.path, kind: 'reference', reason: 'fixture' }],
    );
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe('misclassified-reference');
  });

  it('lets a genuine reference through without demanding it read a result', () => {
    const ref: SourceFile = {
      path: 'skills/fake-ref/SKILL.md',
      text: '- `pdd-to-work-order.gdoc` — built by `docs_copy_template`\n- unrelated',
    };
    const v = auditCopyTemplateCallers(
      [ref],
      [{ file: ref.path, kind: 'reference', reason: 'fixture' }],
    );
    expect(v).toEqual([]);
  });

  it('FAILS a registry entry whose file no longer mentions any atom', () => {
    const v = auditCopyTemplateCallers(
      [{ path: 'skills/fake-ref/SKILL.md', text: 'nothing relevant here' }],
      [{ file: 'skills/fake-ref/SKILL.md', kind: 'reference', reason: 'fixture' }],
    );
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe('stale-registry-entry');
  });
});

// --------------------------------------------------------------------------
// The repo scan — the actual ratchet
// --------------------------------------------------------------------------

const SCAN_DIRS = ['skills', 'agents', 'commands'];

function walk(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name.endsWith('.md')) acc.push(full);
  }
  return acc;
}

function repoFiles(): SourceFile[] {
  return SCAN_DIRS.flatMap((d) => walk(path.join(REPO_ROOT, d))).map((full) => ({
    path: path.relative(REPO_ROOT, full),
    text: fs.readFileSync(full, 'utf8'),
  }));
}

describe('every producing caller in the repo reads unmatchedReplacements (ace#2126)', () => {
  it('has no violations', () => {
    const violations = auditCopyTemplateCallers(repoFiles());
    expect(violations.map((v) => `[${v.kind}] ${v.message}`)).toEqual([]);
  });

  it('still finds the callers it is meant to be guarding', () => {
    // A regex that matches nothing would make the suite above vacuously green —
    // the same failure shape as the defect it guards.
    const sites = repoFiles().flatMap(findCallSites);
    expect(sites.length).toBeGreaterThan(5);
    expect(sites.some((s) => s.file === 'skills/pdd-to-work-order/SKILL.md')).toBe(true);
    expect(sites.some((s) => s.producing)).toBe(true);
  });

  it('classifies both deck producers, which ace#2168 left unwired', () => {
    const decks = [
      'skills/training-deck-render/SKILL.md',
      'skills/partnership-deck-build/SKILL.md',
    ];
    for (const file of decks) {
      const entry = CALLER_REGISTRY.find((e) => e.file === file);
      expect(entry, `${file} must be classified`).toBeDefined();
      expect(entry!.kind).toBe('producer');
      const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
      expect(text, `${file} must read ${COVERAGE_FIELD}`).toContain(COVERAGE_FIELD);
    }
  });

  it('names every atom whose reply carries coverage', () => {
    // Drift guard: if a new atom starts reporting coverage, it belongs here or
    // its callers are unguarded.
    const server = fs.readFileSync(
      path.join(REPO_ROOT, 'mcp', 'google-drive-server.ts'),
      'utf8',
    );
    for (const atom of COVERAGE_ATOMS) {
      expect(server, `${atom} should exist in the gdrive server`).toContain(`'${atom}'`);
    }
    // Every place the server emits the field is inside one of the named atoms.
    const emitters = server.split('\n').filter((l) => l.includes(`${COVERAGE_FIELD}:`));
    expect(emitters.length).toBe(COVERAGE_ATOMS.length);
  });
});
