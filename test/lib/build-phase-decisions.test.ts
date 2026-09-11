/**
 * The build phases log their calls as decision rows, and the boundary fence
 * fails a build that did not (dimagi-internal/ace#2384, a regression of #399).
 *
 * The positive control is the measured defect: `poverty-graduation/20260908-0510`
 * shipped 66 decision rows, 0 of them from the app build, while the Deliver
 * summary and the Learn build memo listed [ACE] latitudes and [FIXED]
 * ambiguities in prose. Before this module the fence's Decisions log clause
 * could not fire for Phase 3 (its catalogue has no required rows) and had no
 * implementation at all.
 */
import { describe, it, expect } from 'vitest';

import {
  BUILD_PHASE_DECISION_CONTRACTS,
  checkBuildPhaseDecisions,
  countBuildMemoItems,
  countSectionItems,
  decisionRowsFromYaml,
  unreadableBuildPhaseDecisions,
  verifyBuildPhaseDecisions,
  type DriveReadAdapter,
} from '../../lib/build-phase-decisions.js';
import { ARTIFACT_MANIFEST } from '../../lib/artifact-manifest.js';
import { resolvePhaseFolderName } from '../../lib/phase-closeout.js';

const DELIVER = '3-commcare/pdd-to-deliver-app_summary.md';
const LEARN = '3-commcare/pdd-to-learn-app_build-memo.md';
const OPP = '4-connect/connect-opp-setup.md';

const table = (header: string, rows: string[]) =>
  rows.length === 0 ? 'None.' : [header, header.replace(/[^|]+/g, '---'), ...rows].join('\n');

const LAT_HEADER = '| PDD § | What ACE chose | Why |';
const AMB_HEADER = '| PDD § | The ambiguity | How resolved, or OPEN |';

/** The Deliver summary shape pdd-to-deliver-app Step 7 specifies. */
function deliverSummary(lat: string[], amb: string[]): string {
  return `---
nova_app_id: 00000000-0000-0000-0000-000000000000
archetype: longitudinal-visits
option_source_gaps: []
---
# Deliver app — structure summary

## Modules

| Module | Forms | Fields |
|---|---|---|
| Household visit | 3 | 41 |
| Asset transfer | 2 | 18 |

## Build memo

### Screen-shape report

screen-shape: 14 screens checked, 0 over the field budget

### [ACE] latitudes taken

${table(LAT_HEADER, lat)}

### [FIXED] ambiguities hit

${table(AMB_HEADER, amb)}

### Language layer

No working language other than English.
`;
}

/** The Learn memo shape pdd-to-learn-app Step 7a specifies. */
function learnMemo(lat: string[], amb: string[]): string {
  return `# Learn app — build memo

## [ACE] latitudes taken

${table(LAT_HEADER, lat)}

## [FIXED] ambiguities hit

${table(AMB_HEADER, amb)}

## Framework gaps (Learn PDD §6(5))

- Component 5b (savings groups) is not in this programme; no module teaches it.

## Language layer

No working language other than English.

## Repairs applied

None.
`;
}

/** The Phase 4 section connect-opp-setup Step 8 specifies. */
function oppSetup(rules: string[], lat: string[], amb: string[]): string {
  return `# Opportunity configuration

Opportunity: https://connect.dimagi.com/a/org/opportunity/abc/

## Build memo — opportunity configuration and verification

### Verification rules — where each is applied

${table('| Rule (quoted) | PDD § | Where applied | Evidence |', rules)}

### [ACE] latitudes taken

${table('| PDD § | Value ACE chose | Why |', lat)}

### [FIXED] ambiguities hit

${table(AMB_HEADER, amb)}
`;
}

// Rows paraphrasing what the 20260908-0510 Deliver summary recorded (#2384).
const DELIVER_LAT = [
  '| Deliver §4 | One screen per asset-transfer step | PDD fixes the steps, not the screens |',
  '| Deliver §5 | Transfer method chosen before amount | Amount options depend on method |',
  '| Deliver §6 | Guards on the derived eligibility chain | Blank upstream answers broke the chain |',
  '| Deliver §7 | Asset menu from a lookup table | 23 assets; inline options drift |',
];
const DELIVER_AMB = [
  '| Targeting §3 [FIXED] | entity_id grain: household vs member | Built per household; OPEN for the author |',
];
const LEARN_LAT = [
  '| Learn §5 | Quiz item count 8 (derived, not read) | PDD gives a pass mark, not a count (#2364) |',
];

interface Row {
  id: string;
  phase: string;
  skill: string;
}
function decisionsYaml(rows: Row[]): string {
  const body = rows
    .map(
      (r) =>
        `  - id: ${r.id}\n    phase: ${r.phase}\n    skill: ${r.skill}\n    question: q\n` +
        `    ai-default: a\n    options: [a]\n    source: s\n    status: ai-default\n`,
    )
    .join('');
  return `schema_version: 5\nopportunity: poverty-graduation\nrun_id: 20260908-0510\ngenerated_at: 2026-09-08T05:10:00Z\ndecisions:\n${body}`;
}
const many = (n: number, phase: string, skill: string, prefix: string): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}`, phase, skill }));

// The 20260908-0510 register, by phase: 45 design, 5 connect, 4 ocs,
// 5 solicitation, 7 synthetic — and 0 from the app build.
const REGISTER_0510: Row[] = [
  ...many(45, '1-design', 'idea-to-pdd', 'd'),
  ...many(5, '4-connect', 'connect-opp-setup', 'c'),
  ...many(4, '5-ocs', 'ocs-agent-setup', 'o'),
  ...many(5, '8-solicitation', 'solicitation-create', 's'),
  ...many(7, '7-synthetic', 'synthetic-narrative-plan', 'y'),
];

describe('countBuildMemoItems — reads only the latitude / ambiguity / rule sections', () => {
  it('counts the rows of the Deliver summary\'s two sub-tables, and nothing else in the file', () => {
    const c = countBuildMemoItems(deliverSummary(DELIVER_LAT, DELIVER_AMB));
    expect(c.latitude).toBe(4);
    expect(c.ambiguity).toBe(1);
    expect(c.total).toBe(5); // the Modules table is not a memo section
    expect(c.sections).toEqual(['latitude', 'ambiguity']);
  });

  it('`None.` under a heading is zero — the skills write it rather than drop the heading', () => {
    const c = countBuildMemoItems(deliverSummary([], []));
    expect(c.total).toBe(0);
    expect(c.sections).toEqual(['latitude', 'ambiguity']);
  });

  it('counts the Learn memo\'s ## sections and stops at the next ## heading', () => {
    const c = countBuildMemoItems(learnMemo(LEARN_LAT, []));
    // The framework-gap bullet under the NEXT section must not be counted.
    expect(c).toMatchObject({ latitude: 1, ambiguity: 0, total: 1 });
  });

  it('counts Phase 4 verification rules as their own kind', () => {
    const c = countBuildMemoItems(
      oppSetup(
        [
          '| "One visit per household per month" | Targeting §9 | Not configurable on Connect — applied in CCZ: Household visit / visit_month | Deliver summary |',
          '| "Visit lasts at least 20 minutes" | Deliver §8 | Connect deliver_unit_checks.duration_minutes | 20 persisted |',
        ],
        [],
        [],
      ),
    );
    expect(c['verification-rule']).toBe(2);
    expect(c.total).toBe(2);
  });

  it('a placeholder row whose every cell is none-like is not an item', () => {
    expect(countSectionItems([LAT_HEADER, '|---|---|---|', '| — | None. | — |'])).toBe(0);
    expect(countSectionItems([LAT_HEADER, '|---|---|---|'])).toBe(0);
  });

  it('a table with no separator row does not count its header as an item', () => {
    expect(countSectionItems([LAT_HEADER, '| §4 | one screen per step | reason |'])).toBe(1);
    expect(countSectionItems([LAT_HEADER])).toBe(0);
  });

  it('counts top-level bullets, not their sub-bullets, and not a "- None." bullet', () => {
    expect(countSectionItems(['- §4: one screen per step', '  - because the PDD fixes steps', '- §5: method first'])).toBe(2);
    expect(countSectionItems(['- None.'])).toBe(0);
  });

  it('unstructured prose that is not "None." counts as at least one item, never zero', () => {
    expect(countSectionItems(['The build chose one screen per transfer step (Deliver §4).'])).toBe(1);
    for (const none of ['None.', 'None — every value was read from the PDD.', 'N/A', 'No latitudes taken.', '—']) {
      expect(countSectionItems([none]), none).toBe(0);
    }
  });

  it('a memo read back as text/plain after the Docs markdown importer (no # markers) is still seen', () => {
    // The importer turns headings into styled paragraphs and tables into cell
    // lines; a parser that required `#` would find no section and pass.
    const plain = [
      'Build memo',
      '[ACE] latitudes taken',
      'PDD §\tWhat ACE chose\tWhy',
      'Deliver §4\tOne screen per step\tPDD fixes steps',
      '[FIXED] ambiguities hit',
      'None.',
    ].join('\n');
    const c = countBuildMemoItems(plain);
    expect(c.latitude).toBeGreaterThan(0);
    expect(c.ambiguity).toBe(0);
  });

  it('the REAL 20260908-0510 Deliver memo (Docs-imported, read back as text/plain) — 4 latitudes', () => {
    // Verbatim excerpt of 3-commcare/pdd-to-deliver-app_summary.md from
    // poverty-graduation/20260908-0510, as `drive_read_file` returns it. The
    // importer stripped every `#`, so the section is a bare title line; the
    // numbered list after it belongs to a SIBLING section and must not count.
    const real = [
      'This matters because the skill\'s fallback key is concat(username, encounter_date), which it admits collapses when one worker serves many households — precisely this programme\'s shape. The stale line was forcing a worse payment key than the design specifies.',
      '[ACE] latitudes taken',
      '* Screen shape. The ten indicators are split across four screens by shared rule — zone alone; the four 7-day recall items together; electricity alone because its recall period is 30 days and that is the trap; the three ownership items together. Not one wall.',
      '* Transfer-method capture. C6 § 12 Q1 asks whether one flow can serve every method or whether method is a build variant. Built as one flow that reads the method off the household case and relevance-gates three artifact branches. An assumption, not a resolution.',
      '* Derived-chain guards (ace#1823). Every derived node is guarded on the visit having happened, so a refused or vacant visit cannot mint a phantom household-size band. Each case write preserves the stored value rather than blanking it.',
      '* Asset menu. Shipped as a menu because C5 § 3 makes it a per-deployment choice.',
      'Open, and not resolved here',
      '1. OQ-1, the targeting seam — one Connect opportunity or two, and whether the household case carries across. Can still change the declared archetype.',
      '2. OQ-0, the model specification — this build turns on every component with a PDD, the rule stated to Sophie on 5 Sep.',
    ].join('\n');
    const c = countBuildMemoItems(real);
    expect(c).toMatchObject({ latitude: 4, ambiguity: 0, total: 4, sections: ['latitude'] });

    // …and against the run's own register (66 rows, none from 3-commcare) it FAILS.
    const r = checkBuildPhaseDecisions({
      phase: 'commcare',
      memos: { [DELIVER]: real, [LEARN]: null },
      decisionsYaml: decisionsYaml(REGISTER_0510),
    })!;
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.producer)).toEqual(['pdd-to-deliver-app']);
  });

  it('a bare-title section that says None. stops there, even with prose after it', () => {
    const c = countBuildMemoItems('[FIXED] ambiguities hit\nNone.\nThe release was verified against the CCZ.\n');
    expect(c.ambiguity).toBe(0);
  });

  it('a prose line that merely mentions a section title does not open a section', () => {
    const c = countBuildMemoItems(
      'See the [ACE] latitudes taken table in the programme memo, which lists every choice the build made.\n',
    );
    expect(c.sections).toEqual([]);
  });
});

describe('checkBuildPhaseDecisions — the Phase 3 fence', () => {
  it('POSITIVE CONTROL: the 20260908-0510 shape (memos list calls, 0 app-build rows) FAILS', () => {
    const r = checkBuildPhaseDecisions({
      phase: 'commcare',
      memos: {
        [DELIVER]: deliverSummary(DELIVER_LAT, DELIVER_AMB),
        [LEARN]: learnMemo(LEARN_LAT, []),
      },
      decisionsYaml: decisionsYaml(REGISTER_0510),
    })!;
    expect(r.ok).toBe(false);
    expect(r.decision_phase).toBe('3-commcare');
    expect(r.failures.map((f) => f.producer).sort()).toEqual(['pdd-to-deliver-app', 'pdd-to-learn-app']);
    expect(r.summary).toMatch(/^FAIL — /);
    expect(r.summary).toContain('4 [ACE] latitudes, 1 [FIXED] ambiguity');
  });

  it('NEGATIVE: each producer with memo items wrote rows under its own skill → passes', () => {
    const r = checkBuildPhaseDecisions({
      phase: 'commcare',
      memos: {
        [DELIVER]: deliverSummary(DELIVER_LAT, DELIVER_AMB),
        [LEARN]: learnMemo(LEARN_LAT, []),
      },
      decisionsYaml: decisionsYaml([
        ...REGISTER_0510,
        ...many(5, '3-commcare', 'pdd-to-deliver-app', 'deliver'),
        ...many(1, '3-commcare', 'pdd-to-learn-app', 'learn'),
      ]),
    })!;
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.producers.map((p) => p.verdict)).toEqual(['ok', 'ok']);
  });

  it('NEGATIVE: memos say "None." and zero rows → passes (no-items owes nothing)', () => {
    const r = checkBuildPhaseDecisions({
      phase: 'commcare',
      memos: { [DELIVER]: deliverSummary([], []), [LEARN]: learnMemo([], []) },
      decisionsYaml: decisionsYaml(REGISTER_0510),
    })!;
    expect(r.ok).toBe(true);
    expect(r.producers.map((p) => p.verdict)).toEqual(['no-items', 'no-items']);
  });

  it('per PRODUCER: Deliver logged, Learn listed a latitude and logged nothing → FAILS on Learn only', () => {
    const r = checkBuildPhaseDecisions({
      phase: 'commcare',
      memos: {
        [DELIVER]: deliverSummary(DELIVER_LAT, DELIVER_AMB),
        [LEARN]: learnMemo(LEARN_LAT, []),
      },
      decisionsYaml: decisionsYaml(many(5, '3-commcare', 'pdd-to-deliver-app', 'deliver')),
    })!;
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.producer)).toEqual(['pdd-to-learn-app']);
  });

  it('app-test-cases rows tagged 3-commcare do NOT stand in for a silent build', () => {
    // Step 2.6 of agents/commcare-setup.md writes these from the same phase —
    // a phase-level zero-row count would have passed this build.
    const r = checkBuildPhaseDecisions({
      phase: 'commcare',
      memos: { [DELIVER]: deliverSummary(DELIVER_LAT, []), [LEARN]: learnMemo([], []) },
      decisionsYaml: decisionsYaml([
        { id: 'test-scenario-count', phase: '3-commcare', skill: 'app-test-cases' },
        { id: 'test-archetype-coverage', phase: '3-commcare', skill: 'app-test-cases' },
      ]),
    })!;
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.producer)).toEqual(['pdd-to-deliver-app']);
  });

  it('a producer row under another phase tag does not count', () => {
    const r = checkBuildPhaseDecisions({
      phase: 'commcare',
      memos: { [DELIVER]: deliverSummary(DELIVER_LAT, []), [LEARN]: learnMemo([], []) },
      decisionsYaml: decisionsYaml([{ id: 'x', phase: '1-design', skill: 'pdd-to-deliver-app' }]),
    })!;
    expect(r.ok).toBe(false);
  });

  it('fewer rows than memo items passes with a warning — the gate is the zero', () => {
    const r = checkBuildPhaseDecisions({
      phase: 'commcare',
      memos: { [DELIVER]: deliverSummary(DELIVER_LAT, DELIVER_AMB), [LEARN]: learnMemo([], []) },
      decisionsYaml: decisionsYaml(many(2, '3-commcare', 'pdd-to-deliver-app', 'deliver')),
    })!;
    expect(r.ok).toBe(true);
    expect(r.producers[1].verdict).toBe('short');
    expect(r.warnings.join(' ')).toContain('only 2 decision row(s)');
  });

  it('an absent memo file is not this check\'s failure — verify_phase_artifacts.missing owns it', () => {
    const r = checkBuildPhaseDecisions({
      phase: 'commcare',
      memos: { [DELIVER]: null, [LEARN]: null },
      decisionsYaml: null,
    })!;
    expect(r.ok).toBe(true);
    expect(r.producers.map((p) => p.verdict)).toEqual(['memo-absent', 'memo-absent']);
  });

  it('no decisions.yaml at all, or one that does not parse, is zero rows — and says why', () => {
    const memos = { [DELIVER]: deliverSummary(DELIVER_LAT, []), [LEARN]: learnMemo([], []) };
    const absent = checkBuildPhaseDecisions({ phase: 'commcare', memos, decisionsYaml: null })!;
    expect(absent.ok).toBe(false);
    expect(absent.warnings).toContain('decisions.yaml is not in the run folder');
    const broken = checkBuildPhaseDecisions({ phase: 'commcare', memos, decisionsYaml: 'decisions: [\n  - {' })!;
    expect(broken.ok).toBe(false);
    expect(broken.warnings.join(' ')).toMatch(/did not parse/);
  });

  it('refuses a phase with no build-memo contract rather than reporting a pass for it', () => {
    expect(() => checkBuildPhaseDecisions({ phase: 'design', memos: {}, decisionsYaml: null })).toThrow(
      /no build-memo contract/,
    );
    expect(unreadableBuildPhaseDecisions('ocs', 'x')).toBeNull();
  });
});

describe('checkBuildPhaseDecisions — the Phase 4 fence', () => {
  const rules = ['| "One visit per household" | Targeting §9 | Not configurable on Connect — not applied anywhere in this build | ace#1013 |'];

  it('verification rules listed + 0 connect-opp-setup rows FAILS', () => {
    const r = checkBuildPhaseDecisions({
      phase: 'connect',
      memos: { [OPP]: oppSetup(rules, [], []) },
      decisionsYaml: decisionsYaml(many(45, '1-design', 'idea-to-pdd', 'd')),
    })!;
    expect(r.ok).toBe(false);
    expect(r.decision_phase).toBe('4-connect');
    expect(r.summary).toContain('1 verification rule');
  });

  it('passes once connect-opp-setup has rows in 4-connect', () => {
    const r = checkBuildPhaseDecisions({
      phase: 'connect',
      memos: { [OPP]: oppSetup(rules, [], []) },
      decisionsYaml: decisionsYaml([{ id: 'connect-rule-one-visit-per-household', phase: '4-connect', skill: 'connect-opp-setup' }]),
    })!;
    expect(r.ok).toBe(true);
  });
});

describe('the contract table stays on the paths the manifest and the composer use', () => {
  for (const [phase, contract] of Object.entries(BUILD_PHASE_DECISION_CONTRACTS)) {
    it(`${phase}: the decision phase tag is the phase's run-folder name`, () => {
      expect(contract!.decisionPhaseTag).toBe(resolvePhaseFolderName(contract!.phase));
    });
    for (const { producer, path } of contract!.sources) {
      it(`${phase}: ${path} is a manifest artifact of ${producer} in that phase`, () => {
        const e = ARTIFACT_MANIFEST.find((a) => a.path === path);
        expect(e, `no manifest entry for ${path}`).toBeDefined();
        expect(e!.producedBy).toBe(producer);
        expect(e!.phase).toBe(contract!.phase);
        // skills/build-memo composes the programme memo from these same files.
        expect(e!.consumedBy ?? []).toContain('build-memo');
      });
    }
  }
});

describe('decisionRowsFromYaml', () => {
  it('reads the persisted `decisions:` list, tolerating a BOM from a Doc export', () => {
    const { rows } = decisionRowsFromYaml('﻿' + decisionsYaml(many(2, '3-commcare', 'pdd-to-learn-app', 'l')));
    expect(rows).toHaveLength(2);
  });
  it('a `rows:` top-level key (the atom ARGUMENT, not the file shape — ace#782) is not a log', () => {
    expect(decisionRowsFromYaml('rows: []\n').note).toMatch(/no top-level `decisions:`/);
  });
});

describe('verifyBuildPhaseDecisions — the Drive walk the atom runs', () => {
  const FOLDER = 'application/vnd.google-apps.folder';
  const DOC = 'application/vnd.google-apps.document';

  function fakeDrive(
    folders: Record<string, Array<{ id: string; name: string; mimeType: string }>>,
    texts: Record<string, string>,
  ): DriveReadAdapter {
    return {
      async listFolder(id) {
        return folders[id] ?? [];
      },
      async readText(id) {
        if (!(id in texts)) throw new Error(`unexpected read of ${id}`);
        return texts[id];
      },
    };
  }

  it('finds the memo Docs (with or without the .md suffix) and decisions.yaml — not decisions.gdoc', async () => {
    const drive = fakeDrive(
      {
        run: [
          { id: 'f3', name: '3-commcare', mimeType: FOLDER },
          { id: 'dy', name: 'decisions.yaml', mimeType: DOC },
          { id: 'dg', name: 'decisions.gdoc', mimeType: DOC },
        ],
        f3: [
          { id: 'ds', name: 'pdd-to-deliver-app_summary.md', mimeType: DOC },
          { id: 'lm', name: 'pdd-to-learn-app_build-memo', mimeType: DOC },
        ],
      },
      {
        ds: deliverSummary(DELIVER_LAT, DELIVER_AMB),
        lm: learnMemo(LEARN_LAT, []),
        dy: decisionsYaml(REGISTER_0510),
      },
    );
    const r = (await verifyBuildPhaseDecisions(drive, 'run', 'commcare'))!;
    expect(r.ok).toBe(false);
    expect(r.producers.map((p) => [p.producer, p.verdict])).toEqual([
      ['pdd-to-learn-app', 'silent'],
      ['pdd-to-deliver-app', 'silent'],
    ]);
  });

  it('a phase folder that does not exist yet reads as absent memos, not a failure', async () => {
    const r = (await verifyBuildPhaseDecisions(fakeDrive({ run: [] }, {}), 'run', 'commcare'))!;
    expect(r.ok).toBe(true);
  });

  it('is null for a phase without a contract, and never touches Drive for it', async () => {
    const drive = fakeDrive({}, {});
    expect(await verifyBuildPhaseDecisions(drive, 'run', 'design')).toBeNull();
  });

  it('a check that could not read its inputs does not pass', () => {
    const r = unreadableBuildPhaseDecisions('commcare', 'HTTP 503')!;
    expect(r.ok).toBe(false);
    expect(r.unreadable).toBe(true);
    expect(r.summary).toContain('HTTP 503');
  });
});
