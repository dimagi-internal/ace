import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { validatePhaseProductsFragment } from '../../lib/phase-products-schema.js';
import { buildOcsPublicChatUrl } from '../../lib/ocs-public-chat-url.js';

const ROOT = join(__dirname, '..', '..');
const SKILL = join(ROOT, 'skills', 'ocs-agent-setup', 'SKILL.md');

/**
 * The support assistant is the ONE artifact of an ACE run an outside reviewer
 * can use without being granted anything — and until ace#1839 the typed
 * handoff carried only `admin_url`, the OCS console, which redirects an
 * outsider to `/accounts/login/`.
 *
 * The failure was not ignorance. `lib/ocs-public-chat-url.ts` has built the
 * anonymous URL since ace#1021, `ocs-widget-handoff-eval` already gates 25% of
 * its score on it, and `ocs-agent-setup` even said "also emit the PUBLIC chat
 * URL" in prose. What it never said was WHERE — the write-back YAML block
 * beside that paragraph listed `admin_url` and stopped. Prose is not a
 * contract, and the contract is what downstream readers read: ace-web's
 * run-summary serializer had nothing but the console to render, under a
 * heading inviting an anonymous reader to ask questions (ace#1839).
 *
 * Verified live 2026-09-06 on hh-poverty-targeting/20260828-0702:
 *   console: 200 -> https://www.openchatstudio.com/accounts/login/?next=/a/connect-ace/chatbots/13029/
 *   public:  200,  an 11,755-byte live chat page
 *
 * This test is the tripwire on both halves: the schema must ACCEPT the key,
 * and the sole writer must be TOLD to write it.
 */
describe('ocs-agent-setup produces the public chat URL (ace#1839)', () => {
  const skill = readFileSync(SKILL, 'utf8');

  it('the typed write-back block declares public_url, not only the prose', () => {
    // Scoped to the YAML block itself. A mention anywhere in 900 lines is
    // exactly what shipped and was not enough.
    const start = skill.indexOf('ocs_chatbot:');
    expect(start).toBeGreaterThan(-1);
    const block = skill.slice(start, start + 800);
    expect(block).toMatch(/^\s*public_url:/m);
    expect(block).toMatch(/^\s*admin_url:/m);
  });

  it('tells the author to build it with the helper rather than by hand', () => {
    expect(skill).toMatch(/buildOcsPublicChatUrl/);
  });

  it('the phase-products schema TYPE-CHECKS public_url, rather than merely tolerating it', () => {
    // `ocs_chatbot` is `.passthrough()`, so "does it accept the key" is
    // trivially true for EVERY key and proves nothing — that mutant survived
    // the first cut of this test. A DECLARED key is type-checked; an undeclared
    // one rides through untouched. So the load-bearing assertion is the
    // negative: a `public_url` that is not a URL must be rejected.
    const good = validatePhaseProductsFragment('ocs-setup', {
      ocs_chatbot: {
        experiment_id: 13029,
        public_id: '2c8d5f93-8e4f-4fde-9bf8-650909255c30',
        team_slug: 'connect-ace',
        admin_url: 'https://www.openchatstudio.com/a/connect-ace/chatbots/13029/',
        public_url: buildOcsPublicChatUrl({
          teamSlug: 'connect-ace',
          publicId: '2c8d5f93-8e4f-4fde-9bf8-650909255c30',
        }),
      },
    });
    expect(good.issues).toEqual([]);
    expect(good.valid).toBe(true);

    const bad = validatePhaseProductsFragment('ocs-setup', {
      ocs_chatbot: { public_url: '/a/connect-ace/chatbots/pid/start/' },
    });
    expect(bad.valid).toBe(false);
    expect(bad.issues.map((i) => i.path)).toContain('products.ocs_chatbot.public_url');
  });

  it('the helper still produces the anonymous `start/` route the page needs', () => {
    // Pinned here as well as in the helper's own suite: this is the exact
    // string the write-back contract above promises to carry, and a change to
    // the route shape must break the producer contract, not just the builder.
    expect(
      buildOcsPublicChatUrl({ teamSlug: 'connect-ace', publicId: '2c8d5f93-8e4f-4fde-9bf8-650909255c30' }),
    ).toBe('https://www.openchatstudio.com/a/connect-ace/chatbots/2c8d5f93-8e4f-4fde-9bf8-650909255c30/start/');
  });
});
