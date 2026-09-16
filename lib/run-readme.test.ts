import { describe, it, expect } from 'vitest';
import { generateRunReadme, lloHandoverFromRunState } from './run-readme.js';
import { ARTIFACT_MANIFEST } from './artifact-manifest.js';

describe('generateRunReadme', () => {
  it('header includes the runId', () => {
    const md = generateRunReadme('20260503-2128');
    expect(md).toContain('# Run 20260503-2128');
  });

  it('includes a row for each non-opp-level non-dated manifest entry', () => {
    const md = generateRunReadme('20260503-2128');
    const oppLevel = new Set([
      'inputs/',
      'opp.yaml',
      'open-questions.md',
      'eval-calibration/known-issues.md',
    ]);
    const expectedRows = ARTIFACT_MANIFEST.filter(
      (a) => !oppLevel.has(a.path) && !a.path.includes('YYYY-MM-DD'),
    );
    // Each manifest entry should produce one table row containing its
    // producing-skill name.
    for (const a of expectedRows) {
      // Construct the filename portion (everything past the phase folder)
      const segs = a.path.split('/');
      const filename = segs.slice(1).join('/');
      // Producing skill should appear in the body; the row includes
      // both the filename and the skill name.
      expect(md).toContain(filename);
      expect(md).toContain(a.producedBy);
    }
    // Row count: count `|` row separators in the table body.
    const tableBodyLines = md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Phase '));
    // First two `|` lines are the header divider; remaining are data rows.
    // Header row "| Phase | Artifact | ..." was excluded above; the
    // divider line `|---|---|---|---|` starts with `|` but not `| ` — also
    // excluded. So tableBodyLines should equal expectedRows.length.
    expect(tableBodyLines.length).toBe(expectedRows.length);
  });

  it('phase folders appear in numeric order (1-design before 3-commcare, etc)', () => {
    const md = generateRunReadme('20260503-2128');
    const idx1Design = md.indexOf('| 1-design |');
    const idx2Commcare = md.indexOf('| 3-commcare |');
    const idx3Connect = md.indexOf('| 4-connect |');
    const idx4Ocs = md.indexOf('| 5-ocs |');
    const idx5Qa = md.indexOf('| 6-qa-and-training |');
    const idx6Synthetic = md.indexOf('| 7-synthetic |');
    const idx7Solicitation = md.indexOf('| 8-solicitation-management |');
    const idx8Execution = md.indexOf('| 9-execution-manager |');
    const idx9Closeout = md.indexOf('| 10-closeout |');
    expect(idx1Design).toBeGreaterThan(0);
    expect(idx2Commcare).toBeGreaterThan(idx1Design);
    expect(idx3Connect).toBeGreaterThan(idx2Commcare);
    expect(idx4Ocs).toBeGreaterThan(idx3Connect);
    expect(idx5Qa).toBeGreaterThan(idx4Ocs);
    expect(idx6Synthetic).toBeGreaterThan(idx5Qa);
    expect(idx7Solicitation).toBeGreaterThan(idx6Synthetic);
    expect(idx8Execution).toBeGreaterThan(idx7Solicitation);
    expect(idx9Closeout).toBeGreaterThan(idx8Execution);
  });

  it('status defaults to "pending" when not provided', () => {
    const md = generateRunReadme('20260503-2128');
    // First data row should end with "| pending |" since no phase status passed
    const firstDataRow = md
      .split('\n')
      .find((l) => l.startsWith('| 1-design |'));
    expect(firstDataRow).toBeDefined();
    expect(firstDataRow!.endsWith('| pending |')).toBe(true);
  });

  it('respects specific phase status passed in', () => {
    const md = generateRunReadme('20260503-2128', {
      design: 'done',
      commcare: 'in-progress',
    });
    // 1-design rows should show done
    const designRow = md
      .split('\n')
      .find((l) => l.startsWith('| 1-design |'));
    expect(designRow).toBeDefined();
    expect(designRow!.endsWith('| done |')).toBe(true);
    // 3-commcare rows should show in-progress
    const commcareRow = md
      .split('\n')
      .find((l) => l.startsWith('| 3-commcare |'));
    expect(commcareRow).toBeDefined();
    expect(commcareRow!.endsWith('| in-progress |')).toBe(true);
    // 4-connect rows should still be pending
    const connectRow = md
      .split('\n')
      .find((l) => l.startsWith('| 4-connect |'));
    expect(connectRow).toBeDefined();
    expect(connectRow!.endsWith('| pending |')).toBe(true);
  });

  it('omits opp-level and dated artifacts', () => {
    const md = generateRunReadme('20260503-2128');
    // opp-level artifacts shouldn't be in the README (they don't live in run folder)
    expect(md).not.toContain('opp.yaml');
    expect(md).not.toContain('open-questions.md');
    expect(md).not.toContain('known-issues.md');
    // dated paths shouldn't be there either
    expect(md).not.toContain('YYYY-MM-DD');
  });
});

describe('LLO handover section', () => {
  const withLlo = (selected: unknown) => ({
    phases: { 'solicitation-management': { products: { selected_llo: selected } } },
  });

  it('is absent when the run has selected no LLO', () => {
    expect(lloHandoverFromRunState({ phases: {} })).toBeNull();
    expect(lloHandoverFromRunState(undefined)).toBeNull();
    expect(generateRunReadme('20260916-1200')).not.toContain('LLO handover');
  });

  it('treats an empty or all-null block as no handover', () => {
    // solicitation-create stubs `selected_llo` with null fields long before an
    // award; that stub must not render an empty table.
    expect(lloHandoverFromRunState(withLlo({}))).toBeNull();
    expect(lloHandoverFromRunState(withLlo({ org_slug: null, contact_email: '' }))).toBeNull();
    expect(lloHandoverFromRunState(withLlo({ email_message_ids: [] }))).toBeNull();
  });

  it('renders the fields that cannot be re-derived', () => {
    const llo = lloHandoverFromRunState(
      withLlo({
        org_slug: 'stewari',
        source: 'operator',
        contact_name: 'Sarvesh',
        contact_email: 'stewari@dimagi.com',
        program_application_id: 'b8fd7871-0000-0000-0000-000000000000',
        opportunity_url: 'https://connect.dimagi.com/a/stewari/opportunity/3f2476f7/',
        email_thread_id: '1a0a4d90d8e9dd84',
        email_message_ids: ['m1', 'm2', 'm3'],
      }),
    );
    const md = generateRunReadme('20260916-1200', {}, { lloHandover: llo });
    expect(md).toContain('## LLO handover');
    expect(md).toContain('stewari');
    expect(md).toContain('operator');
    // The unrecoverable id must be on the page, not just in run_state.yaml.
    expect(md).toContain('b8fd7871-0000-0000-0000-000000000000');
    expect(md).toContain('1a0a4d90d8e9dd84');
    expect(md).toContain('| Messages sent | 3 |');
  });

  it('omits rows it has no value for, rather than printing blanks', () => {
    const llo = lloHandoverFromRunState(withLlo({ org_slug: 'stewari' }));
    const md = generateRunReadme('20260916-1200', {}, { lloHandover: llo });
    expect(md).toContain('| Connect slug | stewari |');
    expect(md).not.toContain('| Email thread |');
    expect(md).not.toContain('| Program application |');
  });

  it('defaults an absent source to solicitation, for legacy runs', () => {
    const llo = lloHandoverFromRunState(withLlo({ org_slug: 'acme' }));
    const md = generateRunReadme('20260916-1200', {}, { lloHandover: llo });
    expect(md).toContain('| Selected via | solicitation |');
  });

  it('keeps the run-state pointer below the table', () => {
    const llo = lloHandoverFromRunState(withLlo({ org_slug: 'acme' }));
    const md = generateRunReadme('20260916-1200', {}, { lloHandover: llo });
    expect(md.indexOf('## LLO handover')).toBeLessThan(md.indexOf('**Run state:**'));
  });
});
