import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { loadPlatformConstraints } from '../../lib/platform-constraints';

/**
 * A repeated `entity_id` is PAID AGAIN on Connect — prose must not say otherwise.
 *
 * ## The failure class (dimagi-internal/ace#2512, consolidating #2513)
 *
 * ACE's design guidance taught that Connect pays a repeated `entity_id` once:
 * `idea-to-pdd` said "a repeat of the same activity on the same entity
 * collapses to a single payment automatically", and `_app-component-library
 * § payability-scoped-key` said over-cap encounters "collide onto a key Connect
 * has already paid". PDDs then wrote "Connect pays each key once" and the Work
 * Order — the document a partner signs — copied it.
 *
 * Connect's source says otherwise whenever the opportunity's `duplicate`
 * verification flag is off, which is always on an ACE opportunity (the atom
 * refuses it, ace#1013; the form force-sets it False under automatic visit
 * verification). dimagi/commcare-connect `3c760f279`:
 *
 *   form_receiver/processor.py clean_form_submission:
 *     if user_visit.status == VisitValidationStatus.duplicate:
 *         if opportunity_flags.duplicate: flags.append([...])
 *         else: user_visit.status = VisitValidationStatus.pending
 *   ... then auto_approve_visits and pending and not flagged -> approved
 *   opportunity/models.py CompletedWork.payment_accrued:
 *     """... Includes duplicates"""  return self.approved_count * amount
 *
 * Found on spark-facilitator/20260926-1413 by both the PDD eval and the Work
 * Order eval. Canonical write-up: playbook/integrations/connect-api.md
 * § A repeated `entity_id` is PAID AGAIN.
 *
 * ## What this test holds
 *
 * No skill, template, agent or playbook prose may re-assert the false premise.
 * A line that QUOTES the false phrase in order to forbid it is allowed when it
 * cites ace#2512 within two lines. Dated change-log rows are records of what
 * was believed at the time and are skipped.
 */

const REPO_ROOT = join(__dirname, '..', '..');
// `config` joined in ace#3140: the platform-constraints rule
// `repeat-visit-same-entity-is-duplicate` taught the paid-once premise from a
// config file this scan never read, and its finding is copied into decision
// rows verbatim (bednet-check-2-visit/20261018-0554).
const SCAN_ROOTS = ['skills', 'templates', 'agents', 'playbook', 'config'];

const BANNED: { id: string; re: RegExp; control: string }[] = [
  {
    id: 'collapses-to-single-payment',
    re: /collapses?\s+(?:in)?to\s+(?:a\s+)?single\s+payment/i,
    control: 'the same entity collapses to a single payment automatically.',
  },
  {
    id: 'collide-onto-already-paid',
    re: /collide[sd]?\s+onto\s+(?:a\s+key|one)\s+(?:Connect\s+has\s+)?already\s+paid/i,
    control: 'the over-cap encounters collide onto a key Connect has already paid. The',
  },
  {
    id: 'enforced-by-dedup',
    re: /(?:cap|limit)[^.]{0,40}\benforced\s+by\s+de-?duplication/i,
    control: 'per-entity cap is enforced by DEDUPLICATION, not by the app refusing a',
  },
  {
    id: 'pays-each-key-once',
    re: /pays?\s+each\s+[^.|]{0,40}?\b(?:key|slot|entity)\b[^.|]{0,30}?\bonce\b/i,
    control: 'Connect pays each de-duplication key once.',
  },
  // ace#3140 — the phrasings the platform-constraints rule used.
  {
    id: 'only-first-visit-paid',
    re: /only\s+(?:the\s+)?first\s+visit\s+(?:per|to|on)\s+(?:each\s+|an?\s+|the\s+)?[\w-]+\s+is\s+paid/i,
    control: '(e.g. "participant id + scheduled month"), or state that only the first visit per entity is paid.',
  },
  {
    id: 'repeat-marked-duplicate',
    re: /marks?\s+(?:a\s+)?(?:second|repeat(?:ed)?)\s+visit\b[^.]{0,120}?\bas\s+a\s+duplicate/i,
    control: 'Connect marks a second visit by the same worker to the same entity id for the same deliver unit as a duplicate, so',
  },
  {
    id: 'key-avoids-duplicate-mark',
    re: /does\s+not\s+mark\s+it\s+(?:as\s+)?a\s+duplicate/i,
    control: 'such as the month or the visit number, so the platform does not mark it a duplicate.',
  },
];

const CHANGELOG_ROW = /^\|\s*20\d\d-\d\d-\d\d\s*\|/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'assets') continue;
      walk(full, out);
    } else if (/\.(md|ya?ml)$/i.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function violations(text: string): { line: number; id: string; text: string }[] {
  const lines = text.split('\n');
  const found: { line: number; id: string; text: string }[] = [];
  lines.forEach((ln, i) => {
    if (CHANGELOG_ROW.test(ln)) return;
    const window = lines.slice(Math.max(0, i - 2), i + 3).join('\n');
    if (/ace#2512/.test(window)) return;
    for (const b of BANNED) {
      if (b.re.test(ln)) found.push({ line: i + 1, id: b.id, text: ln.trim().slice(0, 160) });
    }
  });
  return found;
}

describe('repeated entity_id is paid again (ace#2512)', () => {
  it('each banned pattern matches the verbatim false claim it guards (negative controls)', () => {
    for (const b of BANNED) {
      expect(b.re.test(b.control), b.id).toBe(true);
      expect(violations(b.control).map((v) => v.id)).toContain(b.id);
    }
  });

  it('a quoted false phrase citing ace#2512 is allowed; a changelog row is skipped', () => {
    expect(violations('never write "Connect pays each key once" (ace#2512)')).toEqual([]);
    expect(violations('| 2026-09-17 | the per-entity cap is enforced by deduplication | ACE team |')).toEqual([]);
  });

  it('corrected wording does not trip the guard (positive controls)', () => {
    expect(violations('`entity_id` groups visits onto one CompletedWork row per entity.')).toEqual([]);
    expect(violations('the over-cap encounters land on an existing CompletedWork.')).toEqual([]);
  });

  it('no skill / template / agent / playbook prose asserts a repeated key is paid once', () => {
    const hits: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of walk(join(REPO_ROOT, root))) {
        for (const v of violations(readFileSync(file, 'utf8'))) {
          hits.push(`${relative(REPO_ROOT, file)}:${v.line} [${v.id}] ${v.text}`);
        }
      }
    }
    expect(hits, hits.join('\n')).toEqual([]);
  });

  it('no platform-constraints rule asserts it in any field a decision row copies (folded YAML, ace#3140)', () => {
    // The line scan above cannot see a claim a YAML folded scalar wraps across
    // lines; the parsed rule fields are what reach decision rows verbatim.
    const hits: string[] = [];
    for (const r of loadPlatformConstraints().rules) {
      const fields: [string, string][] = [
        ['fact', r.fact],
        ['question', r.question],
        ['plain_question', r.plain_question],
        ['plain', r.plain],
        ['remedy', r.remedy],
        ...r.options.map((o, i): [string, string] => [`options[${i}]`, o]),
      ];
      for (const [field, text] of fields) {
        const flat = text.replace(/\s+/g, ' ');
        if (/ace#2512/.test(flat)) continue;
        for (const b of BANNED) if (b.re.test(flat)) hits.push(`${r.id}.${field} [${b.id}] ${flat.slice(0, 160)}`);
      }
    }
    expect(hits, hits.join('\n')).toEqual([]);
  });

  it('the repeat-visit rule states the paid-again fact and cites the pending reset', () => {
    const rule = loadPlatformConstraints().rules.find((r) => r.id === 'repeat-visit-same-entity-is-duplicate');
    expect(rule).toBeDefined();
    expect(rule!.fact).toMatch(/paid again/i);
    expect(rule!.plain).toMatch(/pays a repeat visit .* again/i);
    expect(rule!.source.some((s) => /form_receiver\/processor\.py:347-351$/.test(s))).toBe(true);
  });

  it('the canonical Connect write-up exists and cites its upstream source', () => {
    const doc = readFileSync(join(REPO_ROOT, 'playbook/integrations/connect-api.md'), 'utf8');
    expect(doc).toMatch(/### A repeated `entity_id` is PAID AGAIN/);
    for (const cite of ['ace#2512', 'clean_form_submission', 'payment_accrued', 'Includes duplicates', 'max_daily']) {
      expect(doc, cite).toContain(cite);
    }
  });

  it('the cap-bearing skills route the cap through a Connect-side payable_slot rule', () => {
    for (const p of [
      'skills/_app-component-library.md',
      'skills/connect-opp-setup/SKILL.md',
      'skills/pdd-to-deliver-app/SKILL.md',
      'skills/idea-to-pdd/SKILL.md',
    ]) {
      const s = readFileSync(join(REPO_ROOT, p), 'utf8');
      expect(s, p).toContain('payable_slot');
      expect(s, p).toContain('ace#2512');
    }
  });
});
