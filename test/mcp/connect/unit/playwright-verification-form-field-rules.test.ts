/**
 * Unit tests for PlaywrightBackend.setVerificationFlags's `form_field_rules`
 * handling — the `form_json` formset on
 * `/a/<org>/opportunity/<id>/verification_flags_config/`.
 *
 * Regression context (dimagi-internal/ace#1011):
 *   `form_field_rules` was accepted by the Zod schema and typed in
 *   VerificationFlags, then silently dropped — nothing between the GET and the
 *   POST ever read it, so the atom returned `{ok:true}` having written nothing.
 *   Because ace#1013 established that `duplicate` / `gps` / `catchment_areas` /
 *   `location` / `check_attachments` no longer exist on the form, `form_json`
 *   is the ONLY surviving surface for enforcing a PDD Evidence-Model Layer A
 *   predicate server-side. A test is what keeps it wired.
 *
 * Live-validated 2026-07-28 against opp 71c6401c (ai-demo-space): two rules
 * persisted with real row PKs and survived a re-run without duplicating.
 *
 * Mock harness mirrors playwright-add-org-member.test.ts — scripted FIFO
 * responses + a captured-request log.
 */
import { describe, it, expect } from 'vitest';
import type { APIRequestContext, APIResponse } from 'playwright';
import { PlaywrightBackend } from '../../../../mcp/connect/backends/playwright.js';

interface CapturedRequest {
  method: 'GET' | 'POST';
  url: string;
  body?: Record<string, string | number | boolean>;
}
interface ScriptedResponse { status: number; body: string }

function makeRequestContext(scripted: ScriptedResponse[], captured: CapturedRequest[]): APIRequestContext {
  let i = 0;
  const respond = (next: ScriptedResponse): APIResponse =>
    ({
      status: () => next.status,
      headers: () => ({ 'content-type': 'text/html; charset=utf-8' }),
      text: async () => next.body,
    }) as unknown as APIResponse;
  const get = async (url: string) => {
    captured.push({ method: 'GET', url });
    const next = scripted[i++];
    if (!next) throw new Error(`No scripted response for GET #${i}: ${url}`);
    return respond(next);
  };
  const post = async (url: string, init?: { form?: Record<string, string | number | boolean> }) => {
    captured.push({ method: 'POST', url, body: init?.form });
    const next = scripted[i++];
    if (!next) throw new Error(`No scripted response for POST #${i}: ${url}`);
    return respond(next);
  };
  return { get, post } as unknown as APIRequestContext;
}

/**
 * Minimal stand-in for the real verification_flags_config page. Field shapes
 * copied from a live capture: `form_json-<i>-deliver_unit` is a CHECKBOX whose
 * value is the deliver-unit server PK, and Django renders a `__prefix__`
 * template row that must never be treated as a real row.
 */
function configPage(opts: { savedRules?: Array<{ name: string; path: string; value: string; du: string; id: string }>; initialForms?: number; withLegacyFlagInputs?: boolean } = {}) {
  const saved = opts.savedRules ?? [];
  // The five inputs ace#1013 found REMOVED from the live page. Off by default
  // (that is today's reality); switch on to prove the support guard relaxes by
  // itself if Connect ever restores them — no code change required.
  const legacy = opts.withLegacyFlagInputs
    ? `
    <input type="checkbox" name="duplicate">
    <input type="checkbox" name="gps">
    <input type="checkbox" name="catchment_areas">
    <input type="number" name="location" value="10">
    <input type="checkbox" name="deliver_unit-0-check_attachments">`
    : '';
  const rows = saved
    .map((r, i) => `
      <input type="text" name="form_json-${i}-name" value="${r.name}">
      <input type="text" name="form_json-${i}-question_path" value="${r.path}">
      <input type="text" name="form_json-${i}-question_value" value="${r.value}">
      <input type="checkbox" name="form_json-${i}-deliver_unit" value="${r.du}">
      <input type="hidden" name="form_json-${i}-id" value="${r.id}">`)
    .join('\n');
  return `<html><body><form method="post">
    <input type="hidden" name="csrfmiddlewaretoken" value="CSRF123">${legacy}
    <input type="time" name="form_submission_start" value="">
    <input type="time" name="form_submission_end" value="">
    <input type="hidden" name="deliver_unit-TOTAL_FORMS" value="1">
    <input type="hidden" name="deliver_unit-INITIAL_FORMS" value="0">
    <input type="hidden" name="deliver_unit-MIN_NUM_FORMS" value="0">
    <input type="hidden" name="deliver_unit-MAX_NUM_FORMS" value="1">
    <select name="deliver_unit-0-deliver_unit"><option value="6455" selected>Meeting record</option></select>
    <input type="number" name="deliver_unit-0-duration" value="0">
    <input type="hidden" name="deliver_unit-0-id" value="">
    <input type="hidden" name="form_json-TOTAL_FORMS" value="${saved.length + 1}">
    <input type="hidden" name="form_json-INITIAL_FORMS" value="${opts.initialForms ?? saved.length}">
    <input type="hidden" name="form_json-MIN_NUM_FORMS" value="0">
    <input type="hidden" name="form_json-MAX_NUM_FORMS" value="1000">
    <input type="text" name="form_json-__prefix__-name" value="">
    <input type="text" name="form_json-__prefix__-question_path" value="">
    <input type="text" name="form_json-__prefix__-question_value" value="">
    <input type="checkbox" name="form_json-__prefix__-deliver_unit" value="6455">
    <input type="hidden" name="form_json-__prefix__-id" value="">
    ${rows}
  </form></body></html>`;
}

const backendFor = (request: APIRequestContext) =>
  new PlaywrightBackend({ baseUrl: 'https://connect.example', csrfToken: 'CSRF123', request });

const ORG = 'ai-demo-space';
const OPP = '71c6401c-e8ac-4bb2-a0e1-b74a6aaff2cc';

const A1 = [
  { name: 'A1a meeting held', question_path: '/data/meeting_conducted', question_value: 'yes', deliver_unit_id: 6455 },
  { name: 'A1b meeting type', question_path: '/data/community_meeting/meeting_type', question_value: 'community_meeting', deliver_unit_id: 6455 },
];

describe('setVerificationFlags — form_field_rules (ace#1011)', () => {
  it('writes each rule into the form_json formset and sizes TOTAL_FORMS', async () => {
    const captured: CapturedRequest[] = [];
    const req = makeRequestContext(
      [
        { status: 200, body: configPage() },                                  // GET config
        { status: 302, body: '' },                                            // POST
        { status: 200, body: configPage({ savedRules: [], initialForms: 2 }) }, // read-back
      ],
      captured,
    );

    const res = await backendFor(req).setVerificationFlags({
      organization_slug: ORG, opportunity_id: OPP, flags: { form_field_rules: A1 },
    });

    const post = captured.find((c) => c.method === 'POST')!;
    const body = post.body as Record<string, string>;

    expect(body['form_json-0-name']).toBe('A1a meeting held');
    expect(body['form_json-0-question_path']).toBe('/data/meeting_conducted');
    expect(body['form_json-0-question_value']).toBe('yes');
    expect(body['form_json-0-deliver_unit']).toBe('6455');
    expect(body['form_json-1-question_path']).toBe('/data/community_meeting/meeting_type');
    expect(body['form_json-1-question_value']).toBe('community_meeting');
    expect(body['form_json-TOTAL_FORMS']).toBe('2');

    // The read-back is the evidence a bare {ok:true} never gave us.
    expect(res.form_field_rules_saved).toBe(2);
  });

  it('never posts the Django __prefix__ template row as a real row', async () => {
    const captured: CapturedRequest[] = [];
    const req = makeRequestContext(
      [{ status: 200, body: configPage() }, { status: 302, body: '' }, { status: 200, body: configPage({ initialForms: 2 }) }],
      captured,
    );
    await backendFor(req).setVerificationFlags({
      organization_slug: ORG, opportunity_id: OPP, flags: { form_field_rules: A1 },
    });
    const body = captured.find((c) => c.method === 'POST')!.body as Record<string, string>;
    expect(Object.keys(body).some((k) => k.includes('__prefix__'))).toBe(false);
  });

  it('is idempotent — an already-present rule is not appended twice', async () => {
    const already = [
      { name: 'A1a meeting held', path: '/data/meeting_conducted', value: 'yes', du: '6455', id: '153' },
      { name: 'A1b meeting type', path: '/data/community_meeting/meeting_type', value: 'community_meeting', du: '6455', id: '154' },
    ];
    const captured: CapturedRequest[] = [];
    const req = makeRequestContext(
      [
        { status: 200, body: configPage({ savedRules: already }) },
        { status: 302, body: '' },
        { status: 200, body: configPage({ savedRules: already }) },
      ],
      captured,
    );
    await backendFor(req).setVerificationFlags({
      organization_slug: ORG, opportunity_id: OPP, flags: { form_field_rules: A1 },
    });
    const body = captured.find((c) => c.method === 'POST')!.body as Record<string, string>;
    expect(body['form_json-TOTAL_FORMS']).toBe('2');
    expect(body['form_json-0-id']).toBe('153');
    expect(body['form_json-1-id']).toBe('154');
    expect(body['form_json-2-name']).toBeUndefined();
  });

  it('preserves existing rules while appending a genuinely new one', async () => {
    const already = [{ name: 'A1a meeting held', path: '/data/meeting_conducted', value: 'yes', du: '6455', id: '153' }];
    const captured: CapturedRequest[] = [];
    const req = makeRequestContext(
      [
        { status: 200, body: configPage({ savedRules: already }) },
        { status: 302, body: '' },
        { status: 200, body: configPage({ initialForms: 2 }) },
      ],
      captured,
    );
    await backendFor(req).setVerificationFlags({
      organization_slug: ORG, opportunity_id: OPP, flags: { form_field_rules: A1 },
    });
    const body = captured.find((c) => c.method === 'POST')!.body as Record<string, string>;
    expect(body['form_json-0-id']).toBe('153');
    expect(body['form_json-1-question_path']).toBe('/data/community_meeting/meeting_type');
    expect(body['form_json-1-id']).toBe('');
    expect(body['form_json-TOTAL_FORMS']).toBe('2');
  });

  it('leaves the formset untouched when no form_field_rules are supplied', async () => {
    const captured: CapturedRequest[] = [];
    const req = makeRequestContext(
      [{ status: 200, body: configPage() }, { status: 302, body: '' }, { status: 200, body: configPage() }],
      captured,
    );
    await backendFor(req).setVerificationFlags({
      organization_slug: ORG, opportunity_id: OPP, flags: { form_submission_start: '08:00:00' },
    });
    const body = captured.find((c) => c.method === 'POST')!.body as Record<string, string>;
    // TOTAL_FORMS is replayed from the page (1), not rewritten by rule-building.
    expect(body['form_json-TOTAL_FORMS']).toBe('1');
    expect(body['form_json-0-name']).toBeUndefined();
  });
});


// ---------------------------------------------------------------------------
// dimagi-internal/ace#1013 — flags whose input no longer exists must FAIL
// LOUD, and `duration_seconds` was a 60x misnomer.
//
// Live-verified 2026-07-28 across 4 opportunities / 2 programs: the page
// renders only form_submission_start/end, deliver_unit-<i>-{deliver_unit,
// duration,id} and form_json-<i>-*. `duplicate`, `gps`, `catchment_areas`,
// `location` and `check_attachments` appear NOWHERE — the atom posted them as
// unrecognized keys, Django dropped them, and it returned `{ok: true}`. Six
// opportunities spanning 2026-06-06..07-28 show INITIAL_FORMS: 0, i.e. no ACE
// run has ever persisted a verification flag, while every one of those runs
// reported "verification flags configured" in its Phase 4 summary.
// ---------------------------------------------------------------------------

describe('setVerificationFlags — unsupported-flag guard (ace#1013)', () => {
  it('throws naming `gps` when the input is absent, and does NOT post', async () => {
    const captured: CapturedRequest[] = [];
    const req = makeRequestContext([{ status: 200, body: configPage() }], captured);

    await expect(
      backendFor(req).setVerificationFlags({
        organization_slug: ORG, opportunity_id: OPP, flags: { gps: true },
      }),
    ).rejects.toThrow(/gps/);

    // Fail BEFORE the write: a partial post that silently drops the flag is
    // exactly what produced the false "configured" claim.
    expect(captured.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('names EVERY unsupported flag in one error, not just the first', async () => {
    const captured: CapturedRequest[] = [];
    const req = makeRequestContext([{ status: 200, body: configPage() }], captured);

    let err: unknown;
    try {
      await backendFor(req).setVerificationFlags({
        organization_slug: ORG,
        opportunity_id: OPP,
        flags: {
          duplicate: true,
          gps: true,
          catchment_areas: true,
          gps_radius_meters: 100,
          deliver_unit_checks: [{ deliver_unit_id: 6455, check_attachments: true }],
        },
      });
    } catch (e) {
      err = e;
    }
    const msg = (err as Error).message;
    for (const flag of ['duplicate', 'gps', 'catchment_areas', 'gps_radius_meters', 'check_attachments']) {
      expect(msg).toContain(flag);
    }
  });

  it('does not fire when the caller asks for a flag to be OFF (absent field == off)', async () => {
    const captured: CapturedRequest[] = [];
    const req = makeRequestContext(
      [{ status: 200, body: configPage() }, { status: 302, body: '' }, { status: 200, body: configPage() }],
      captured,
    );
    await expect(
      backendFor(req).setVerificationFlags({
        organization_slug: ORG, opportunity_id: OPP, flags: { duplicate: false, gps: false },
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('relaxes by itself when the live page carries the inputs again', async () => {
    const captured: CapturedRequest[] = [];
    const req = makeRequestContext(
      [
        { status: 200, body: configPage({ withLegacyFlagInputs: true }) },
        { status: 302, body: '' },
        { status: 200, body: configPage({ withLegacyFlagInputs: true }) },
      ],
      captured,
    );
    const res = await backendFor(req).setVerificationFlags({
      organization_slug: ORG, opportunity_id: OPP, flags: { gps: true, gps_radius_meters: 250 },
    });
    expect(res.ok).toBe(true);
    const body = captured.find((c) => c.method === 'POST')!.body as Record<string, string>;
    expect(body['gps']).toBe('on');
    expect(body['location']).toBe('250');
  });

  it('form_submission_* stay supported (the guard is general, not a denylist of five)', async () => {
    const captured: CapturedRequest[] = [];
    const req = makeRequestContext(
      [{ status: 200, body: configPage() }, { status: 302, body: '' }, { status: 200, body: configPage() }],
      captured,
    );
    const res = await backendFor(req).setVerificationFlags({
      organization_slug: ORG,
      opportunity_id: OPP,
      flags: { form_submission_start: '08:00', form_submission_end: '18:00' },
    });
    expect(res.ok).toBe(true);
    const body = captured.find((c) => c.method === 'POST')!.body as Record<string, string>;
    expect(body['form_submission_start']).toBe('08:00');
  });
});

describe('setVerificationFlags — duration is MINUTES (ace#1013)', () => {
  it('writes duration_minutes verbatim into deliver_unit-<i>-duration', async () => {
    const captured: CapturedRequest[] = [];
    const req = makeRequestContext(
      [{ status: 200, body: configPage() }, { status: 302, body: '' }, { status: 200, body: configPage() }],
      captured,
    );
    await backendFor(req).setVerificationFlags({
      organization_slug: ORG,
      opportunity_id: OPP,
      flags: { deliver_unit_checks: [{ deliver_unit_id: 6455, duration_minutes: 6 }] },
    });
    const body = captured.find((c) => c.method === 'POST')!.body as Record<string, string>;
    // The form label is "Minimum time to complete form (minutes)" — a PDD's
    // 6-minute floor must land as 6, not 360.
    expect(body['deliver_unit-0-duration']).toBe('6');
  });

  it('rejects the legacy duration_seconds name loudly instead of writing a 60x-wrong floor', async () => {
    const captured: CapturedRequest[] = [];
    const req = makeRequestContext([{ status: 200, body: configPage() }], captured);
    await expect(
      backendFor(req).setVerificationFlags({
        organization_slug: ORG,
        opportunity_id: OPP,
        // A caller honouring the old parameter name converts 6 minutes to 360
        // and gets a SIX HOUR floor — an unfirable gate, silently.
        flags: { deliver_unit_checks: [{ deliver_unit_id: 6455, duration_seconds: 360 } as never] },
      }),
    ).rejects.toThrow(/duration_minutes/);
    expect(captured.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});
