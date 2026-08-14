/**
 * Probe: prove `connect_set_verification_flags` actually persists
 * `form_field_rules` into Connect's `form_json` formset.
 *
 * Context — dimagi-internal/ace#1011 + #1013:
 *   `form_field_rules` was accepted by the Zod schema and typed in
 *   VerificationFlags, then silently dropped — nothing in the Playwright
 *   backend ever read it, and the atom returned a bare `{ok:true}`. Because
 *   #1013 established that `duplicate` / `gps` / `catchment_areas` /
 *   `location` / `check_attachments` no longer exist on Connect's form at all,
 *   `form_json` is the ONLY surviving surface on which a PDD's Evidence-Model
 *   Layer A predicate can be enforced server-side.
 *
 * What this proves (and why it can't be faked by the POST status):
 *   `form_json-INITIAL_FORMS` is the count of rows Django loaded FROM THE DB
 *   when rendering the page. Reading it on a fresh GET after the POST is a
 *   direct measure of what was persisted — not what was sent. #1013's survey
 *   found it at 0 on all six ACE opportunities it checked.
 *
 * Run:
 *   npx tsx scripts/probe-verification-form-field-rules.ts <opp-uuid> [--org <slug>]
 */
import { config as dotenvConfig } from 'dotenv';
import * as path from 'node:path';
import * as os from 'node:os';
import { PlaywrightSession } from '../mcp/connect/auth/playwright-session.js';
import { PlaywrightBackend } from '../mcp/connect/backends/playwright.js';

dotenvConfig();
dotenvConfig({ path: path.join(os.homedir(), '.claude/plugins/data/ace-ace/.env'), override: false });

const oppId = process.argv[2];
const orgIdx = process.argv.indexOf('--org');
const org = orgIdx > -1 ? process.argv[orgIdx + 1] : 'ai-demo-space';
if (!oppId) {
  console.error('usage: npx tsx scripts/probe-verification-form-field-rules.ts <opp-uuid> [--org <slug>]');
  process.exit(2);
}

const baseUrl = process.env.CONNECT_BASE_URL ?? 'https://connect.dimagi.com';

async function main() {
  const session = new PlaywrightSession({
    baseUrl,
    cchqBaseUrl: process.env.CCHQ_BASE_URL ?? 'https://www.commcarehq.org',
    hqUsername: process.env.ACE_HQ_USERNAME,
    hqPassword: process.env.ACE_HQ_PASSWORD,
  });
  const ctx = await session.getContext();
  const backend = new PlaywrightBackend({
    baseUrl,
    csrfToken: session.getCsrfToken(),
    request: ctx.request,
    session,
  });

  const cfgPath = `/a/${org}/opportunity/${oppId}/verification_flags_config/`;
  const readInitial = async (label: string) => {
    const res = await ctx.request.get(cfgPath);
    const html = await res.text();
    const m = html.match(/name="form_json-INITIAL_FORMS"[^>]*value="(\d+)"/);
    const saved = m ? Number(m[1]) : null;
    const paths = [...html.matchAll(/name="form_json-\d+-question_path"[^>]*value="([^"]*)"/g)].map((x) => x[1]).filter(Boolean);
    console.log(`[${label}] form_json-INITIAL_FORMS = ${saved}`);
    if (paths.length) console.log(`[${label}] persisted question_paths:`, paths);
    return saved;
  };

  console.log(`Opportunity ${oppId} (org ${org})\n`);
  const before = await readInitial('BEFORE');

  // The Spark Layer-A A1 predicate, verified against the released Deliver CCZ:
  // stored values are `yes` / `community_meeting`, NOT the display labels.
  const deliverUnitId = Number(process.env.PROBE_DELIVER_UNIT_ID ?? 6455);
  const rules = [
    // NOTE: `name` is capped at 25 chars by Connect (see the Zod schema).
    // A 26-char name fails the WHOLE formset with a 200 + no success banner.
    // `question_path` is a JSONPath into the HQ form-JSON doc (`form.<group>.<question>`),
    // NOT an XForm XPath — an XPath makes Connect's receiver 500 on every payable
    // visit (ace#1301). The first rule is deliberately written as an XPath to prove
    // the normaliser rewrites it; the read-back below must show `form.meeting_conducted`.
    { name: 'A1a meeting held', question_path: '/data/meeting_conducted', question_value: 'yes', deliver_unit_id: deliverUnitId },
    { name: 'A1b meeting type', question_path: 'form.community_meeting.meeting_type', question_value: 'community_meeting', deliver_unit_id: deliverUnitId },
  ];

  console.log('\nPOSTing form_field_rules:', JSON.stringify(rules, null, 2));
  const res = await backend.setVerificationFlags({
    organization_slug: org,
    opportunity_id: oppId,
    flags: { form_field_rules: rules },
  });
  console.log('atom returned:', res);

  const after = await readInitial('AFTER');

  // Idempotency: a second identical call must not duplicate rows.
  await backend.setVerificationFlags({
    organization_slug: org,
    opportunity_id: oppId,
    flags: { form_field_rules: rules },
  });
  const afterTwice = await readInitial('AFTER 2nd identical call');

  console.log('\n──────── VERDICT ────────');
  const ok = after !== null && after >= rules.length;
  console.log(ok ? `PASS — ${after} rule(s) persisted (was ${before})` : `FAIL — expected >= ${rules.length}, got ${after}`);
  const idem = after === afterTwice;
  console.log(idem ? `PASS — idempotent (still ${afterTwice} after re-run)` : `FAIL — duplicated: ${after} -> ${afterTwice}`);

  await session.close();
  process.exit(ok && idem ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
