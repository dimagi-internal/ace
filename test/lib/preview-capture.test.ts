import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  CAPTURED_BY,
  authForUrl,
  buildCaptureIndex,
  captureFolderPath,
  cardCaption,
  connectProgramId,
  connectProgramListUrl,
  driveFileId,
  effectiveAuth,
  hqFormSummaryUrl,
  ocsPublicUrl,
  parsePreviewGaps,
  phaseFolderForGap,
  pickChatQuestion,
  programCardCaption,
  planCapture,
  previewGapsUrl,
  productNodeAt,
  screenPage,
  selectGaps,
  withLabsProgramContext,
  type PreviewGap,
} from '../../lib/preview-capture';
import { assertPreviewsIndexReadable, serializePreviewsIndex } from '../../lib/output-previews';

function gap(over: Partial<PreviewGap> = {}): PreviewGap {
  return {
    id: 'connect-setup:connect.opportunity',
    phase: 'connect-setup',
    output_key: 'connect.opportunity',
    kind: 'connect_opportunity',
    title: 'Bednet opp',
    url: 'https://connect.dimagi.com/a/ace-pm-org/opportunity/d5deee9b-e32e-4fae-81dd-a9a11d393f50/',
    file_id: null,
    reason: 'no-preview',
    auth: 'connect',
    ...over,
  };
}

describe('gap list', () => {
  it('builds the ace-web URL', () => {
    expect(previewGapsUrl('https://labs.connect.dimagi.com/ace/', 'dimagi-team', 'bednet', '20260908-1544')).toBe(
      'https://labs.connect.dimagi.com/ace/api/w/dimagi-team/opps/bednet/runs/20260908-1544/preview-gaps',
    );
    expect(() => previewGapsUrl('', 'w', 'o', 'r')).toThrow(/base/);
    expect(previewGapsUrl('https://h/ace', 'w', 'o', 'r', true)).toBe('https://h/ace/api/w/w/opps/o/runs/r/preview-gaps?refresh=true');
  });

  it('parses the documented response and fills auth from the url when absent', () => {
    const list = parsePreviewGaps({
      run_id: '20260908-1544',
      covered: 14,
      outputs: [
        { id: 'x', phase: 'ocs-setup', output_key: 'ocs_chatbot', kind: 'chatbot', title: 'Bot', url: 'https://www.openchatstudio.com/a/connect-ace/chatbots/1/', file_id: null, reason: 'no-preview' },
      ],
    });
    expect(list.covered).toBe(14);
    expect(list.outputs[0].auth).toBe('ocs');
  });

  it('refuses a response it cannot act on rather than reading it as "all covered"', () => {
    expect(() => parsePreviewGaps({ detail: 'Not found' })).toThrow(/outputs/);
    expect(() => parsePreviewGaps({ outputs: [{ kind: 'chatbot' }] })).toThrow(/phase or output_key/);
  });
});

describe('auth', () => {
  it('mirrors ace-web host rules', () => {
    expect(authForUrl('https://connect.dimagi.com/a/x/opportunity/1/')).toBe('connect');
    expect(authForUrl('https://labs.connect.dimagi.com/labs/workflow/1/run/')).toBe('labs');
    expect(authForUrl('https://www.commcarehq.org/a/d/apps/view/abc/')).toBe('hq');
    expect(authForUrl('https://www.openchatstudio.com/a/t/chatbots/1/')).toBe('ocs');
    expect(authForUrl('https://docs.google.com/document/d/abc/edit')).toBe('google');
    expect(authForUrl('https://example.org/')).toBe('public');
    expect(authForUrl('not a url')).toBe('public');
  });

  it('routes canopy pages on canopy.dimagi.com (its own host since 2026-10-05) to canopy', () => {
    // A canopy page opened with no session lands on Google sign-in; classing the new
    // host as public would photograph that sign-in page as the run's preview.
    expect(authForUrl('https://canopy.dimagi.com/w/connect/ddd/n/r')).toBe('canopy');
    expect(authForUrl('https://canopy.dimagi.com/w/connect/walkthrough/abc?t=x')).toBe('canopy');
    expect(effectiveAuth(gap({ kind: 'walkthrough', url: 'https://canopy.dimagi.com/w/connect/ddd/n/r', auth: 'public' }))).toBe('canopy');
  });

  it('routes canopy pages on the labs host to canopy, whatever the gap says', () => {
    const g = gap({ kind: 'walkthrough', url: 'https://labs.connect.dimagi.com/canopy/ddd/n/r', auth: 'labs' });
    expect(effectiveAuth(g)).toBe('canopy');
  });

  it('uses the service account for a Drive file the viewer cannot draw', () => {
    expect(effectiveAuth(gap({ reason: 'not-viewable-file', auth: 'google' }))).toBe('google');
  });
});

describe('selection', () => {
  const app = gap({ id: 'commcare-setup:apps.learn', phase: 'commcare-setup', output_key: 'apps.learn', kind: 'commcare_app' });
  const opp = gap();

  it('filters to one phase in either key space', () => {
    expect(selectGaps([app, opp], { phaseFilter: 'connect', capturedPhase: 'connect-setup' }).capture).toEqual([opp]);
    expect(selectGaps([app, opp], { phaseFilter: 'connect-setup', capturedPhase: 'connect-setup' }).capture).toEqual([opp]);
    expect(() => selectGaps([opp], { phaseFilter: 'nope', capturedPhase: 'connect-setup' })).toThrow(/unknown phase/);
  });

  it('defers an app until the Phase 6 emulator walk has had its turn', () => {
    const at3 = selectGaps([app], { phaseFilter: 'commcare-setup', capturedPhase: 'commcare-setup' });
    expect(at3.capture).toEqual([]);
    expect(at3.deferred[0].gap).toBe(app);
    expect(selectGaps([app], { capturedPhase: 'qa-and-training' }).capture).toEqual([app]);
    // the run-end sweep never defers — a run that halted at Phase 4 still gets the fallback
    expect(selectGaps([app], { capturedPhase: 'connect-setup', runEnd: true }).capture).toEqual([app]);
  });
});

describe('folders', () => {
  it('files a preview with the phase that BUILT the output', () => {
    expect(phaseFolderForGap({ phase: 'connect-setup' })).toBe('4-connect');
    expect(phaseFolderForGap({ phase: 'solicitation-management' })).toBe('8-solicitation-management');
    expect(captureFolderPath(gap({ phase: 'synthetic-data-and-workflows', output_key: 'synthetic.cascade.opp_reports.0' }))).toBe(
      '7-synthetic/previews/synthetic-cascade-opp-reports-0',
    );
    expect(() => phaseFolderForGap({ phase: 'mystery' })).toThrow(/not a known phase/);
  });
});

describe('product node', () => {
  const rs = parseYaml(`
phases:
  ocs-setup:
    products:
      ocs_chatbot: {team_slug: connect-ace, public_id: abc}
  synthetic-data-and-workflows:
    products:
      synthetic:
        cascade:
          opp_reports:
            - {url: 'https://labs.connect.dimagi.com/labs/workflow/1/run/'}
`);
  it('walks dotted keys, indexing lists by number', () => {
    expect(productNodeAt(rs, 'ocs-setup', 'ocs_chatbot')).toEqual({ team_slug: 'connect-ace', public_id: 'abc' });
    expect(productNodeAt(rs, 'synthetic-data-and-workflows', 'synthetic.cascade.opp_reports.0')?.url).toMatch(/workflow\/1/);
    expect(productNodeAt(rs, 'ocs-setup', 'nope')).toBeNull();
    expect(productNodeAt(null, 'ocs-setup', 'ocs_chatbot')).toBeNull();
  });
});

describe('url helpers', () => {
  it('opens a Connect program on its org Programs page — there is no detail route', () => {
    expect(connectProgramListUrl('https://connect.dimagi.com/a/ai-demo-space/program/9e82982e-7638-44bc-9de2-2bfcefae550d/')).toBe(
      'https://connect.dimagi.com/a/ai-demo-space/program/',
    );
    expect(connectProgramListUrl('https://connect.dimagi.com/a/x/opportunity/1/')).toBeNull();
  });

  it('points an HQ app at its form summary', () => {
    expect(hqFormSummaryUrl('https://www.commcarehq.org/a/connect-ace-prod/apps/view/cc3aaedcfa9a47729873d4915e12d226/')).toBe(
      'https://www.commcarehq.org/a/connect-ace-prod/apps/view/cc3aaedcfa9a47729873d4915e12d226/summary/',
    );
  });

  it('opens a solicitation in its own labs program context', () => {
    expect(withLabsProgramContext('https://labs.connect.dimagi.com/solicitations/22869/', { labs_program_id: 309 })).toBe(
      'https://labs.connect.dimagi.com/solicitations/22869/?program_id=309',
    );
    expect(withLabsProgramContext('https://labs.connect.dimagi.com/solicitations/1/?program_id=5', { labs_program_id: 9 })).toMatch(/program_id=5$/);
    expect(withLabsProgramContext('https://labs.connect.dimagi.com/solicitations/1/', {})).toBe('https://labs.connect.dimagi.com/solicitations/1/');
  });

  it('prefers the recorded public chat url and can build it', () => {
    expect(ocsPublicUrl({ public_url: 'https://x/start/' })).toBe('https://x/start/');
    expect(ocsPublicUrl({ team_slug: 'connect-ace', public_id: 'p1' })).toBe('https://www.openchatstudio.com/a/connect-ace/chatbots/p1/start/');
    expect(ocsPublicUrl({ admin_url: 'https://www.openchatstudio.com/a/t/chatbots/1/' })).toBeNull();
  });

  it('extracts a Drive file id', () => {
    expect(driveFileId('https://docs.google.com/presentation/d/17s_F1aoc-CcqkK3j3Ax/edit')).toBe('17s_F1aoc-CcqkK3j3Ax');
    expect(driveFileId('https://drive.google.com/open?id=1rR_GEZv6J8FGP7iUYs9')).toBe('1rR_GEZv6J8FGP7iUYs9');
    expect(driveFileId(null)).toBeNull();
  });
});

describe('shot plan', () => {
  it('photographs the opportunity overview and its verification section', () => {
    const p = planCapture(gap());
    expect(p.folder).toBe('4-connect/previews/connect-opportunity');
    expect(p.shots.map((s) => [s.step, s.mode])).toEqual([
      ['overview', 'viewport'],
      ['verification', 'scroll-to-text'],
    ]);
  });

  it('never photographs the OCS admin page for a chatbot', () => {
    const g = gap({ phase: 'ocs-setup', output_key: 'ocs_chatbot', kind: 'chatbot', url: 'https://www.openchatstudio.com/a/connect-ace/chatbots/13084/', auth: 'ocs' });
    const p = planCapture(g, { product: { team_slug: 'connect-ace', public_id: 'pub' }, chatQuestion: 'How many days between visits?' });
    expect(p.strategy).toBe('ocs-chat');
    expect(p.url).toBe('https://www.openchatstudio.com/a/connect-ace/chatbots/pub/start/');
    expect(p.question).toBe('How many days between visits?');
    expect(planCapture(g, { product: {}, chatQuestion: 'q' }).skip).toMatch(/public chat url/);
    expect(planCapture(g, { product: { public_url: 'https://x/start/' } }).skip).toMatch(/test question/);
  });

  it('finds a program by name on the Programs page', () => {
    const g = gap({ output_key: 'connect.program', kind: 'connect_program', url: 'https://connect.dimagi.com/a/org/program/abc/' });
    const p = planCapture(g, { product: { name: 'Spark FCAP' } });
    expect(p.url).toBe('https://connect.dimagi.com/a/org/program/');
    expect(p.shots[0]).toMatchObject({ mode: 'card', text: 'Spark FCAP' });
  });

  it('matches a program card by its UUID even when run_state records no name', () => {
    const url = 'https://connect.dimagi.com/a/ai-demo-space/program/9e82982e-7638-44bc-9de2-2bfcefae550d/';
    const g = gap({ output_key: 'connect.program', kind: 'connect_program', title: 'Connect program', url });
    const p = planCapture(g, { product: { id: '9e82982e-7638-44bc-9de2-2bfcefae550d', url } });
    expect(p.skip).toBeUndefined();
    expect(p.shots[0]).toMatchObject({ mode: 'card', href: '/program/9e82982e-7638-44bc-9de2-2bfcefae550d/' });
    // the gap title is ace-web's default label — never used to find the card
    expect(p.shots[0].text).toBeUndefined();
    expect(connectProgramId(url)).toBe('9e82982e-7638-44bc-9de2-2bfcefae550d');
  });

  it('captions a nameless program from its card heading, and never leaks a placeholder', () => {
    const url = 'https://connect.dimagi.com/a/ai-demo-space/program/9e82982e-7638-44bc-9de2-2bfcefae550d/';
    const p = planCapture(gap({ output_key: 'connect.program', kind: 'connect_program', title: 'Connect program', url }), { product: { id: '9e82982e-7638-44bc-9de2-2bfcefae550d' } });
    const shot = p.shots[0];
    // before the card is read: a caption that names nothing
    expect(shot.caption).toBe('Connect program — its card on the Programs page: delivery type, dates, budget and invite funnel');
    expect(shot.caption).not.toMatch(/this program/);
    // once the matched card's heading is read, it names the program
    expect(cardCaption(shot, '  Spark FCAP Facilitation — Malawi Follow-Up Study (MWK) ')).toBe(
      'Spark FCAP Facilitation — Malawi Follow-Up Study (MWK) — its card on the Programs page: delivery type, dates, budget and invite funnel',
    );
    // a blank heading keeps the name-free caption
    expect(cardCaption(shot, '')).toBe(shot.caption);
    // a recorded name wins and is not overridden by the heading
    const named = planCapture(gap({ output_key: 'connect.program', kind: 'connect_program', url }), { product: { name: 'Spark FCAP' } }).shots[0];
    expect(named.caption).toBe(programCardCaption('Spark FCAP'));
    expect(cardCaption(named, 'Something else')).toBe(named.caption);
  });

  it('clamps the program description so the card frame stays a landscape card', () => {
    const p = planCapture(gap({ output_key: 'connect.program', kind: 'connect_program', url: 'https://connect.dimagi.com/a/o/program/9e82982e-7638-44bc-9de2-2bfcefae550d/' }), { product: {} });
    expect(p.shots[0].clamp).toEqual({ selector: '.card_description', lines: 3 });
  });

  it('skips a nameless program with no id rather than shooting the first card on the page', () => {
    const g = gap({ output_key: 'connect.program', kind: 'connect_program', title: 'Connect program', url: 'https://connect.dimagi.com/a/org/program/not-a-uuid/' });
    const p = planCapture(g, { product: {} });
    expect(p.shots).toEqual([]);
    expect(p.skip).toMatch(/could not identify the program's card/);
  });

  it("uses ace-web's public_url for the chatbot and solicitation when the gap carries one", () => {
    const bot = planCapture(
      gap({ phase: 'ocs-setup', output_key: 'ocs_chatbot', kind: 'chatbot', url: 'https://www.openchatstudio.com/a/t/chatbots/1/', auth: 'ocs', public_url: 'https://www.openchatstudio.com/a/t/chatbots/pub/start/' }),
      { product: null, chatQuestion: 'q?' },
    );
    expect(bot.url).toBe('https://www.openchatstudio.com/a/t/chatbots/pub/start/');
    const sol = planCapture(
      gap({ phase: 'solicitation-management', output_key: 'solicitation', kind: 'solicitation', url: 'https://labs.connect.dimagi.com/solicitations/7/edit/', auth: 'labs', public_url: 'https://labs.connect.dimagi.com/solicitations/7/' }),
      { product: { labs_program_id: 3 } },
    );
    expect(sol.url).toBe('https://labs.connect.dimagi.com/solicitations/7/?program_id=3');
  });

  it('uses the HQ form summary for the app fallback and the SA for an undrawable file', () => {
    const app = planCapture(gap({ phase: 'commcare-setup', output_key: 'apps.learn', kind: 'commcare_app', url: 'https://www.commcarehq.org/a/d/apps/view/abc123/', auth: 'hq' }));
    expect(app.url).toMatch(/\/summary\/$/);
    expect(app.folder).toBe('3-commcare/previews/apps-learn');
    const file = planCapture(gap({ kind: 'document', reason: 'not-viewable-file', auth: 'google', file_id: 'F1', url: null }));
    expect(file.strategy).toBe('drive-file');
    expect(planCapture(gap({ kind: 'document', reason: 'not-viewable-file', auth: 'google', file_id: null, url: null })).skip).toMatch(/file id/);
  });

  it('opens a canopy package at its first walkthrough scene, not its (undecodable) video', () => {
    const p = planCapture(gap({ phase: 'synthetic-data-and-workflows', output_key: 'synthetic.walkthroughs.0', kind: 'walkthrough', url: 'https://labs.connect.dimagi.com/canopy/ddd/n/r', auth: 'labs' }));
    expect(p.auth).toBe('canopy');
    expect(p.shots.map((s) => s.mode)).toEqual(['scroll-to-text']);
  });

  it('skips an output with nothing to open, and says why', () => {
    expect(planCapture(gap({ url: null })).skip).toMatch(/no url/);
  });
});

describe('pickChatQuestion', () => {
  const doc = `# OCS Test Prompts — x
Total prompts: 3

## Prompt 1
**Category:** intervention-basics
**Question:** What is this opportunity about?
**Expected escalation:** none

## Prompt 2
**Category:** should-refuse
**Question:** Can you pay me twice?
**Expected escalation:** none

## Prompt 3
**Category:** visit-flow
**Question:** How many days after the first visit do I return?
**Expected escalation:** none
`;
  it('picks a specific, non-adversarial question', () => {
    expect(pickChatQuestion(doc)).toBe('How many days after the first visit do I return?');
  });
  it('reads a text/markdown export with escaped markers', () => {
    const escaped = doc.replace(/##/g, '\\#\\#').replace(/\*\*/g, '\\*\\*');
    expect(pickChatQuestion(escaped)).toBe('How many days after the first visit do I return?');
  });
  it('prefers the question with the SHORTEST expected answer, so the frame holds question and answer', () => {
    const two = `## Prompt 1
**Category:** payment
**Question:** How am I paid and verified?
**Expected answer summary:** The rate, the caps, all three verification layers,
the exclusions and the review sample, in detail.
**Expected escalation:** none

## Prompt 2
**Category:** visit-flow
**Question:** How many days between visits?
**Expected answer summary:** At least 3 days.
**Expected escalation:** none
`;
    expect(pickChatQuestion(two)).toBe('How many days between visits?');
  });
  it('falls back to the generic opener, and returns null on no prompts', () => {
    expect(pickChatQuestion(doc.split('## Prompt 2')[0])).toBe('What is this opportunity about?');
    expect(pickChatQuestion('')).toBeNull();
  });
});

describe('screenPage', () => {
  const ok = { status: 200, finalUrl: 'https://connect.dimagi.com/a/x/opportunity/1/', title: 'Connect', text: 'Opportunity '.repeat(40) };
  it('passes a real page', () => expect(screenPage(ok).ok).toBe(true));
  it('rejects login pages on every surface', () => {
    for (const finalUrl of [
      'https://labs.connect.dimagi.com/labs/login/?next=/x',
      'https://connect.dimagi.com/accounts/login/?next=/a/',
      'https://accounts.google.com/v3/signin/identifier?x=1',
    ]) expect(screenPage({ ...ok, finalUrl }).reason).toBe('login');
  });
  it('rejects not-found bodies served with 200 or 404', () => {
    expect(screenPage({ ...ok, status: 404, text: 'Menu Connect AC Page not found Resolver404' }).reason).toBe('not-found');
    expect(screenPage({ ...ok, text: 'Menu Marketplace Connect Labs AC Page not found Solicitation not found ' + 'x'.repeat(100) }).reason).toBe('not-found');
  });
  it('rejects maintenance, blank and still-loading pages', () => {
    expect(screenPage({ ...ok, status: 503 }).reason).toBe('maintenance');
    expect(screenPage({ ...ok, text: 'Connect' }).reason).toBe('blank');
    expect(screenPage({ ...ok, text: 'Loading report data, please wait… ' + 'x'.repeat(80) }).reason).toBe('loading');
  });
});

describe('index', () => {
  it('stamps captured_by and round-trips through the contract readback', () => {
    const g = gap();
    const idx = buildCaptureIndex(g, 'connect-setup', '2026-09-30T00:00:00Z', [
      { file_id: 'A', name: '01-overview.png', caption: 'overview' },
      { file_id: 'B', name: '02-verification.png', caption: 'verification' },
    ]);
    expect(idx.captured_by).toBe(CAPTURED_BY);
    const r = assertPreviewsIndexReadable(serializePreviewsIndex(idx), {
      folderSlug: 'connect-opportunity',
      phase: 'connect-setup',
      outputKey: 'connect.opportunity',
      capturedBy: CAPTURED_BY,
      expectedCount: 2,
    });
    expect(r.findings).toEqual([]);
  });
});
