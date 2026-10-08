/**
 * Mobile mode of skills/coach-session-capture, step 1: turn a Labs
 * `start_ocs_outreach` preview into the exact `workflow_run_action` commit — or
 * refuse. The ONLY way the skill commits a coaching send.
 *
 *   npx tsx scripts/coach-capture-mobile-plan.ts --preview <preview.json> \
 *     --hq-users <commcare_list_users.json> [--phone +7426...] --out <plan.json>
 *
 * Refuses (exit 2, CoachCaptureRefusal) unless the preview's `deliver_to` is the
 * ConnectID username of ACE's own test user — resolved from the HQ mobile-worker
 * list by ACE_E2E_PHONE, never typed. That is the owner's carve-out from "ACE never
 * triggers outreach" (Jonathan, 2026-10-07), and nothing wider: a real worker, a
 * staff member's ConnectID, or a preview without a QA redirect all refuse.
 *
 * Writes {start, arguments, confirm, ace_test_username}; the skill passes
 * `arguments` + `confirm` to `workflow_run_action` unchanged (changing either
 * voids Labs' confirm token anyway).
 */
import * as fs from 'node:fs';
import { parseArgs } from 'node:util';
import { loadPluginEnv } from '../lib/load-plugin-env.js';
import {
  CoachCaptureRefusal,
  mobileCommitArgs,
  resolveAceTestUsername,
  type HqUser,
  type OutreachPreview,
} from '../lib/coach-session-capture.js';

loadPluginEnv(import.meta.url);

const { values } = parseArgs({
  options: {
    preview: { type: 'string' },
    'hq-users': { type: 'string' },
    phone: { type: 'string' },
    out: { type: 'string' },
  },
});

try {
  if (!values.preview || !values['hq-users'] || !values.out) {
    throw new Error('--preview, --hq-users and --out are required');
  }
  const preview = JSON.parse(fs.readFileSync(values.preview, 'utf8')) as OutreachPreview;
  const raw = JSON.parse(fs.readFileSync(values['hq-users'], 'utf8'));
  const users = (Array.isArray(raw) ? raw : raw.users) as HqUser[];
  const phone = values.phone ?? process.env.ACE_E2E_PHONE ?? '';
  const aceTestUsername = resolveAceTestUsername(users, phone);
  const plan = mobileCommitArgs(preview, aceTestUsername);
  fs.writeFileSync(values.out, JSON.stringify({ ...plan, ace_test_username: aceTestUsername }, null, 2));
  console.log(JSON.stringify({ ok: true, deliver_to: aceTestUsername, worker: plan.start.workerKey, bot: plan.start.bot }));
} catch (e) {
  const refused = e instanceof CoachCaptureRefusal;
  console.error(`${refused ? 'REFUSED' : 'ERROR'}: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(refused ? 2 : 1);
}
