//
// connect-opp-setup's POST-CONDITION — does the live opportunity match what
// the skill decided?
//
// Every Connect atom validates its own call at the boundary, which catches a
// bad call. It does not catch a VALID-BUT-WRONG end state: a payment unit that
// never landed, a test flag left off, a test user whose invite was "queued" and
// never existed (ace#824), an opportunity that never made the `/activate/`
// transition (ace#617/#624). Each of those surfaces two phases later, inside a
// Phase 6 emulator walk, as a missing tile. This reads the live opportunity
// back once at the end of the skill and says, check by check, whether the end
// state holds — and whether Phase 6 can walk it.
//
// Pure: the skill does the reads (connect_get_opportunity,
// connect_list_payment_units, connect_list_flw_invites) and hands their
// results in. Reliability rules are the atoms' own (docs/atom-schemas.md):
//   - `connect_get_opportunity`: `active` / `is_test` come from the edit form
//     and are authoritative there — but `active` is the CREATE-side flag, true
//     even on an opportunity that never made the `/activate/` transition
//     (ace#617). Activation is therefore PROVEN only by an invite row existing
//     (`invite_users/` hard-rejects a non-active opportunity). An `undefined`
//     field means UNKNOWN, never false.
//   - `connect_list_payment_units`: only `name` and `payment_unit_uuid` are
//     reliable; amounts are not read back here.
//   - `connect_list_flw_invites`: gate on ROW EXISTENCE (`match !== null`),
//     never on `claimed`; a fresh pending row is normal.
//   - Verification rules have no read surface; the evidence is the count
//     Connect persisted, recorded by Step 5 (`form_field_rules_saved`).

export interface OppReadback {
  /** `connect_get_opportunity` result (or null if the read failed). */
  opportunity: { id?: unknown; name?: unknown; active?: unknown; is_test?: unknown } | null;
  /** `connect_list_payment_units` rows (or null if the read failed). */
  paymentUnits: Array<{ name?: unknown; payment_unit_uuid?: unknown }> | null;
  /** `connect_list_flw_invites({phone})` — its `match` (or null if the read failed). */
  testUserInvite: { match: unknown } | null;
}

export interface OppDecided {
  /** Step 6: the payment units the skill created, by name. */
  paymentUnitNames: string[];
  /** Step 5: rules the skill decided to write. */
  formFieldRulesExpected: number;
  /** Step 5: `form_field_rules_saved` from the atom's response. */
  formFieldRulesSaved: number | null;
  /**
   * The skill's own activation rule. Phase 4 activates every ACE build/QA
   * opportunity (Step 6.5), so this is `true`; a caller that deliberately did
   * not activate sets it false and the activation check stands down.
   */
  expectActive: boolean;
  /** Step 7: the ACE test user must be invited (the Phase 6 walk claims its tile). */
  expectTestUserInvited: boolean;
}

export interface PostconditionCheck {
  id:
    | 'opportunity_readable'
    | 'is_test'
    | 'activated'
    | 'payment_units_match'
    | 'verification_rules_persisted'
    | 'test_user_invited';
  pass: boolean;
  detail: string;
  /** True when a failure of this check means the Phase 6 walk cannot succeed. */
  blocksPhase6: boolean;
}

export interface PostconditionResult {
  ok: boolean;
  checks: PostconditionCheck[];
  /** Non-empty ⇒ Phase 6 must not start its walk; each entry says why. */
  phase6_blockers: string[];
}

function norm(s: unknown): string {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function checkOppPostcondition(read: OppReadback, decided: OppDecided): PostconditionResult {
  const checks: PostconditionCheck[] = [];
  const opp = read.opportunity;

  checks.push(
    opp && (opp.id || opp.name)
      ? { id: 'opportunity_readable', pass: true, detail: `read back "${String(opp.name ?? opp.id)}"`, blocksPhase6: true }
      : { id: 'opportunity_readable', pass: false, detail: 'connect_get_opportunity returned nothing — the opportunity cannot be confirmed to exist', blocksPhase6: true },
  );

  // is_test: undefined is UNKNOWN, which is not a pass either — every ACE opp must be test-flagged.
  const isTest = opp?.is_test;
  checks.push({
    id: 'is_test',
    pass: isTest === true,
    detail:
      isTest === true
        ? 'is_test: true'
        : isTest === false
          ? 'is_test is FALSE — this opportunity would count in prod analytics and payment exports'
          : 'is_test could not be read (undefined = unknown, not false)',
    blocksPhase6: false,
  });

  const inviteRow = read.testUserInvite ? read.testUserInvite.match !== null && read.testUserInvite.match !== undefined : null;
  if (decided.expectActive) {
    // `active: true` alone is the create-side flag (ace#617); the invite row is the proof.
    const pass = opp?.active !== false && inviteRow === true;
    checks.push({
      id: 'activated',
      pass,
      detail: pass
        ? 'active, and proven by an existing invite row (invite_users/ rejects a non-active opportunity)'
        : opp?.active === false
          ? 'active is FALSE on the edit form — Step 6.5 /activate/ did not land'
          : inviteRow === null
            ? 'activation unproven — the invite read-back failed, and `active` alone is the create-side flag (ace#617)'
            : 'activation unproven — no invite row exists, so /activate/ cannot be confirmed (ace#617/#624)',
      blocksPhase6: true,
    });
  } else {
    checks.push({ id: 'activated', pass: true, detail: 'not activated, by the skill\'s own rule (expectActive: false)', blocksPhase6: false });
  }

  if (read.paymentUnits === null) {
    checks.push({ id: 'payment_units_match', pass: false, detail: 'connect_list_payment_units failed — payment units unconfirmed', blocksPhase6: false });
  } else {
    const live = new Set(read.paymentUnits.map((p) => norm(p.name)));
    const missing = decided.paymentUnitNames.filter((n) => !live.has(norm(n)));
    const extra = read.paymentUnits.length - (decided.paymentUnitNames.length - missing.length);
    const pass = decided.paymentUnitNames.length > 0 && missing.length === 0 && extra === 0;
    checks.push({
      id: 'payment_units_match',
      pass,
      detail: pass
        ? `${read.paymentUnits.length} payment unit(s), names match what Step 6 created`
        : decided.paymentUnitNames.length === 0
          ? 'no payment units were decided — an opportunity cannot pay with none'
          : `${missing.length ? `missing: ${missing.join(', ')}` : ''}${missing.length && extra ? '; ' : ''}${extra > 0 ? `${extra} unexpected unit(s) on the opportunity` : ''}`,
      blocksPhase6: false,
    });
  }

  const saved = decided.formFieldRulesSaved;
  const vPass = decided.formFieldRulesExpected === 0 ? true : saved !== null && saved >= decided.formFieldRulesExpected;
  checks.push({
    id: 'verification_rules_persisted',
    pass: vPass,
    detail:
      decided.formFieldRulesExpected === 0
        ? 'no form-field rules were decided'
        : saved === null
          ? `${decided.formFieldRulesExpected} rule(s) decided but Step 5 recorded no form_field_rules_saved — the write is unproven`
          : `${saved} of ${decided.formFieldRulesExpected} decided rule(s) persisted (Step 5's form_field_rules_saved — Connect has no read surface for them)`,
    blocksPhase6: false,
  });

  if (decided.expectTestUserInvited) {
    checks.push({
      id: 'test_user_invited',
      pass: inviteRow === true,
      detail:
        inviteRow === true
          ? 'the ACE test user has an invite row (pending until Phase 6 claims it — normal)'
          : inviteRow === null
            ? 'connect_list_flw_invites failed — the test user invite is unconfirmed'
            : 'no invite row for the ACE test user — the Phase 6 walk would hunt a tile that cannot exist (ace#824)',
      blocksPhase6: true,
    });
  }

  const failed = checks.filter((c) => !c.pass);
  return {
    ok: failed.length === 0,
    checks,
    phase6_blockers: failed.filter((c) => c.blocksPhase6).map((c) => `${c.id}: ${c.detail}`),
  };
}
