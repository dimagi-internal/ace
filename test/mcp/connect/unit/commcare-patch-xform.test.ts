/**
 * Unit tests for `commcare_patch_xform` and the `applyUserScorePatch`
 * helper that backs it.
 *
 * Background: Nova's `compile_app` emits an empty `<user_score/>` element
 * inside the Connect `<assessment>` block on every quiz form (nova-plugin#5),
 * and the ACE-side `connect: null` workaround Nova rejects (nova-plugin#6).
 * Connect's `/opportunity/init/` view 500s on apps that contain the empty
 * shape, so ACE Phase 3 cannot create an opportunity until the shape is
 * patched to `<user_score>/data/total_score</user_score>`.
 *
 * The MCP atom posts the new XForm XML to CCHQ's
 * `apps/edit_form_attr/<app_id>/<form_unique_id>/xform/` endpoint
 * (`@login_or_digest`-protected, accepts our session-cookie auth). These
 * tests cover:
 *   1. `applyUserScorePatch` — pure-function patch logic against a real
 *      Nova-emitted quiz form fixture, idempotency, and scope-safety.
 *   2. `CommCareBackend.patchXform` — URL shape, body encoding, sha1
 *      conflict handling, generic HTTP-error surface.
 *
 * The fixture at `test/fixtures/cchq/leep-quiz-form-empty-user-score.xml`
 * is the literal `modules-0/forms-1.xml` from the LEEP Paint Learn build
 * `9f9932a3bd104129ad5b73e07e6f7bb8` (downloaded via `commcare_download_ccz`
 * 2026-05-03), so the test exercises the production gap end-to-end.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  CommCareBackend,
  XformConflictError,
  applyUserScorePatch,
  applyAssessmentRemovalPatch,
} from '../../../../mcp/connect/backends/commcare.js';

const FIXTURE_PATH = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'fixtures',
  'cchq',
  'leep-quiz-form-empty-user-score.xml',
);

function loadFixture(): string {
  return fs.readFileSync(FIXTURE_PATH, 'utf8');
}

describe('applyUserScorePatch', () => {
  it('rewrites <user_score/> inside the LEEP Learn quiz fixture', () => {
    const before = loadFixture();
    expect(before).toMatch(/<user_score\s*\/>/);
    expect(before).not.toMatch(/<user_score>\/data\/total_score<\/user_score>/);

    const { patched, xml } = applyUserScorePatch(before);

    expect(patched).toBe(true);
    expect(xml).not.toMatch(/<user_score\s*\/>/);
    expect(xml).toMatch(/<user_score>\/data\/total_score<\/user_score>/);
    // The rest of the form (bind, body, itext) must be untouched.
    expect(xml).toContain('<h:title>Quiz — Why this survey exists</h:title>');
    expect(xml).toContain('calculate="/data/total_score"'); // existing bind preserved
  });

  it('is idempotent — re-running on patched output is a no-op', () => {
    const { xml: once } = applyUserScorePatch(loadFixture());
    const { patched, xml: twice } = applyUserScorePatch(once);

    expect(patched).toBe(false);
    expect(twice).toEqual(once);
  });

  it('also rewrites the spaced shape (<user_score />)', () => {
    const xml = `<assessment xmlns="http://commcareconnect.com/data/v1/learn"><user_score /></assessment>`;
    const { patched, xml: out } = applyUserScorePatch(xml);
    expect(patched).toBe(true);
    expect(out).toContain('<user_score>/data/total_score</user_score>');
  });

  it('also rewrites the open/close-pair empty shape', () => {
    const xml = `<assessment xmlns="http://commcareconnect.com/data/v1/learn"><user_score></user_score></assessment>`;
    const { patched, xml: out } = applyUserScorePatch(xml);
    expect(patched).toBe(true);
    expect(out).toContain('<user_score>/data/total_score</user_score>');
  });

  it('does NOT touch <user_score/> elements outside an <assessment> block', () => {
    const xml = `<root><user_score/><other><user_score/></other></root>`;
    const { patched, xml: out } = applyUserScorePatch(xml);
    expect(patched).toBe(false);
    expect(out).toEqual(xml);
  });

  it('does NOT overwrite an already-populated <user_score> element', () => {
    const xml = `<assessment xmlns="http://commcareconnect.com/data/v1/learn"><user_score>/data/some_other_path</user_score></assessment>`;
    const { patched, xml: out } = applyUserScorePatch(xml);
    expect(patched).toBe(false);
    expect(out).toEqual(xml);
  });

  it('handles multiple assessment blocks in one form', () => {
    const xml = `
      <data>
        <a><assessment xmlns="http://commcareconnect.com/data/v1/learn"><user_score/></assessment></a>
        <b><assessment xmlns="http://commcareconnect.com/data/v1/learn"><user_score/></assessment></b>
      </data>
    `;
    const { patched, xml: out } = applyUserScorePatch(xml);
    expect(patched).toBe(true);
    const matches = out.match(/<user_score>\/data\/total_score<\/user_score>/g) ?? [];
    expect(matches.length).toBe(2);
  });
});

describe('applyAssessmentRemovalPatch', () => {
  it('strips the wrapper element + binds from the LEEP Learn quiz fixture', () => {
    const before = loadFixture();
    expect(before).toMatch(/<assessment\b[^>]*xmlns="http:\/\/commcareconnect\.com/);
    expect(before).toMatch(/<module_1_why_this_survey_exists_quiz_why_this_survey_exists>/);
    expect(before).toMatch(
      /<bind nodeset="\/data\/module_1_why_this_survey_exists_quiz_why_this_survey_exists"\/>/,
    );
    expect(before).toMatch(
      /<bind nodeset="\/data\/module_1_why_this_survey_exists_quiz_why_this_survey_exists\/assessment\/user_score"/,
    );

    const { patched, xml, removedWrappers } = applyAssessmentRemovalPatch(before);

    expect(patched).toBe(true);
    expect(removedWrappers).toEqual(['module_1_why_this_survey_exists_quiz_why_this_survey_exists']);

    // Wrapper element + assessment block fully gone.
    expect(xml).not.toMatch(/<assessment\b[^>]*xmlns="http:\/\/commcareconnect/);
    expect(xml).not.toMatch(/module_1_why_this_survey_exists_quiz_why_this_survey_exists/);

    // Surrounding form structure preserved.
    expect(xml).toContain('<h:title>Quiz — Why this survey exists</h:title>');
    expect(xml).toContain('<total_score/>');
    expect(xml).toContain('<bind nodeset="/data/total_score"');
    expect(xml).toContain('<meta xmlns="http://openrosa.org/jr/xforms"');
  });

  it('is idempotent — re-running on cleaned output is a no-op', () => {
    const { xml: once } = applyAssessmentRemovalPatch(loadFixture());
    const { patched, xml: twice, removedWrappers } = applyAssessmentRemovalPatch(once);

    expect(patched).toBe(false);
    expect(removedWrappers).toEqual([]);
    expect(twice).toEqual(once);
  });

  it('returns patched:false on a form with no commcareconnect markup', () => {
    const xml = `<root><a/><b><c/></b></root>`;
    const { patched, xml: out, removedWrappers } = applyAssessmentRemovalPatch(xml);
    expect(patched).toBe(false);
    expect(removedWrappers).toEqual([]);
    expect(out).toEqual(xml);
  });

  it('strips multiple wrappers in one form (multi-quiz Learn app)', () => {
    const xml = `
<data>
  <module_a_quiz>
    <assessment xmlns="http://commcareconnect.com/data/v1/learn" id="a"><user_score>/data/x</user_score></assessment>
  </module_a_quiz>
  <module_b_quiz>
    <assessment xmlns="http://commcareconnect.com/data/v1/learn" id="b"><user_score/></assessment>
  </module_b_quiz>
</data>
<bind nodeset="/data/module_a_quiz"/>
<bind nodeset="/data/module_a_quiz/assessment/user_score" calculate="/data/x"/>
<bind nodeset="/data/module_b_quiz"/>
<bind nodeset="/data/module_b_quiz/assessment/user_score" calculate="/data/y"/>
`;
    const { patched, xml: out, removedWrappers } = applyAssessmentRemovalPatch(xml);
    expect(patched).toBe(true);
    expect(removedWrappers).toEqual(['module_a_quiz', 'module_b_quiz']);
    expect(out).not.toContain('module_a_quiz');
    expect(out).not.toContain('module_b_quiz');
    expect(out).not.toContain('commcareconnect');
  });

  it('does NOT touch wrappers around non-connect content', () => {
    const xml = `
      <data>
        <my_wrapper>
          <child_field/>
          <assessment xmlns="http://example.com/some-other"><user_score/></assessment>
        </my_wrapper>
      </data>
    `;
    const { patched, xml: out, removedWrappers } = applyAssessmentRemovalPatch(xml);
    expect(patched).toBe(false);
    expect(removedWrappers).toEqual([]);
    expect(out).toEqual(xml);
  });

  it('also strips <module> wrapper on learn forms (Nova learn-form shape)', () => {
    const xml = `
      <data>
        <module_1_intro>
          <module xmlns="http://commcareconnect.com/data/v1/learn" id="module_1_intro">
            <name>Intro</name>
            <description>The intro module.</description>
            <time_estimate>300</time_estimate>
          </module>
        </module_1_intro>
      </data>
      <bind nodeset="/data/module_1_intro"/>
    `;
    const { patched, xml: out, removedWrappers } = applyAssessmentRemovalPatch(xml);
    expect(patched).toBe(true);
    expect(removedWrappers).toEqual(['module_1_intro']);
    expect(out).not.toContain('module_1_intro');
    expect(out).not.toContain('commcareconnect');
  });

  it('strips <deliver>/<task> wrappers on deliver forms', () => {
    const xml = `
<data>
  <visit_outcome>
    <deliver xmlns="http://commcareconnect.com/data/v1/deliver" id="visit_outcome">
      <unit_id>visit</unit_id>
    </deliver>
  </visit_outcome>
</data>
<bind nodeset="/data/visit_outcome"/>
`;
    const { patched, xml: out, removedWrappers } = applyAssessmentRemovalPatch(xml);
    expect(patched).toBe(true);
    expect(removedWrappers).toEqual(['visit_outcome']);
    expect(out).not.toContain('commcareconnect');
  });
});

// ── CommCareBackend.patchXform — HTTP plumbing ─────────────────────

interface FakeResponse {
  status: () => number;
  text: () => Promise<string>;
}

function fakeRequest(opts: {
  postStatus: number;
  postBody: string;
  cookieCsrf?: string;
  onPost?: (url: string, init: { data?: string; headers?: Record<string, string> }) => void;
}) {
  const calls: Array<{ method: 'get' | 'post'; url: string; init?: unknown }> = [];
  return {
    calls,
    request: {
      get: vi.fn(async (url: string) => {
        calls.push({ method: 'get', url });
        return { status: () => 200, text: async () => '', headers: () => ({}) } as FakeResponse;
      }),
      post: vi.fn(async (url: string, init: { data?: string; headers?: Record<string, string> }) => {
        calls.push({ method: 'post', url, init });
        opts.onPost?.(url, init);
        return {
          status: () => opts.postStatus,
          text: async () => opts.postBody,
          headers: () => ({}),
        } as FakeResponse;
      }),
      storageState: vi.fn(async () => ({
        cookies: opts.cookieCsrf
          ? [{ name: 'csrftoken', value: opts.cookieCsrf, domain: 'www.commcarehq.org' }]
          : [],
      })),
    },
  };
}

/**
 * Wrap a fakeRequest in a stub `PlaywrightSession` so the new
 * session-aware CommCareBackend constructor accepts it. `getContext()`
 * returns just enough of a BrowserContext for the backend's lookups
 * (a `request` plus a no-op cookies()/close() set); `invalidate()` is a
 * no-op since unit tests never trigger the retry path.
 */
function fakeSession(request: unknown) {
  return {
    getContext: async () => ({ request }),
    invalidate: async () => {},
  } as never;
}

describe('CommCareBackend.patchXform', () => {
  const baseUrl = 'https://www.commcarehq.org';
  const args = {
    domain: 'connect-ace-prod',
    app_id: '4e20ddf5beca42278c4d2c20383eb943',
    form_unique_id: '6f3d3ad3ed9d44e5b4107c0a1210dd10',
    new_xform_xml: '<h:html xmlns:h="x"><patched/></h:html>',
    sha1: 'a'.repeat(40),
  };

  // Live response shape (verified 2026-05-03 against connect-ace-prod):
  //   {"corrections": {}, "update": {"app-version": <int>}}
  const okBody = JSON.stringify({ corrections: {}, update: { 'app-version': 8 } });

  it('POSTs to the correct URL with form-encoded xform + sha1 + csrf', async () => {
    let capturedUrl = '';
    let capturedInit: { data?: string; headers?: Record<string, string> } | undefined;
    const fake = fakeRequest({
      postStatus: 200,
      postBody: okBody,
      cookieCsrf: 'tok123',
      onPost: (url, init) => {
        capturedUrl = url;
        capturedInit = init;
      },
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    const out = await backend.patchXform(args);

    expect(capturedUrl).toBe(
      `${baseUrl}/a/${args.domain}/apps/edit_form_attr/${args.app_id}/${args.form_unique_id}/xform/`,
    );
    expect(capturedInit?.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(capturedInit?.headers?.['X-CSRFToken']).toBe('tok123');
    expect(capturedInit?.headers?.Referer).toContain(`/apps/view/${args.app_id}/`);

    // Body parses back as URLSearchParams; xml round-trips intact, and sha1 set.
    const params = new URLSearchParams(capturedInit?.data ?? '');
    expect(params.get('xform')).toBe(args.new_xform_xml);
    expect(params.get('sha1')).toBe(args.sha1);

    expect(out).toEqual({ status: 200, app_version: 8 });
  });

  it('omits sha1 from the body when caller did not pass one', async () => {
    let capturedInit: { data?: string } | undefined;
    const fake = fakeRequest({
      postStatus: 200,
      postBody: okBody,
      onPost: (_url, init) => {
        capturedInit = init;
      },
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });

    const { sha1, ...noSha } = args;
    void sha1; // intentionally unused
    await backend.patchXform(noSha);

    const params = new URLSearchParams(capturedInit?.data ?? '');
    expect(params.has('sha1')).toBe(false);
    expect(params.get('xform')).toBe(args.new_xform_xml);
  });

  it('GETs the apps/view/<app_id>/ refresh page before the POST (csrf+cookie warm)', async () => {
    const fake = fakeRequest({
      postStatus: 200,
      postBody: okBody,
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    await backend.patchXform(args);
    expect(fake.calls[0]).toEqual({
      method: 'get',
      url: `${baseUrl}/a/${args.domain}/apps/view/${args.app_id}/`,
    });
    expect(fake.calls[1].method).toBe('post');
  });

  it('surfaces non-empty corrections from the response body', async () => {
    const fake = fakeRequest({
      postStatus: 200,
      postBody: JSON.stringify({
        corrections: { 'my-form': 'normalized whitespace' },
        update: { 'app-version': 9 },
      }),
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    const out = await backend.patchXform(args);
    expect(out.corrections).toEqual({ 'my-form': 'normalized whitespace' });
    expect(out.app_version).toBe(9);
  });

  it('throws XformConflictError on 409 with a JSON body that includes the live sha1 (when caller passed sha1)', async () => {
    const fake = fakeRequest({
      postStatus: 409,
      postBody: JSON.stringify({ message: 'sha1 mismatch', sha1: 'c'.repeat(40) }),
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    await expect(backend.patchXform(args)).rejects.toMatchObject({
      name: 'XformConflictError',
      liveSha1: 'c'.repeat(40),
      attemptedSha1: 'a'.repeat(40),
    });
  });

  it('does NOT classify 409 as conflict when caller did not pass sha1 (server-side conflict not actionable)', async () => {
    const fake = fakeRequest({
      postStatus: 409,
      postBody: JSON.stringify({ message: 'whatever', sha1: 'c'.repeat(40) }),
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    const { sha1, ...noSha } = args;
    void sha1;
    await expect(backend.patchXform(noSha)).rejects.toThrow(/returned 409/);
  });

  it('throws a generic Error on non-200 / non-409 status', async () => {
    const fake = fakeRequest({
      postStatus: 500,
      postBody: '<html>Internal Server Error</html>',
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    await expect(backend.patchXform(args)).rejects.toThrow(/returned 500/);
  });

  it('throws when 200 returns a non-JSON body (endpoint contract change)', async () => {
    const fake = fakeRequest({
      postStatus: 200,
      postBody: '<html>OK?</html>',
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    await expect(backend.patchXform(args)).rejects.toThrow(/not JSON/);
  });

  it('throws when 200 JSON body has no update.app-version (incomplete CCHQ response)', async () => {
    const fake = fakeRequest({
      postStatus: 200,
      postBody: JSON.stringify({ corrections: {} }),
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    await expect(backend.patchXform(args)).rejects.toThrow(/no update.app-version/);
  });

  it('end-to-end: feed the real LEEP fixture, post the patched output, get app-version back', async () => {
    const before = loadFixture();
    const { xml: patchedXml, patched } = applyUserScorePatch(before);
    expect(patched).toBe(true);

    let bodyXform = '';
    const fake = fakeRequest({
      postStatus: 200,
      postBody: okBody,
      onPost: (_url, init) => {
        bodyXform = new URLSearchParams(init.data ?? '').get('xform') ?? '';
      },
    });
    const backend = new CommCareBackend({ baseUrl, session: fakeSession(fake.request) });
    const out = await backend.patchXform({ ...args, new_xform_xml: patchedXml });

    expect(out.app_version).toBe(8);
    expect(bodyXform).toContain('<user_score>/data/total_score</user_score>');
    expect(bodyXform).not.toMatch(/<user_score\s*\/>/);
  });
});
