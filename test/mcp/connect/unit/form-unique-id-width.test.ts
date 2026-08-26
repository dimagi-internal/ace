/**
 * dimagi-internal/ace#1644 — every atom that addresses a CCHQ form or module by
 * `unique_id` must accept BOTH of HQ's widths.
 *
 * The defect was not "a regex was wrong"; it was that three sibling atoms
 * disagreed about the same identifier. `commcare_set_menu_display` accepted
 * 32-or-40 while `commcare_patch_xform` and `commcare_get_form_source` pinned
 * 32 only — so after a Nova `upload_app_to_hq` (which regenerates form uids as
 * 40-hex SHA-1) `app-hq-settings` could not re-apply `appearance="acquire"`
 * through its sanctioned path at all.
 *
 * So this file asserts two things:
 *   1. BEHAVIOUR — the shipped pattern accepts a real 32-hex and a real 40-hex
 *      uid and still refuses non-hex / wrong-length input.
 *   2. WIRING — no uid field in `mcp/connect-server.ts` carries a private
 *      32-only pin. That is the half that stops "fix one, leave its sibling".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HQ_UNIQUE_ID_RE } from '../../../../lib/hq-unique-id.js';

const REPO = join(__dirname, '../../../..');
const server = readFileSync(join(REPO, 'mcp/connect-server.ts'), 'utf8');

/** Observed live on hh-poverty-targeting/20260824-1404, same Deliver form. */
const UID_32 = '7467e11c9cd746b2abe85dfd6de329a8';
const UID_40 = '0a77a47110ab1265ac3d240347f2c017451c02fd';

/** Every `<something>_unique_id: z.…` field registered in the server. */
function uniqueIdFields(): { field: string; decl: string; line: number }[] {
  return server.split('\n').flatMap((line, i) => {
    const m = /^\s*([a-z_]*unique_id):\s*(z\..*)$/.exec(line);
    return m ? [{ field: m[1], decl: m[2], line: i + 1 }] : [];
  });
}

// The behaviour block below is a PIN, not a preventer: it exercises the shared
// constant this change introduces, so it is green against the pre-fix tree too.
// The preventers are the WIRING blocks after it — replayed against
// `origin/main`'s source, 9 of this file's assertions go red, and the ones that
// stay green are exactly `module_unique_id` and `parseDraftAppModuleUids`,
// which were already correct. That two-of-three split IS the defect.
describe('the shipped uid pattern accepts both widths and nothing else', () => {
  it('accepts the pre-upload 32-hex form uid', () => {
    expect(HQ_UNIQUE_ID_RE.test(UID_32)).toBe(true);
  });

  it('accepts the post-upload 40-hex form uid HQ itself accepted', () => {
    // `POST /a/<domain>/apps/edit_form_attr/<app_id>/0a77a471…/xform/` returned
    // 200 {"update": {"app-version": 8}} — ACE was the only party refusing it.
    expect(HQ_UNIQUE_ID_RE.test(UID_40)).toBe(true);
  });

  it.each([
    ['non-hex', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'],
    ['truncated 31-hex', UID_32.slice(0, 31)],
    ['33-hex', UID_32 + 'a'],
    ['36-hex (between the two widths)', UID_40.slice(0, 36)],
    ['41-hex', UID_40 + 'a'],
    ['an m/f index', 'm0-f0'],
    ['empty', ''],
  ])('still rejects %s', (_label, value) => {
    expect(HQ_UNIQUE_ID_RE.test(value)).toBe(false);
  });
});

describe('no connect-server uid field carries a private 32-only pin', () => {
  const fields = uniqueIdFields();

  it('found the uid fields', () => {
    const names = new Set(fields.map((f) => f.field));
    expect(names.has('form_unique_id')).toBe(true);
    expect(names.has('module_unique_id')).toBe(true);
  });

  it.each(fields.map((f) => [`${f.field} (line ${f.line})`, f.decl] as const))(
    '%s does not pin 32 hex only',
    (_where, decl) => {
      expect(
        decl,
        'A 32-only pin on a form/module uid is the ace#1644 defect: HQ hands back ' +
          '40-hex SHA-1 uids after a Nova upload_app_to_hq and accepts them on its ' +
          'own endpoints. Use HQ_UNIQUE_ID_RE from lib/hq-unique-id.ts.',
      ).not.toMatch(/\[0-9a-f\]\{32\}\$/);
    },
  );

  it.each(fields.map((f) => [`${f.field} (line ${f.line})`, f.decl] as const))(
    '%s routes through the shared HQ_UNIQUE_ID_RE contract',
    (_where, decl) => {
      // One definition, so widening it again can never reach two of three atoms.
      expect(decl).toContain('HQ_UNIQUE_ID_RE');
    },
  );
});

describe('run-form-walk resolves 40-hex form uids too', () => {
  // The deeper half of #1644: `parseDraftAppFormUids` filtered rows through a
  // 32-only test, so a re-uploaded app produced an EMPTY map and
  // `--draft-only` exited 2 with `resolved 0 forms` — a documented halt in
  // app-hq-settings — against a perfectly healthy app. Its module-side twin
  // had already been widened, which is the same two-out-of-three shape as the
  // atoms above.
  const walk = readFileSync(join(REPO, 'scripts/run-form-walk.ts'), 'utf8');

  /** The body of an exported function, by name. */
  function body(fn: string): string {
    const at = walk.indexOf(`export function ${fn}(`);
    expect(at, `run-form-walk has no ${fn}`).toBeGreaterThan(-1);
    const next = walk.indexOf('\nexport function ', at + 1);
    return walk.slice(at, next === -1 ? undefined : next);
  }

  it.each(['parseDraftAppFormUids', 'parseDraftAppModuleUids'])(
    '%s has no 32-only uid filter',
    (fn) => {
      expect(body(fn)).not.toMatch(/\[0-9a-f\]\{32\}\$/);
    },
  );

  it.each(['parseDraftAppFormUids', 'parseDraftAppModuleUids'])(
    '%s uses the shared HQ_UNIQUE_ID_RE contract',
    (fn) => {
      expect(body(fn)).toContain('HQ_UNIQUE_ID_RE.test(');
    },
  );

  // The suite.xml parser stays 32-only ON PURPOSE — a different surface, with
  // no observed 40-hex value. Pinned so the exclusion is a decision on record
  // rather than something a future sweep "tidies" either way.
  it('leaves the BUILT-suite.xml parser 32-only, with the reason stated', () => {
    const suite = body('parseSuiteFormResources');
    expect(suite).toMatch(/\[0-9a-f\]\{32\}\$/);
    expect(suite).toMatch(/ace#1644/);
  });
});
