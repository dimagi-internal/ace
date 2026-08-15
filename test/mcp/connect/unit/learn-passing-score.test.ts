import { describe, it, expect } from 'vitest';
import {
  extractFormFieldValues,
  extractDisabledFormFieldNames,
} from '../../../../mcp/connect/backends/html-scrape.js';

/**
 * `connect_set_learn_passing_score` — the repair path for the one Connect
 * field ACE exclusively owns and previously could not change after create.
 *
 * Grounded in `dimagi/commcare-connect@5f69bb3d`:
 *   - `opportunity/models.py:35`   passing_score = IntegerField(null=True) on CommCareApp
 *   - `opportunity/forms.py:499`   learn_app_passing_score = IntegerField(0..100)
 *   - `opportunity/forms.py:647`   OpportunityInitUpdateForm(OpportunityInitForm)
 *   - `opportunity/forms.py:584`   app.passing_score = cleaned_data[...]; save(update_fields=[...])
 *   - `opportunity/forms.py:727`   clean() errors if a DISABLED field appears in self.data
 *   - `program/urls.py:22`         <pk>/opportunity/<opp_id>/init/edit/
 *
 * The atom is a read-modify-write over that form. These tests pin the two
 * body-construction rules that make the write legal, because getting either
 * wrong fails in a way no downstream check catches: a rejected POST reads as
 * "couldn't repair", and a silently-dropped field reads as success.
 */

/** The init-edit form as Connect renders it BEFORE any worker has joined. */
const FORM_FRESH = `
<form method="post">
  <input type="hidden" name="csrfmiddlewaretoken" value="tok-fresh">
  <input name="name" value="Bednet Check 2-Visit">
  <input name="short_description" value="Two-visit bednet spot-check">
  <textarea name="description">Register a household, return after three days.</textarea>
  <select name="currency"><option value="USD" selected>USD</option><option value="KES">KES</option></select>
  <select name="country"><option value="">--</option><option value="USA" selected>USA</option></select>
  <select name="hq_server"><option value="1" selected>production</option></select>
  <select name="api_key"><option value="7" selected>abcd...wxyz</option></select>
  <select name="learn_app_domain"><option value="connect-ace-prod" selected>connect-ace-prod</option></select>
  <select name="learn_app"><option value="c0d7027316bc46f8b4fdf4b47fd8d90b" selected>Learn app</option></select>
  <input name="learn_app_passing_score" value="100" min="0" max="100" required>
  <textarea name="learn_app_description">Bednet Check 2-Visit Learn app</textarea>
  <select name="deliver_app_domain"><option value="connect-ace-prod" selected>connect-ace-prod</option></select>
  <select name="deliver_app"><option value="2785f6a666a84d4b8a4e91f728d64dc5" selected>Deliver app</option></select>
</form>`;

/**
 * The SAME form after Connect Workers have joined. Django renders the six
 * app/credential fields `disabled`, and `OpportunityInitUpdateForm.clean()`
 * raises "This field cannot be edited after Connect Workers have joined the
 * opportunity." for any of them found in the POST body.
 *
 * `passing_score` is deliberately NOT in that set — the form's own hint text
 * says so: "Learn and Deliver apps and the API key cannot be changed after
 * Connect Workers have joined. You can still edit the learn app description
 * and passing score."
 */
const FORM_WORKERS_JOINED = FORM_FRESH
  .replace('<select name="hq_server">', '<select name="hq_server" disabled>')
  .replace('<select name="api_key">', '<select name="api_key" disabled>')
  .replace('<select name="learn_app_domain">', '<select name="learn_app_domain" disabled>')
  .replace('<select name="learn_app">', '<select name="learn_app" disabled="disabled">')
  .replace('<select name="deliver_app_domain">', '<select name="deliver_app_domain" disabled="">')
  .replace('<select name="deliver_app">', '<select name="deliver_app" disabled>');

const LOCKED_AFTER_JOIN = [
  'hq_server', 'api_key',
  'learn_app_domain', 'learn_app',
  'deliver_app_domain', 'deliver_app',
];

/** Mirrors the atom's body construction (playwright.ts setLearnPassingScore). */
function buildPostBody(html: string, passingScore: number): Record<string, string> {
  const current = extractFormFieldValues(html);
  const disabled = extractDisabledFormFieldNames(html);
  const form: Record<string, string> = { csrfmiddlewaretoken: 'tok' };
  for (const [name, value] of Object.entries(current)) {
    if (name === 'csrfmiddlewaretoken') continue;
    if (disabled.has(name)) continue;
    form[name] = value;
  }
  form['learn_app_passing_score'] = String(passingScore);
  return form;
}

describe('extractDisabledFormFieldNames', () => {
  it('finds nothing on a form with no disabled controls', () => {
    expect(extractDisabledFormFieldNames(FORM_FRESH).size).toBe(0);
  });

  it('finds every disabled control regardless of attribute spelling', () => {
    // Connect/Django emit all three shapes; a browser treats them identically.
    const disabled = extractDisabledFormFieldNames(FORM_WORKERS_JOINED);
    expect([...disabled].sort()).toEqual([...LOCKED_AFTER_JOIN].sort());
  });

  it('does NOT mistake a name containing "disabled" for the attribute', () => {
    const html = '<input name="data-loading-disabled-flag" value="1">';
    expect(extractDisabledFormFieldNames(html).size).toBe(0);
  });
});

describe('connect_set_learn_passing_score — POST body construction', () => {
  it('is a FULL-form re-post, not a partial patch', () => {
    // The init-edit form is the whole init form. Posting only the one field
    // fails validation on every other required field, so the repair has to
    // carry back everything the GET rendered.
    const body = buildPostBody(FORM_FRESH, 80);
    for (const required of ['name', 'short_description', 'description', 'currency', 'country']) {
      expect(body[required], `${required} must be carried back`).toBeTruthy();
    }
    expect(body['learn_app']).toBe('c0d7027316bc46f8b4fdf4b47fd8d90b');
    expect(body['deliver_app']).toBe('2785f6a666a84d4b8a4e91f728d64dc5');
  });

  it('changes exactly one value and leaves every sibling byte-identical', () => {
    const before = buildPostBody(FORM_FRESH, 100);   // current value
    const after = buildPostBody(FORM_FRESH, 80);     // repaired value
    const changed = Object.keys({ ...before, ...after })
      .filter((k) => before[k] !== after[k]);
    expect(changed).toEqual(['learn_app_passing_score']);
    expect(after['learn_app_passing_score']).toBe('80');
  });

  it('omits every disabled field once workers have joined', () => {
    // The whole point: a naive read-modify-write is correct on a fresh opp and
    // REJECTED the moment a worker joins, because clean() errors on any
    // disabled field present in self.data.
    const body = buildPostBody(FORM_WORKERS_JOINED, 90);
    for (const locked of LOCKED_AFTER_JOIN) {
      expect(body, `${locked} must be omitted after workers join`).not.toHaveProperty(locked);
    }
  });

  it('still sets passing_score after workers have joined', () => {
    // Connect's own hint text promises this stays editable in the locked state.
    // If this ever regresses, the repair path is gone precisely when it matters
    // most — a live opportunity with workers on it.
    const body = buildPostBody(FORM_WORKERS_JOINED, 90);
    expect(body['learn_app_passing_score']).toBe('90');
    expect(body['learn_app_description']).toBe('Bednet Check 2-Visit Learn app');
  });

  it('reads the previous value off the form so a change is never silent', () => {
    // CommCareApp is keyed (cc_app_id, cc_domain, organization, hq_server) —
    // not by opportunity — so this score is shared by every opp in the org
    // wired to the same HQ Learn app. Surfacing the prior value is what makes
    // "you just moved someone else's gate" visible.
    const current = extractFormFieldValues(FORM_FRESH);
    expect(Number(current['learn_app_passing_score'])).toBe(100);
  });
});

describe('the gate arithmetic this atom exists to protect', () => {
  // A six-item bank scored as a percentage can only land on these values, so
  // 80 and 100 differ by exactly ONE outcome: 5-of-6. Any threshold in 84..100
  // behaves identically; any in 67..83 admits a worker who missed a rule.
  const reachable = [0, 1, 2, 3, 4, 5, 6].map((n) => Math.floor((n * 100) / 6));

  it('cannot distinguish 80 from 100 on five of the seven outcomes', () => {
    const differing = reachable.filter((s) => (s >= 80) !== (s >= 100));
    expect(reachable).toEqual([0, 16, 33, 50, 66, 83, 100]);
    expect(differing).toEqual([83]);   // 5-of-6, and only 5-of-6
  });
});

// ─────────────────────────────────────────────────────────────────────
// connect_get_learn_passing_score — the READ half (ace#1449)
// ─────────────────────────────────────────────────────────────────────

/**
 * Why a read atom exists at all.
 *
 * `passing_score` is the one value in the whole Connect wiring whose being
 * wrong is completely SILENT: the app still builds, the worker still answers
 * the quiz, the form still submits — only the Deliver gate differs. And
 * `connect_create_opportunity`'s posted value is DISCARDED for an existing
 * `CommCareApp` row (`get_or_create(..., update_existing=False)`) with no
 * error raised. So without a read there is no way to tell "posted and stored"
 * from "posted and dropped".
 *
 * There is no REST path: commcare-connect's PR #1135 automation API is
 * POST-only, with no `GET /api/opportunities/{id}/` endpoint at all. And
 * `connect_get_opportunity` cannot answer it either — it hydrates from
 * `/a/<org>/opportunity/<id>/edit` plus the read-only detail page, and
 * `learn_app_passing_score` is rendered on NEITHER. It lives only on the
 * program-scoped init-edit form.
 *
 * Live motivation: `bednet-check-2-visit/20260814-2019` posted a
 * PDD-pinned gate of 100 and could not verify it, because the only code that
 * read the field lived inside the WRITE atom — and the write was failing for
 * an unrelated reason (`hq_server: This field is required`). A broken repair
 * path took the read down with it.
 */
import { PlaywrightBackend } from '../../../../mcp/connect/backends/playwright.js';

/** Minimal APIRequestContext stub: records GETs, replays canned HTML. */
function stubRequest(html: string, status = 200) {
  const gets: string[] = [];
  return {
    gets,
    ctx: {
      get: async (path: string) => {
        gets.push(path);
        return { status: () => status, text: async () => html };
      },
    } as never,
  };
}

function backendFor(html: string, status = 200) {
  const { gets, ctx } = stubRequest(html, status);
  const backend = new PlaywrightBackend({
    baseUrl: 'https://connect.dimagi.com',
    csrfToken: 'tok',
    request: ctx,
  });
  return { backend, gets };
}

const ARGS = {
  organization_slug: 'ai-demo-space',
  program_id: 'efb8af66-fbfd-488f-bf99-66f864cea68b',
  opportunity_id: '94d2c7ec-bd5b-4acc-983e-3e8aebf5416c',
};

describe('connect_get_learn_passing_score', () => {
  it('reads the score off the program-scoped init-edit form', async () => {
    const { backend, gets } = backendFor(FORM_FRESH);
    const out = await backend.getLearnPassingScore(ARGS);

    expect(out.passing_score).toBe(100);
    expect(out.rendered).toBe('100');
    expect(out.opportunity_id).toBe(ARGS.opportunity_id);
    expect(gets).toEqual([
      `/a/${ARGS.organization_slug}/program/${ARGS.program_id}` +
      `/opportunity/${ARGS.opportunity_id}/init/edit/`,
    ]);
  });

  it('does NOT read the opportunity edit form or detail page', async () => {
    // Those are the two pages `getOpportunity` scrapes, and the field is
    // rendered on neither — which is the whole reason this atom exists.
    const { backend, gets } = backendFor(FORM_FRESH);
    await backend.getLearnPassingScore(ARGS);

    expect(gets.join()).not.toContain(`/opportunity/${ARGS.opportunity_id}/edit`);
    expect(gets.join()).toContain('/program/');
  });

  it('hits the SAME page the setter writes to', async () => {
    // Pins the shared `learnPassingScoreEditPath` helper. If these ever
    // diverge, the read verifies a page the write does not touch — which
    // would report a stale gate as a confirmed one.
    const read = backendFor(FORM_FRESH);
    await read.backend.getLearnPassingScore(ARGS);

    const write = backendFor(FORM_FRESH);
    await write.backend
      .setLearnPassingScore({ ...ARGS, passing_score: 100 })
      .catch(() => { /* POST is unstubbed; we only care about the first GET */ });

    expect(write.gets[0]).toBe(read.gets[0]);
  });

  it('reports an EMPTY input as null, never as 0', async () => {
    // 0 would mean "every worker passes" — the exact opposite of an
    // unconfigured gate. Coercing '' to 0 would turn "I do not know" into
    // the most permissive possible answer.
    const { backend } = backendFor(
      FORM_FRESH.replace('name="learn_app_passing_score" value="100"',
                         'name="learn_app_passing_score" value=""'),
    );
    const out = await backend.getLearnPassingScore(ARGS);

    expect(out.passing_score).toBeNull();
    expect(out.rendered).toBe('');
  });

  it('distinguishes a real 0 from an unset field', async () => {
    const { backend } = backendFor(
      FORM_FRESH.replace('name="learn_app_passing_score" value="100"',
                         'name="learn_app_passing_score" value="0"'),
    );
    const out = await backend.getLearnPassingScore(ARGS);

    expect(out.passing_score).toBe(0);
    expect(out.rendered).toBe('0');
  });

  it('still reads the score after workers have joined', async () => {
    // The six app/credential fields go Django-`disabled` once workers join,
    // but passing_score deliberately does not — the form's own hint says
    // "You can still edit the learn app description and passing score."
    const { backend } = backendFor(FORM_WORKERS_JOINED);
    const out = await backend.getLearnPassingScore(ARGS);

    expect(out.passing_score).toBe(100);
  });

  it('THROWS when the field is absent rather than defaulting', async () => {
    // Returning a default here would report a gate value ACE invented as one
    // Connect stored — the same silent-wrong-answer class the atom exists to
    // close. Fail loud instead, matching the setter's contract.
    const { backend } = backendFor(
      FORM_FRESH.replace(/<input name="learn_app_passing_score"[^>]*>/, ''),
    );
    await expect(backend.getLearnPassingScore(ARGS)).rejects.toThrow(
      /learn_app_passing_score is not rendered/,
    );
  });

  it('throws on a non-200 rather than reporting a score', async () => {
    const { backend } = backendFor('<h1>Not found</h1>', 404);
    await expect(backend.getLearnPassingScore(ARGS)).rejects.toThrow();
  });
});
