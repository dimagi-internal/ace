import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHECKS,
  checkBannerWhenPrivate,
  checkEveryQuestionMirrored,
  checkFormItemsCarryRefs,
  checkImportsUnique,
  checkNoDenyListedParty,
  checkProductsRecorded,
  checkRecordComplete,
  checkResponderLinkOpen,
} from '../../../skills/solicitation-google-form-qa/checks';

/**
 * Every control runs on the evidence bundle captured from a LIVE round trip
 * (2026-10-18): a real form built from labs solicitation 1000001, published,
 * opened, fetched anonymously (200) and read back with
 * get_google_form_definition. Negative controls are that same bundle with one
 * thing broken, so each check is proved against what Forms actually returns.
 *
 * `responder_link_open` exists because publishing alone leaves a form at 401
 * to anyone outside the drive (observed live in ace#3171, the Forms atoms PR);
 * only the anyone-with-link permission opens it.
 */
const LIVE = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/forms/solicitation-google-form-qa-bundle-live-2026-10-18.json'), 'utf8'),
);
const j = (o: unknown) => JSON.stringify(o);

describe('solicitation-google-form-qa checks, on the live bundle', () => {
  it('the live bundle passes all 8 checks', async () => {
    expect(CHECKS).toHaveLength(8);
    for (const c of CHECKS) {
      const r = await c.run(j(LIVE));
      expect(r.pass, `${c.id}: ${r.detail}`).toBe(true);
    }
  });

  it('every failure carries an auto-fix hint', async () => {
    for (const c of CHECKS) {
      const r = await c.run('not json');
      if (!r.pass) expect(r.auto_fix_hint, c.id).toBeTruthy();
    }
  });

  it('record_complete: passes the live record, fails one with no question_map', () => {
    expect(checkRecordComplete(j(LIVE)).pass).toBe(true);
    const b = structuredClone(LIVE);
    b.record.question_map = {};
    expect(checkRecordComplete(j(b)).pass).toBe(false);
  });

  it('every_question_mirrored: passes live, fails when the solicitation gained a question', () => {
    expect(checkEveryQuestionMirrored(j(LIVE)).pass).toBe(true);
    const b = structuredClone(LIVE);
    b.solicitation.questions.push({ id: 'added-later' });
    const r = checkEveryQuestionMirrored(j(b));
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('added-later');
  });

  it('form_items_carry_refs: passes the live form, fails a hand-edited item and a duplicated one', () => {
    expect(checkFormItemsCarryRefs(j(LIVE)).pass).toBe(true);
    const edited = structuredClone(LIVE);
    edited.form.items[5].description = 'edited by hand';
    expect(checkFormItemsCarryRefs(j(edited)).pass).toBe(false);
    const dup = structuredClone(LIVE);
    dup.form.items.push(structuredClone(dup.form.items[4]));
    const r = checkFormItemsCarryRefs(j(dup));
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('repeat');
  });

  it('banner_when_private: passes the live private form, fails it with the banner removed', () => {
    expect(checkBannerWhenPrivate(j(LIVE)).pass).toBe(true);
    const b = structuredClone(LIVE);
    b.form.description = b.form.description.split('\n\n').slice(1).join('\n\n');
    expect(checkBannerWhenPrivate(j(b)).pass).toBe(false);
    b.solicitation.is_public = true;
    expect(checkBannerWhenPrivate(j(b)).pass).toBe(true);
  });

  it('no_deny_listed_party: passes live, fails when the deny list names a party the real text names', () => {
    expect(checkNoDenyListedParty(j(LIVE)).pass).toBe(true);
    const b = structuredClone(LIVE);
    b.deny_list = ['Noora Health'];
    const r = checkNoDenyListedParty(j(b));
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('description');
    const none = structuredClone(LIVE);
    delete none.deny_list;
    expect(checkNoDenyListedParty(j(none)).pass).toBe(false);
  });

  it('responder_link_open: passes the live 200, fails the 401 a published-only form gives', () => {
    expect(checkResponderLinkOpen(j(LIVE)).pass).toBe(true);
    const b = structuredClone(LIVE);
    b.anonymous_http_status = 401;
    const r = checkResponderLinkOpen(j(b));
    expect(r.pass).toBe(false);
    expect(r.auto_fix_hint).toContain('anyoneWithLinkCanRespond');
    b.record.status = 'closed';
    expect(checkResponderLinkOpen(j(b)).pass).toBe(true);
  });

  it('products_recorded: passes with no run bound, fails a missing or mismatched block', () => {
    expect(checkProductsRecorded(j(LIVE)).pass).toBe(true);
    const b = structuredClone(LIVE);
    b.run_products_google_form = {
      form_id: b.record.form_id,
      responder_url: b.record.responder_url,
      edit_url: b.record.edit_url,
    };
    expect(checkProductsRecorded(j(b)).pass).toBe(true);
    b.run_products_google_form.form_id = 'OTHER';
    expect(checkProductsRecorded(j(b)).pass).toBe(false);
    delete b.run_products_google_form;
    expect(checkProductsRecorded(j(b)).pass).toBe(false);
  });

  it('imports_unique: passes live, fails a form response imported twice', () => {
    expect(checkImportsUnique(j(LIVE)).pass).toBe(true);
    const b = structuredClone(LIVE);
    b.record.imported = [
      { form_response_id: 'r1', labs_response_id: 77 },
      { form_response_id: 'r1', labs_response_id: 78 },
    ];
    expect(checkImportsUnique(j(b)).pass).toBe(false);
  });
});
