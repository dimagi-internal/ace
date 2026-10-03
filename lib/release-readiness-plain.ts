//
// Plain-language release-readiness findings.
//
// A release-readiness finding was written for ACE: on spark/spark-facilitator/
// 20261001-2208 the verdict ace-web showed a reviewer read
//
//   blocker  run-surface-audit-eval incomplete (pass band ≥ 7)
//   warning  4 link(s) on this page require MEMBERSHIP … (apps[0].hq_url,
//            apps[1].hq_url, connect.opportunity.url, assistant.ocs_url)
//            fix: pass --reviewer <email> per person (plus --memberships) …
//
// — two items, one cause (the review-page check stops at its first misleading
// finding, and the misleading finding is the missing reviewer list), in
// skill names and payload paths. This module adds what a person reads:
//
//   - `summary`: what is wrong, in one sentence, no ACE internals;
//   - `action`:  what to do, addressed to whoever releases the run;
//   - `merged`:  the ids of findings folded into this one because they share
//                its root cause.
//
// The existing `detail` / `fix` stay, for the build team and for every
// consumer that already reads them; ace-web prefers `summary` / `action`.
//
// Pure.

import { plainText } from './decision-review.js';
import type { ReleaseFinding } from './release-readiness.js';

/** What a producing skill IS, to an outside reader. */
const PRODUCT: Array<[RegExp, string]> = [
  [/^run-surface-audit/, 'the review page'],
  [/^connect-opp-setup|^connect-/, 'the Connect opportunity'],
  [/^connect-program-setup/, 'the Connect programme'],
  [/^ocs-/, 'the support chatbot'],
  [/^app-release/, 'the released apps'],
  [/^app-/, 'the apps'],
  [/^pdd-to-learn-app/, 'the Learn (training) app'],
  [/^pdd-to-deliver-app/, 'the Deliver (field) app'],
  [/^idea-to-pdd/, 'the programme design'],
  [/^pdd-to-work-order/, 'the work order'],
  [/^training-/, 'the training materials'],
  [/^solicitation-/, 'the call for implementing organisations'],
  [/^output-preview-capture/, 'the output previews'],
  [/^decisions-/, 'the decisions log'],
];

export function productLabel(skill: string): string {
  const s = skill.replace(/-(?:qa|eval)$/, '');
  for (const [re, label] of PRODUCT) if (re.test(s)) return label;
  return `the ${s.replace(/-/g, ' ')} output`;
}

const LINK_LABEL: Array<[RegExp, string]> = [
  [/^apps\[\d+\]\.hq_url$/, 'HQ app'],
  [/^connect\.opportunity\.url$/, 'the Connect opportunity'],
  [/^connect\.program\.url$/, 'the Connect programme'],
  [/^assistant\.ocs_url$/, 'the chatbot console'],
];

const NUMBER = ['zero', 'one', 'two', 'three', 'four', 'five', 'six'];

/** `apps[0].hq_url, apps[1].hq_url, connect.opportunity.url` → "the two HQ apps and the Connect opportunity". */
export function linkList(where: string): string {
  const labels = where.split(/,\s*/).map((w) => LINK_LABEL.find(([re]) => re.test(w.trim()))?.[1] ?? 'a member-only link');
  const apps = labels.filter((l) => l === 'HQ app').length;
  const rest = [...new Set(labels.filter((l) => l !== 'HQ app'))];
  const parts = [
    ...(apps === 1 ? ['the HQ app'] : apps > 1 ? [`the ${NUMBER[apps] ?? apps} HQ apps`] : []),
    ...rest,
  ];
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function titleCase(slug: string): string {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export interface PlainContext {
  /** ace-web workspace slug (the partner): `spark` → "Spark". */
  workspace: string;
}

/** `summary` + `action` for one finding. Never throws; falls back to cleaned detail/fix. */
export function plainFinding(f: ReleaseFinding, ctx: PlainContext): { summary: string; action: string } {
  const id = f.id;
  const label = productLabel(f.owner);
  const who = titleCase(ctx.workspace);
  const surface = /^surface:([A-Z-]+):(.*)$/.exec(id);
  if (surface && surface[1] === 'REVIEWERS-UNDECLARED') {
    const links = linkList(surface[2]);
    return {
      summary: `Nobody has checked that the ${who} reviewers can open the member-only links on the review page (${links}).`,
      action: `Name the ${who} reviewers — we'll check they can open ${links}.`,
    };
  }
  if (/^eval-below-band:/.test(id)) {
    const incomplete = /\bincomplete\b/.test(f.detail);
    return incomplete
      ? { summary: `The quality review of ${label} could not finish.`, action: `Clear what stopped it (listed with this item), then run the review of ${label} again.` }
      : { summary: `The quality review of ${label} scored below its pass mark.`, action: `Fix ${label} as the review says, then run the review again.` };
  }
  if (/^(?:eval|qa)-stale:/.test(id)) return { summary: `${cap(label)} changed after it was checked.`, action: `Run the check on ${label} again.` };
  if (/^(?:eval|qa)-missing:/.test(id)) return { summary: `${cap(label)} was never checked.`, action: `Run the check on ${label}.` };
  if (/^qa-fail:/.test(id)) return { summary: `A built-in check on ${label} failed.`, action: `Fix ${label} as the check says, then run it again.` };
  if (/^(?:qa-malformed|eval-unreadable):/.test(id)) return { summary: `The check result for ${label} cannot be read.`, action: `Run the check on ${label} again.` };
  if (id === 'connect-verification_rules_persisted') {
    return {
      summary: 'Connect did not save the payment rules on this opportunity, so it would pay records the rules should exclude.',
      action: "Set the payment rules on the implementing organisation's own opportunity at launch, or have Connect changed so this one can hold them.",
    };
  }
  if (/^connect-/.test(id)) return { summary: `The Connect opportunity is not set up as designed: ${plainText(f.detail)}.`, action: 'Re-run the Connect opportunity setup and check it again.' };
  if (/^preview-gap:/.test(id)) return { summary: 'A run output has no preview on the review page.', action: 'Capture a preview for it.' };
  if (/^preview-bad-frame:/.test(id)) return { summary: 'A preview on the review page shows the wrong thing.', action: 'Capture that preview again and look at it.' };
  if (/^link:/.test(id)) return { summary: `A link on the review page does not open for the people it is meant for.`, action: 'Fix the link, or stop presenting it to them.' };
  if (/^chatbot-/.test(id)) return { summary: 'The support chatbot has not been shown to answer a question recently.', action: 'Ask it a test question and record the answer.' };
  if (/^app-unreleased:/.test(id)) return { summary: `The ${id.split(':')[1]} app has no released version.`, action: 'Release the app.' };
  if (id === 'app-release-qa-missing') return { summary: 'The released apps were never shown to install.', action: 'Run the install check on the released apps.' };
  if (/^hq-plan-free:/.test(id)) return { summary: "The apps' HQ project space is on the free plan, so its data connection is closed.", action: 'Ask an HQ superuser to move the project space to a paid plan (steps below).' };
  if (id === 'claims-not-all-met') return { summary: "Some of the run's stated results were not met, and the review page must say so plainly.", action: 'Make sure every unmet result carries a plain sentence on the review page.' };
  return { summary: sentence(plainText(f.detail)), action: sentence(plainText(f.fix.split('\n')[0])) };
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function sentence(s: string): string {
  const t = cap(s.trim());
  return /[.?!]$/.test(t) ? t : `${t}.`;
}

/**
 * Fold findings that share one root cause into one item.
 *
 * - `run-surface-audit-eval` stops with `incomplete` whenever the audit has a
 *   broken or misleading finding (skills/run-surface-audit-eval § Process 1),
 *   so its "below band" blocker IS those findings. The blocker is folded into
 *   them and they carry its severity — the verdict stays NOT READY for the
 *   same reason, stated once.
 *
 * Readiness never changes: a fold keeps the highest severity.
 */
export function collapseSharedCauses(findings: readonly ReleaseFinding[]): ReleaseFinding[] {
  let out = findings.map((f) => ({ ...f }));
  // No reviewers named (validate-release-readiness `reviewers-missing`) IS why
  // the review page reports its member-only links unchecked — one cause.
  const missing = out.find((f) => f.id === 'reviewers-missing');
  if (missing) {
    const folded = out.filter((f) => /^surface:REVIEWERS-UNDECLARED:/.test(f.id));
    if (folded.length) {
      missing.merged = [...(missing.merged ?? []), ...folded.map((f) => f.id)];
      out = out.filter((f) => !folded.includes(f));
    }
  }
  const evalIdx = out.findIndex((f) => /^eval-below-band:run-surface-audit-eval/.test(f.id) && /\bincomplete\b/.test(f.detail));
  const surface = out.filter((f) => /^surface:/.test(f.id));
  if (evalIdx >= 0 && surface.length > 0) {
    const [ev] = out.splice(evalIdx, 1);
    for (const s of surface) {
      if (ev.severity === 'blocker') s.severity = 'blocker';
      s.merged = [...(s.merged ?? []), ev.id];
      s.detail = `${s.detail} — and until it is fixed, ${ev.detail}`;
    }
  }
  return out;
}
