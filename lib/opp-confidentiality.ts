/**
 * Is this opp confidential, and how are its design documents shared?
 * (dimagi-internal/ace#3191)
 *
 * ## The one signal
 *
 * An opp is CONFIDENTIAL when its `inputs/confidentiality.yaml` EXISTS. That
 * file is already the opp's confidentiality contract — it carries the
 * `llo_facing_deny_list` the LLO-facing QA checks read (`lib/llo-facing-deny-list.ts`)
 * — so it is the cheapest thing both design-doc producers can read and the one
 * place an operator already writes "this opp has something to hide".
 *
 * Why presence and not a flag inside it: the PDD is INTERNAL and legitimately
 * names the parties the deny list protects (connect-fi/20261018-1440's PDD names
 * the funder its deny list hides from LLOs). An anyone-with-link PDD on such an
 * opp hands that name to whoever the URL reaches, and ace-web's public
 * run-summary page links the PDD. So any opp with a confidentiality file is an
 * opp whose design docs must not be link-shared; a second flag that could
 * disagree with the file's existence would only add a way to get it wrong.
 *
 * Not used as the signal: `run_state.optional_steps.private_solicitation`. It is
 * per-RUN and says how the solicitation is published, not whether the opp's
 * documents may be public — a private call on a public program is legitimate.
 *
 * ## Named reviewers
 *
 * The file may list the people who review this opp's design documents:
 *
 *   reviewers:
 *     - jane@example.org
 *
 * On a confidential opp they are shared individually (`drive_share_with_person`,
 * `commenter`, no Drive notification email). With no reviewers listed the docs
 * stay unshared (the ACE Shared Drive's own members can still open them).
 *
 * ## What this does NOT govern
 *
 * Output-preview PNGs (`skills/output-preview-capture`) stay anyone-with-link
 * `reader` on every opp, confidential or not: ace-web renders them, and the
 * owner confirmed 2026-10-20 that previews must stay available there.
 */
import { parse as parseYaml } from 'yaml';

export type DesignDocShareMode = 'anyone-with-link' | 'named-reviewers' | 'unshared';

export interface DesignDocSharePlan {
  confidential: boolean;
  mode: DesignDocShareMode;
  /** Always `commenter`: the design docs exist to be argued with (ace#1843). */
  role: 'commenter';
  /** Emails to share with, for `named-reviewers`; empty otherwise. */
  reviewers: string[];
  /** One sentence for run_state / the decision row. */
  reason: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * `confText` is the text of `inputs/confidentiality.yaml`, or `null` /
 * `undefined` when the opp has no such file. An EMPTY file still exists and so
 * still marks the opp confidential.
 */
export function isConfidentialOpp(confText: string | null | undefined): boolean {
  return confText != null;
}

/** The `reviewers:` list. Absent → `[]`. A malformed file or entry throws. */
export function parseConfidentialityReviewers(confText: string | null | undefined): string[] {
  if (confText == null || confText.trim() === '') return [];
  const doc = parseYaml(confText.replace(/^﻿/, '')) as unknown;
  if (doc == null) return [];
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('confidentiality.yaml must be a mapping');
  }
  const raw = (doc as Record<string, unknown>).reviewers;
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error('confidentiality.yaml reviewers: must be a list of emails');
  const out: string[] = [];
  for (const r of raw) {
    const e = typeof r === 'string' ? r.trim() : '';
    if (!EMAIL.test(e)) throw new Error(`confidentiality.yaml reviewers: "${String(r)}" is not an email`);
    if (!out.includes(e.toLowerCase())) out.push(e.toLowerCase());
  }
  return out;
}

/** How `idea-to-pdd` (step 6c) and `pdd-to-work-order` (step 5b) share what they create. */
export function designDocSharePlan(confText: string | null | undefined): DesignDocSharePlan {
  if (!isConfidentialOpp(confText)) {
    return {
      confidential: false,
      mode: 'anyone-with-link',
      role: 'commenter',
      reviewers: [],
      reason: 'no inputs/confidentiality.yaml: shared anyone-with-link, commenter (ace#1843)',
    };
  }
  const reviewers = parseConfidentialityReviewers(confText);
  if (reviewers.length > 0) {
    return {
      confidential: true,
      mode: 'named-reviewers',
      role: 'commenter',
      reviewers,
      reason: `confidential opp (inputs/confidentiality.yaml): shared with ${reviewers.length} named reviewer(s), never anyone-with-link (ace#3191)`,
    };
  }
  return {
    confidential: true,
    mode: 'unshared',
    role: 'commenter',
    reviewers: [],
    reason: 'confidential opp (inputs/confidentiality.yaml) with no reviewers: listed: left unshared, never anyone-with-link (ace#3191)',
  };
}
