/**
 * CommCare HQ app-manager `unique_id` shapes — ONE definition, shared by every
 * atom that addresses a form or a module by id (dimagi-internal/ace#1644).
 *
 * ## Why this file exists
 *
 * HQ hands back TWO widths for the same kind of identifier and both are live:
 *
 * | width | shape | where it comes from |
 * |---|---|---|
 * | 32 hex | `uuid4().hex` | HQ-native forms, `suite.xml`, the `delete_form` action URL |
 * | 40 hex | SHA-1 | HQ modules, and **every form after a Nova `upload_app_to_hq`** |
 *
 * ACE pinned `^[0-9a-f]{32}$` on `commcare_patch_xform` and
 * `commcare_get_form_source` while its sibling `commcare_set_menu_display`
 * already accepted `^[0-9a-f]{32}(?:[0-9a-f]{8})?$`. That narrower pin is a
 * PREDICTIVE GUARD contradicted by observation: HQ itself accepts the 40-hex
 * form id — `POST /a/<domain>/apps/edit_form_attr/<app_id>/<uid>/xform/`
 * returned `200 {"update": {"app-version": 8}}` for
 * `0a77a47110ab1265ac3d240347f2c017451c02fd` on
 * `hh-poverty-targeting/20260824-1404` — but ACE rejected it in its own Zod
 * schema before any request was made. See CLAUDE.md § "A guard that PREDICTS
 * another system's rejection must cite a reproducer, or it doesn't ship."
 *
 * The same run showed how the two widths appear on ONE form: the Deliver
 * form's uid went `7467e11c9cd746b2abe85dfd6de329a8` (32) →
 * `0a77a47110ab1265ac3d240347f2c017451c02fd` (40) across a single
 * `upload_app_to_hq`. So the widths are not "old HQ vs new HQ" and cannot be
 * split per-atom: any atom taking a form or module uid must accept both.
 *
 * It stays a REAL constraint — arbitrary-length hex and non-hex are still
 * refused, because the failure this guards against is passing an `m0-f0` style
 * index or a truncated id into a URL path, which HQ answers with a confusing
 * 404 rather than a validation error.
 */

/** Accepts CCHQ's 32-hex (uuid4) and 40-hex (SHA-1) `unique_id` widths. */
export const HQ_UNIQUE_ID_RE = /^[0-9a-f]{32}(?:[0-9a-f]{8})?$/;

/**
 * The Zod error message every uid field shares. Names BOTH widths and where
 * each comes from, so a caller that hit the guard knows which id it grabbed.
 */
export const HQ_UNIQUE_ID_HINT =
  'unique_id is a 32-hex (uuid4) or 40-hex (SHA-1) string. 32-hex comes from ' +
  'suite.xml or the delete_form action URL; 40-hex is what CCHQ hands back for ' +
  'modules and for any form after a Nova upload_app_to_hq (ace#1644). Both are ' +
  'accepted; an m/f index or a truncated id is not.';

/** True iff `value` is one of CCHQ's two `unique_id` widths. */
export function isHqUniqueId(value: unknown): value is string {
  return typeof value === 'string' && HQ_UNIQUE_ID_RE.test(value);
}

/**
 * `32` | `40` for a valid uid, `null` otherwise. Useful in diagnostics: a
 * 40-hex form uid is the tell that the app was re-uploaded from Nova since the
 * id was last recorded (ace#1643).
 */
export function hqUniqueIdWidth(value: unknown): 32 | 40 | null {
  if (!isHqUniqueId(value)) return null;
  return value.length === 32 ? 32 : 40;
}
