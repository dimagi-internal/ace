/**
 * Static QA checks for `solicitation-seed-responses-qa`.
 *
 * The artifact is ONE evidence bundle (YAML) the QA skill assembles from live
 * reads, not the roster alone: a roster can claim anything, so every check
 * that matters reads what labs actually holds (`list_responses`,
 * `get_solicitation`). `scripts/qa-run.ts` passes the artifact text only, so
 * the bundle carries its own context.
 *
 * Bundle shape (see SKILL.md § Process step 4):
 *
 *   solicitation: { id: <int>, is_public: <bool> }        # get_solicitation, live
 *   expected_count: <int>                                  # optional_steps.seed_responses.count
 *   mailbox: ace@dimagi-ai.com                             # config/agent.json email
 *   winner: { llo_entity_id: <labs slug>, connect_org_id: <int> }
 *   questions: [{ id, required }]                          # get_solicitation, live
 *   real_org_names: [...]
 *   deny_list: [...]
 *   roster: [{ key, response_id, org_name, intended_profile, flags: [...], winner: <bool> }]
 *   responses: [{ id, org_name, llo_entity_id, org_id, submitted_by_name,
 *                 submitted_by_email, responses: {qid: answer} }]   # list_responses, live
 *
 * Pure functions, no LLM. The library rules live in `lib/synthetic-responses.ts`
 * and are reused here, so the producer and its QA cannot drift apart.
 */

import { parse as parseYaml } from 'yaml';

import type { QACheck, QACheckResult } from '../../lib/qa-types';
import {
  findDenyListHits,
  findRealOrgCollision,
  foldName,
  stripSyntheticSuffix,
} from '../../lib/synthetic-responses';

interface RosterEntry {
  key: string;
  response_id: number;
  org_name: string;
  intended_profile?: string;
  flags?: string[];
  winner?: boolean;
}

interface LiveResponse {
  id: number;
  org_name?: string;
  llo_entity_id?: string;
  org_id?: string;
  submitted_by_name?: string;
  submitted_by_email?: string;
  responses?: Record<string, string>;
}

export interface SeedBundle {
  solicitation: { id: number; is_public: boolean };
  expected_count: number;
  mailbox: string;
  winner: { llo_entity_id: string; connect_org_id: number | string };
  questions: { id: string; required?: boolean }[];
  real_org_names: string[];
  deny_list: string[];
  roster: RosterEntry[];
  responses: LiveResponse[];
}

export function parseBundle(artifact: string): SeedBundle {
  const raw = parseYaml(artifact) as Partial<SeedBundle> | null;
  if (!raw || typeof raw !== 'object') throw new Error('evidence bundle is not a YAML mapping');
  return {
    solicitation: raw.solicitation ?? { id: 0, is_public: true },
    expected_count: Number(raw.expected_count ?? 0),
    mailbox: String(raw.mailbox ?? ''),
    winner: raw.winner ?? { llo_entity_id: '', connect_org_id: '' },
    questions: raw.questions ?? [],
    real_org_names: raw.real_org_names ?? [],
    deny_list: raw.deny_list ?? [],
    roster: raw.roster ?? [],
    responses: raw.responses ?? [],
  };
}

function withBundle(artifact: string, fn: (b: SeedBundle) => QACheckResult): QACheckResult {
  let b: SeedBundle;
  try {
    b = parseBundle(artifact);
  } catch (err) {
    return {
      pass: false,
      detail: `evidence bundle unreadable: ${(err as Error).message}`,
      auto_fix_hint: 'Re-assemble the evidence bundle per SKILL.md § Process step 4 from live list_responses + get_solicitation reads.',
    };
  }
  return fn(b);
}

function rosterResponses(b: SeedBundle): { entry: RosterEntry; live?: LiveResponse }[] {
  return b.roster.map((entry) => ({ entry, live: b.responses.find((r) => r.id === entry.response_id) }));
}

export function checkResponseCountMatches(artifact: string): QACheckResult {
  return withBundle(artifact, (b) => {
    const missing = rosterResponses(b).filter((x) => !x.live).map((x) => x.entry.response_id);
    if (b.roster.length !== b.expected_count || missing.length) {
      return {
        pass: false,
        detail: `roster has ${b.roster.length} of ${b.expected_count} expected; not found on labs: ${missing.join(', ') || 'none'}`,
        auto_fix_hint: 'Re-run solicitation-seed-responses; it skips respondents already on the call and creates the rest.',
      };
    }
    return { pass: true, detail: `${b.roster.length} responses, all present on labs` };
  });
}

export function checkRequiredAnswersPresent(artifact: string): QACheckResult {
  return withBundle(artifact, (b) => {
    const required = b.questions.filter((q) => q.required).map((q) => q.id);
    const problems: string[] = [];
    for (const { entry, live } of rosterResponses(b)) {
      if (!live) continue;
      const blank = required.filter((id) => !(live.responses?.[id] ?? '').trim());
      const flagged = (entry.flags ?? []).includes('missing_answer');
      if (flagged && !blank.length) problems.push(`${entry.key}: flagged missing_answer but answers every required question`);
      if (!flagged && blank.length) problems.push(`${entry.key}: unanswered ${blank.join(', ')}`);
    }
    return problems.length
      ? {
          pass: false,
          detail: problems.join('; '),
          auto_fix_hint: 'Fix the persona answers (only a missing_answer persona may leave a required question blank) and re-seed that respondent.',
        }
      : { pass: true };
  });
}

export function checkWinnerBoundToLloOrg(artifact: string): QACheckResult {
  return withBundle(artifact, (b) => {
    const winners = rosterResponses(b).filter((x) => x.entry.winner);
    if (winners.length !== 1) {
      return {
        pass: false,
        detail: `${winners.length} winner rows in the roster; exactly 1 required`,
        auto_fix_hint: 'Exactly one respondent is the ACE-owned winner (llo_org); fix the roster and re-seed.',
      };
    }
    const live = winners[0].live;
    const wantOrgId = String(b.winner.connect_org_id);
    if (!live || live.llo_entity_id !== b.winner.llo_entity_id || String(live.org_id ?? '') !== wantOrgId) {
      return {
        pass: false,
        detail: `winner response reads llo_entity_id=${live?.llo_entity_id ?? '∅'} org_id=${live?.org_id ?? '∅'}; want ${b.winner.llo_entity_id} / ${wantOrgId}`,
        auto_fix_hint:
          'Re-create the winner response with llo_entity_id = llo_org labs slug and org_id = its Connect integer id as a string (award_response.org_id needs it, spec § K1).',
      };
    }
    return { pass: true, detail: `winner ${live.id} bound to ${live.llo_entity_id} / Connect ${wantOrgId}` };
  });
}

export function checkNoRealOrgCollision(artifact: string): QACheckResult {
  return withBundle(artifact, (b) => {
    const winnerName = foldName(b.winner.llo_entity_id);
    const real = b.real_org_names.filter((n) => foldName(n) !== winnerName);
    const problems: string[] = [];
    for (const { entry, live } of rosterResponses(b)) {
      if (entry.winner) continue;
      const name = live?.org_name ?? entry.org_name;
      if (!/\s\[Synthetic\]$/.test(name)) problems.push(`${name}: no [Synthetic] suffix`);
      const hit = findRealOrgCollision(name, real);
      if (hit) problems.push(`${stripSyntheticSuffix(name)} matches real organisation ${hit}`);
    }
    return problems.length
      ? {
          pass: false,
          detail: problems.join('; '),
          auto_fix_hint: 'Rename the fictional respondent (keep the [Synthetic] suffix, avoid real names), re-seed it, and close the old response out of the review.',
        }
      : { pass: true };
  });
}

export function checkNoDenyListParty(artifact: string): QACheckResult {
  return withBundle(artifact, (b) => {
    const problems: string[] = [];
    for (const r of b.responses) {
      const texts = [r.org_name ?? '', r.submitted_by_name ?? '', ...Object.values(r.responses ?? {})];
      const hits = new Set(texts.flatMap((t) => findDenyListHits(t, b.deny_list)));
      if (hits.size) problems.push(`response ${r.id}: ${[...hits].join(', ')}`);
    }
    return problems.length
      ? {
          pass: false,
          detail: `LLO-facing text names a confidential party: ${problems.join('; ')}`,
          auto_fix_hint: 'Remove the named party from the persona text and re-seed; the deny list comes from the opp inputs.',
        }
      : { pass: true };
  });
}

export function checkSolicitationStillPrivate(artifact: string): QACheckResult {
  return withBundle(artifact, (b) =>
    b.solicitation.is_public === false
      ? { pass: true, detail: `solicitation ${b.solicitation.id} is_public: false` }
      : {
          pass: false,
          detail: `solicitation ${b.solicitation.id} reads is_public: ${String(b.solicitation.is_public)}`,
          auto_fix_hint:
            'Unlist it at once (update_solicitation is_public: false): synthetic responses must never sit on a listed call (spec § A2).',
        },
  );
}

export function checkSyntheticEmailsOnly(artifact: string): QACheckResult {
  return withBundle(artifact, (b) => {
    const at = b.mailbox.indexOf('@');
    const local = b.mailbox.slice(0, at).replace(/\+.*$/, '');
    const domain = b.mailbox.slice(at + 1).toLowerCase();
    const re = new RegExp(`^${local.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\+synthetic-\\d+@${domain.replace(/\./g, '\\.')}$`, 'i');
    const bad = rosterResponses(b)
      .filter(({ live }) => live && !re.test(live.submitted_by_email ?? ''))
      .map(({ live }) => `${live!.id}: ${live!.submitted_by_email ?? '∅'}`);
    return bad.length || at <= 0
      ? {
          pass: false,
          detail: at <= 0 ? 'no mailbox in bundle' : `non-ACE submitter addresses: ${bad.join('; ')}`,
          auto_fix_hint: 'Seed with ACE\'s own mailbox tagged +synthetic-<n> (lib/synthetic-responses syntheticEmail), never a made-up address.',
        }
      : { pass: true };
  });
}

export const CHECKS: QACheck[] = [
  { id: 'response_count_matches', type: 'static', description: 'Roster has the expected count and every response exists on labs', run: checkResponseCountMatches },
  { id: 'required_answers_present', type: 'static', description: 'Every required question answered, except a deliberate missing_answer persona', run: checkRequiredAnswersPresent },
  { id: 'winner_bound_to_llo_org', type: 'static', description: 'Exactly one winner, bound to llo_org by llo_entity_id and Connect org_id', run: checkWinnerBoundToLloOrg },
  { id: 'no_real_org_collision', type: 'static', description: 'Fictional names carry [Synthetic] and match no real organisation', run: checkNoRealOrgCollision },
  { id: 'no_deny_list_party', type: 'static', description: 'No response text names a party on the opp deny list', run: checkNoDenyListParty },
  { id: 'solicitation_still_private', type: 'static', description: 'The solicitation still reads is_public: false', run: checkSolicitationStillPrivate },
  { id: 'synthetic_emails_only', type: 'static', description: 'Every submitter address is ACE\'s mailbox tagged +synthetic-<n>', run: checkSyntheticEmailsOnly },
];
