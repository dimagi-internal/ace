/**
 * Pure logic behind `scripts/audit-run-surface.ts` — the audit of ACE's
 * EXTERNAL REVIEW SURFACE (the public run-summary page an outside partner is
 * sent to).
 *
 * Everything here is a pure function over a fetched payload / an HTTP result /
 * a rendered-DOM report, so every rule below is unit-testable with no network
 * and no browser (`test/lib/run-surface-audit.test.ts`).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * On 2026-08-14 the first ACE run ever shown to an external party
 * (`spark-facilitator/20260813-2126`) was found — by hand, by eye, over a full
 * day — to be badly broken on twelve counts, while EVERY automated check we
 * had reported green. `scripts/check-summary-links.py` printed
 * `12 links · 0 BROKEN` and exited 0 on a page whose eight reviewer-facing
 * Google Docs all 401'd anonymously, whose footer link was a hard 404, and
 * which told the reader that walkthroughs and dashboards were "Not created"
 * while both existed.
 *
 * This module supersedes that checker. The twelve defects are its regression
 * corpus; every rule below names the one it exists to catch.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE RULE THAT GOVERNS THE WHOLE MODULE
 *
 * **A check that cannot see the thing it checks is worse than no check.**
 *
 * The single most expensive failure in that day was not on the page at all —
 * it was an agent "verifying" open questions by counting a payload key named
 * `questions` when the field is `items`. It reported 0 forever and nearly sent
 * someone to fix a working feature. `collect_urls` filtering on
 * `startswith("http")` is the same bug wearing a different hat: every relative
 * URL was invisible, so the footer 404 was structurally uncheckable.
 *
 * So this auditor is REQUIRED to fail loudly when its own assumptions about the
 * payload shape are wrong. It declares, up front, every section and every key
 * it reads (`SURFACE_CONTRACT`). A section it does not know about, a section it
 * expects that is absent, and a populated section missing the key it reads are
 * all BLOCKING findings — never a silent zero. `ace-web`'s
 * `apps/opps/tests/test_public_surface_contract.py` freezes the other half of
 * the same contract, so a rename fails CI there and fails the audit here.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SEVERITY — three tiers, and the middle one is where the real damage was
 *
 * - `broken`      — a reviewer hits a wall (404, a doc they cannot open).
 * - `misleading`  — the page states something untrue ("Not created" when it
 *                   was created; an untagged link that reads as broken; a
 *                   private review republished). **Today's worst defects were
 *                   all in this tier**, which is exactly why a link checker
 *                   that only knows "reachable / not reachable" certified them.
 * - `improvement` — it would confuse or underserve them, but nothing is false.
 *
 * `broken` and `misleading` block sharing. `improvement` reports only.
 */

// ── Finding model ──────────────────────────────────────────────────

export type AuditSeverity = 'broken' | 'misleading' | 'improvement';

/** Severities that block "safe to share". */
export const BLOCKING_SEVERITIES: readonly AuditSeverity[] = ['broken', 'misleading'];

export interface Finding {
  /** Stable machine code, e.g. `LINK-PRIVATE-DELIVERABLE`. */
  code: string;
  severity: AuditSeverity;
  /** Payload path / URL / DOM selector the finding is about. */
  where: string;
  /** What is wrong, in the reviewer's terms. */
  detail: string;
  /** What to do about it. Every finding must name a fix. */
  fix: string;
  /** Which of the twelve 2026-08-14 defects this rule exists to catch. */
  defect?: string;
}

export function isBlocking(f: Finding): boolean {
  return BLOCKING_SEVERITIES.includes(f.severity);
}

// ── The declared payload contract ──────────────────────────────────

/**
 * A section of the public summary payload, and the keys THIS AUDITOR READS.
 *
 * `keys` is not "every key ace-web sends" — it is the auditor's own dependency
 * list. If a key here is missing from a populated section, the auditor cannot
 * do its job on that section, and it says so instead of reporting zero.
 *
 * `kind`:
 *   - `object`  — a single dict, or null when the run hasn't reached it
 *   - `list`    — a list of dicts
 *   - `scalar`  — a dict of plain values (no links to check)
 *
 * `linkKeys` are the keys whose values are URLs an outsider will click.
 * `reviewerFacing` marks the sections an external partner is actually here to
 * read — those are the ones whose ABSENCE is a finding (defect 6: the PDD and
 * Work Order were missing from the page entirely, and nothing noticed, because
 * "absent" and "the run hasn't got there yet" look identical).
 */
export interface SectionContract {
  kind: 'object' | 'list' | 'scalar';
  keys: readonly string[];
  linkKeys?: readonly string[];
  /** Keys on nested member objects (for `list` sections and known sub-objects). */
  itemKeys?: readonly string[];
  reviewerFacing?: boolean;
  note?: string;
}

/**
 * Every top-level section of the payload, frozen.
 *
 * Mirror of `ace-web` `apps/opps/summary.py :: build_summary_payload`, frozen
 * on 2026-08-14 and gated on that side by
 * `apps/opps/tests/test_public_surface_contract.py`. An unknown key here is a
 * BLOCKING finding, not a shrug: ace-web grew a section this auditor has never
 * looked at, and certifying a page containing an unaudited section is the exact
 * false assurance this module exists to prevent.
 */
export const SURFACE_CONTRACT: Readonly<Record<string, SectionContract>> = {
  opp: {
    kind: 'object',
    keys: ['workspace_slug', 'slug', 'run_id', 'display_name', 'description', 'status'],
  },
  design: {
    kind: 'object',
    keys: ['docs'],
    itemKeys: ['title', 'url', 'access'],
    linkKeys: ['url'],
    reviewerFacing: true,
    note: 'PDD + Work Order — the artifacts a partner is best placed to critique',
  },
  apps: {
    kind: 'list',
    keys: [],
    itemKeys: ['kind', 'name', 'hq_url', 'access'],
    linkKeys: ['hq_url'],
  },
  // The producing phase's own verdict on `apps` — `null` when Phase 3
  // finished clean. Added with ace#1867 / ace-web#744, where a `partial`
  // Phase 3 rendered identically to a clean one: the run recorded
  // `status: partial` and a FAILED `entity_state_fidelity` gate (the
  // PAYMENT-KEY gate) and the COMMCARE APPS section carried no status at
  // all, so the page's only vocabulary was "done" vs "not started yet".
  // No links — this section is words about the apps above.
  build: {
    kind: 'object',
    keys: ['status', 'verdict', 'note', 'failing_checks', 'carried_blockers'],
  },
  connect: { kind: 'object', keys: ['opportunity'], linkKeys: ['url'] },
  training: {
    kind: 'object',
    keys: ['deck', 'docs'],
    itemKeys: ['title', 'url', 'access'],
    linkKeys: ['url'],
    reviewerFacing: true,
  },
  assistant: { kind: 'object', keys: ['ocs_url', 'access', 'public_id', 'embed_key'], linkKeys: ['ocs_url'] },
  walkthroughs: {
    kind: 'list',
    keys: [],
    // NOTE the key names. The page said "Not created" for every walkthrough and
    // every dashboard while both existed, because the reader looked for
    // `url`/`title` where the run_state data had `par_url`/`key` nested under
    // `synthetic.source` (defect 5). Both halves are frozen now.
    itemKeys: ['persona', 'url', 'availability'],
    linkKeys: ['url'],
    reviewerFacing: true,
  },
  dashboards: {
    kind: 'list',
    keys: [],
    itemKeys: ['title', 'url', 'access'],
    linkKeys: ['url'],
    reviewerFacing: true,
  },
  // What `dashboards` and `walkthroughs` above are showing numbers OF.
  // Phase 7 GENERATES its dataset and the page never said so: on
  // spark-facilitator/20260828-0703 two dashboards charted 223 invented
  // visit records attributed to 12 invented facilitators, with named
  // personas and three planted anomalies, and an outsider read every one
  // of them as an observation (ace#1867). `null` when the run generated
  // nothing — a run with no synthetic data must not be labelled either.
  synthetic: {
    kind: 'object',
    keys: [
      'is_synthetic', 'provider', 'labs_opp_id', 'visits',
      'completed_works', 'cohort_size', 'cohort_population',
    ],
  },
  selected_llo: { kind: 'object', keys: [] },
  solicitation: { kind: 'object', keys: ['url', 'deadline', 'status', 'access'], linkKeys: ['url'] },
  launch: { kind: 'object', keys: [] },
  cycle_grade: { kind: 'object', keys: [] },
  // The `/ace:qa-deep` verdicts, or `null` when that gate never ran — which is
  // the common case, since deep QA is out-of-band and not part of `/ace:run`.
  // Shipped by ace-web#746 (merged 2026-09-01) and caught here the same day by
  // CONTRACT-UNKNOWN-SECTION, which is the check working as designed: ace-web
  // grew a section and this auditor had never looked at it.
  // Shape, from ace-web `summary.py :: _read_deep_qa` / `_deep_qa_stage`:
  //   null, or { stages: [ { stage, label, ran, ran_at, gate, verdict, score,
  //   threshold, counts{total,pass,warn,fail}, dimensions[], findings[],
  //   items[], freshness[], is_stale } ] }
  // `keys: []` matches the other nullable sections above (launch, cycle_grade,
  // opp_eval, selected_llo): the per-stage shape is recorded here rather than
  // declared, because a declared key on a null section reads as missing.
  deep_qa: {
    kind: 'object',
    keys: [],
    itemKeys: [
      'stage', 'label', 'ran', 'ran_at', 'gate', 'verdict', 'score',
      'threshold', 'counts', 'dimensions', 'findings', 'items',
      'freshness', 'is_stale',
    ],
    note: 'deep-QA gate verdicts; null when /ace:qa-deep never ran for this run',
  },
  opp_eval: { kind: 'object', keys: [] },
  learnings: { kind: 'object', keys: [], linkKeys: ['url'] },
  open_questions: {
    kind: 'object',
    // `items`. NOT `questions`. This is the cautionary tale in the module
    // header, encoded: an auditor that counted `questions` reported 0 forever.
    keys: ['url', 'access', 'items'],
    // The row shape, frozen too. `title` is here because it was EMPTY on
    // 27 of 28 rows of spark-facilitator/20260828-0703 and every one
    // rendered as a run-on `id: … question: …` blob; `blocking` because
    // the ledger always carried when a question is needed by and the page
    // discarded it (ace#1867). A key-name drift here renders as absence.
    itemKeys: ['title', 'detail', 'owner', 'answered_in', 'blocking'],
    linkKeys: ['url'],
  },
  stage: { kind: 'scalar', keys: ['label', 'pending_sections'] },
  feedback: {
    kind: 'list',
    keys: [],
    itemKeys: ['title', 'url', 'access'],
    linkKeys: ['url'],
    note: 'reviewer feedback ledgers — a PRIVATE one must never appear anonymously',
  },
  decisions: { kind: 'object', keys: ['total', 'counts', 'rows'] },
  reactions: { kind: 'scalar', keys: [] },
  decision_edits: { kind: 'scalar', keys: [] },
  workbench: { kind: 'object', keys: ['url', 'access'], linkKeys: ['url'] },
  viewer: { kind: 'scalar', keys: ['is_member'] },
};

/** Keys on a decision row that the auditor reads. */
export const DECISION_ROW_KEYS = [
  'id',
  'phase',
  'phase_raw',
  'phase_label',
  'phase_ordinal',
  'skill',
  'question',
  'ai_default',
  'status',
  'evidence_basis',
] as const;

/**
 * Secret-shaped values that are ACCEPTED on the anonymous payload, each with
 * the decision that accepted it. Anything else matching the secret regex is a
 * BLOCKING finding (defect 2).
 *
 * `assistant.embed_key`: the OCS widget is a browser component — it
 * authenticates the anonymous visitor's chat session with `chatbot-id` +
 * `embed-key` read from the page, so any key that reaches the widget is by
 * construction readable by anyone who can load the page. It is a per-chatbot
 * public identifier, not an OCS account credential. Reviewed 2026-08-14
 * (ace-web#706) and left in place as a documented exposure. Removing it removes
 * the assistant entirely; the real fix is upstream (an OCS session-scoped
 * token). Recorded here so the NEXT secret-shaped key on the public payload
 * fails an audit instead of riding along on this precedent.
 */
export const ACCEPTED_PUBLIC_SECRETS: Readonly<Record<string, string>> = {
  'assistant.embed_key':
    'OCS widget public identifier; readable by anyone who can load the page by ' +
    'construction. Accepted 2026-08-14 (ace-web#706). Real fix is an OCS ' +
    'session-scoped token.',
};

const SECRET_KEY_RE = /(^|_)(key|token|secret|password|passwd|credential|api_key|auth)($|_)/i;

// ── Phase A: contract assertions ───────────────────────────────────

/**
 * Assert the payload is the shape this auditor knows how to audit.
 *
 * Three distinct failures, all BLOCKING, none of which may degrade to a quiet
 * zero:
 *
 *  1. `CONTRACT-UNKNOWN-SECTION` — ace-web sent a section this auditor has
 *     never looked at. Certifying a page containing an unaudited section is
 *     false assurance. Teach the auditor, then re-run.
 *  2. `CONTRACT-MISSING-SECTION` — a section the auditor reads is absent from
 *     the payload entirely. Distinct from "present and null", which legitimately
 *     means the run hasn't reached that phase.
 *  3. `CONTRACT-KEY-DRIFT` — a section is POPULATED but missing a key the
 *     auditor reads. This is defect 5's signature: the data is there, the key
 *     name moved, and every consumer silently renders absence.
 */
export function auditContract(payload: unknown): Finding[] {
  const out: Finding[] = [];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return [
      {
        code: 'CONTRACT-NOT-AN-OBJECT',
        severity: 'broken',
        where: '(payload)',
        detail: `the summary endpoint returned ${Array.isArray(payload) ? 'a list' : typeof payload}, not an object`,
        fix: 'the audit cannot proceed — check the summary URL and the endpoint',
      },
    ];
  }
  const p = payload as Record<string, unknown>;

  for (const key of Object.keys(p)) {
    if (!(key in SURFACE_CONTRACT)) {
      out.push({
        code: 'CONTRACT-UNKNOWN-SECTION',
        severity: 'misleading',
        where: key,
        detail:
          `the payload carries a section \`${key}\` this auditor does not know about, so nothing ` +
          `checked it. Reporting "clean" on a page with an unaudited section is exactly the false ` +
          `assurance this audit exists to prevent`,
        fix: `add \`${key}\` to SURFACE_CONTRACT in lib/run-surface-audit.ts (and to ace-web's test_public_surface_contract.py), then re-run`,
        defect: 'the cautionary tale — a check that cannot see the thing it checks',
      });
    }
  }

  for (const [name, contract] of Object.entries(SURFACE_CONTRACT)) {
    if (!(name in p)) {
      out.push({
        code: 'CONTRACT-MISSING-SECTION',
        severity: 'misleading',
        where: name,
        detail:
          `the payload has no \`${name}\` key at all. That is different from \`${name}: null\` ` +
          `(the run hasn't reached that phase) — the section was removed or renamed, and every ` +
          `check that reads it silently reported nothing`,
        fix: 'reconcile lib/run-surface-audit.ts against ace-web apps/opps/summary.py — one of them moved',
        defect: '5 (key-contract mismatch renders as absence)',
      });
      continue;
    }
    out.push(...auditSection(name, contract, p[name]));
  }

  out.push(...auditDecisionRows(p.decisions));
  return out;
}

function auditSection(name: string, contract: SectionContract, value: unknown): Finding[] {
  const out: Finding[] = [];
  if (value === null || value === undefined) return out; // legitimately not reached yet

  const drift = (where: string, missing: string[]) => ({
    code: 'CONTRACT-KEY-DRIFT',
    severity: 'misleading' as const,
    where,
    detail:
      `populated, but missing the key(s) this auditor reads: ${missing.join(', ')}. ` +
      `A key-name mismatch is invisible at runtime — it renders as absence, so the page tells ` +
      `the reader the thing was never created`,
    fix: 'reconcile the key names against ace-web apps/opps/summary.py; both sides are frozen by contract tests',
    defect: '5 (walkthroughs/dashboards said "Not created" — the data was under par_url/key)',
  });

  if (contract.kind === 'list') {
    if (!Array.isArray(value)) {
      out.push({
        code: 'CONTRACT-KEY-DRIFT',
        severity: 'misleading',
        where: name,
        detail: `expected a list, got ${typeof value}`,
        fix: 'reconcile against ace-web apps/opps/summary.py',
        defect: '5',
      });
      return out;
    }
    value.forEach((item, i) => {
      if (item === null || typeof item !== 'object') return;
      const missing = (contract.itemKeys ?? []).filter((k) => !(k in (item as object)));
      if (missing.length) out.push(drift(`${name}[${i}]`, missing));
    });
    return out;
  }

  if (typeof value !== 'object') return out;
  const obj = value as Record<string, unknown>;
  const missingTop = contract.keys.filter((k) => !(k in obj));
  if (missingTop.length) out.push(drift(name, missingTop));

  // Nested member objects (design.docs[], training.docs[], training.deck,
  // connect.opportunity) get the same treatment.
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v) && contract.itemKeys) {
      v.forEach((item, i) => {
        if (item === null || typeof item !== 'object') return;
        const missing = contract.itemKeys!.filter((ik) => !(ik in (item as object)));
        if (missing.length) out.push(drift(`${name}.${k}[${i}]`, missing));
      });
    } else if (v && typeof v === 'object' && !Array.isArray(v) && contract.itemKeys) {
      const missing = contract.itemKeys.filter((ik) => !(ik in (v as object)));
      // `connect.opportunity` and `training.deck` are the only single-object
      // members; a section whose object member has NONE of the item keys is a
      // different shape entirely, not a partial one.
      if (missing.length && missing.length < contract.itemKeys.length) {
        out.push(drift(`${name}.${k}`, missing));
      }
    }
  }
  return out;
}

/**
 * Decision rows carry the provenance ("which phase produced this call?") that
 * the whole review surface is organised around.
 *
 * `phase_label` derived from an ORDINAL rather than from the phase's own name
 * (defect 8) publishes a decision under the wrong phase the moment the pipeline
 * is re-ordered. The auditor cannot see the derivation, but it CAN see the
 * evidence: a row must carry both `phase_raw` (what the run recorded) and
 * `phase_label` (what the page shows), and the label must be derivable from the
 * raw tag's TAIL, not from its ordinal.
 */
export function auditDecisionRows(decisions: unknown): Finding[] {
  const out: Finding[] = [];
  if (!decisions || typeof decisions !== 'object') return out;
  const rows = (decisions as Record<string, unknown>).rows;
  if (!Array.isArray(rows)) return out;

  rows.forEach((row, i) => {
    if (!row || typeof row !== 'object') return;
    const r = row as Record<string, unknown>;
    const missing = DECISION_ROW_KEYS.filter((k) => !(k in r));
    if (missing.length) {
      out.push({
        code: 'CONTRACT-KEY-DRIFT',
        severity: 'misleading',
        where: `decisions.rows[${i}]`,
        detail: `decision row missing: ${missing.join(', ')}`,
        fix: 'reconcile against ace-web apps/opps/summary.py :: _read_decisions',
        defect: '8 / 10 (provenance per decision)',
      });
      return;
    }
    if (!labelMatchesPhaseTag(String(r.phase_raw ?? ''), String(r.phase_label ?? ''))) {
      out.push({
        code: 'DECISION-PHASE-LABEL-DRIFT',
        severity: 'misleading',
        where: `decisions.rows[${i}] (${String(r.id)})`,
        detail:
          `row is tagged \`${String(r.phase_raw)}\` but the page labels it ` +
          `"${String(r.phase_label)}" — the label shares no word with the phase tag, which is ` +
          `what a label derived from the ORDINAL rather than the phase name looks like. A ` +
          `re-ordered pipeline then publishes a decision under the wrong phase name`,
        fix: 'ace-web apps/opps/summary.py :: _decision_phase_label must derive from the tag tail / the plugin phase registry, never from phase_ordinal',
        defect: '8 (phase labels derived by ordinal)',
      });
    }
  });
  return out;
}

const STOPWORDS = new Set(['and', 'to', 'the', 'of', 'a', 'setup', 'management', 'review']);

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w && !STOPWORDS.has(w) && !/^\d+$/.test(w)),
  );
}

/**
 * True when `label` plausibly names the phase `phase_raw` tags.
 *
 * `3-commcare` → "CommCare setup" agrees (shares `commcare`).
 * `4-connect`  → "Solicitation management" does not (shares nothing) — that is
 * an ordinal-derived label pointing at the wrong phase.
 *
 * Deliberately permissive: the registry legitimately expands a tag
 * (`1-design` → "Idea to Design"), so a single shared stem is enough. The
 * failure being caught is a label with NO relationship to the tag.
 */
export function labelMatchesPhaseTag(phaseRaw: string, label: string): boolean {
  const tail = phaseRaw.includes('-') ? phaseRaw.slice(phaseRaw.indexOf('-') + 1) : phaseRaw;
  const tagWords = words(tail);
  const labelWords = words(label);
  if (!tagWords.size || !labelWords.size) return true; // nothing to compare
  for (const t of tagWords) {
    for (const l of labelWords) {
      if (t === l || t.startsWith(l) || l.startsWith(t)) return true;
    }
  }
  return false;
}

// ── Phase B: link classification ───────────────────────────────────

export type LinkClass =
  | 'OK'
  | 'AUTH-GATED'
  | 'MEMBER-GATED'
  | 'PRIVATE-DELIVERABLE'
  | 'REACHABLE'
  | 'BROKEN';

/**
 * Hosts whose gate is MEMBERSHIP, not merely sign-in.
 *
 * An anonymous probe sees a login redirect (indistinguishable from a plain
 * login gate), but a signed-in NON-member gets a hard 404 — these surfaces
 * deliberately don't leak the existence of projects you can't see. Anonymous
 * reachability therefore proves nothing about the reviewer we're about to
 * share with (ace#913).
 *
 * Matched as (host-suffix, path-prefix): `labs.connect.dimagi.com` contains
 * `connect.dimagi.com` but its `/labs/...` dashboards are merely login-gated
 * (any CCHQ account reaches them), so the path check is load-bearing.
 */
export const MEMBER_GATED: readonly (readonly [string, string])[] = [
  ['commcarehq.org', '/a/'],
  ['openchatstudio.com', '/a/'],
  ['connect.dimagi.com', '/a/'],
];

/** Hosts that serve ACE-AUTHORED deliverables (docs we wrote for the reader). */
export const DELIVERABLE_HOSTS = ['docs.google.com', 'drive.google.com'] as const;

export function isMemberGated(url: string): boolean {
  try {
    const u = new URL(url);
    return MEMBER_GATED.some(([host, prefix]) => u.hostname.endsWith(host) && u.pathname.startsWith(prefix));
  } catch {
    return false;
  }
}

export function isAceDeliverable(url: string): boolean {
  try {
    const u = new URL(url);
    return DELIVERABLE_HOSTS.some((h) => u.hostname.endsWith(h));
  } catch {
    return false;
  }
}

export function looksLikeLogin(finalUrl: string): boolean {
  const low = (finalUrl || '').toLowerCase();
  return low.includes('login') || low.includes('signin') || low.includes('oauth') || low.includes('accounts.google.com');
}

/**
 * Pure classifier: (url, status, landing URL) → class + note.
 *
 * `PRIVATE-DELIVERABLE` is the class that makes defect 1 impossible. A private
 * Google Doc and a third-party login wall are byte-identical to an anonymous
 * probe; the difference is that a platform login gate opens for anyone with an
 * account, whereas a private Google Doc opens only for accounts explicitly
 * shared on it. The old checker bucketed both as AUTH-GATED and passed —
 * `12 links · 0 BROKEN`, exit 0, while all eight reviewer-facing deliverables
 * 401'd.
 */
export function classifyLink(url: string, code: number | null, finalUrl = ''): { cls: LinkClass; note: string } {
  if (code === null) {
    return { cls: 'BROKEN', note: finalUrl ? `unreachable (${finalUrl})` : 'unreachable' };
  }
  const gated = code === 401 || code === 403 || (code >= 200 && code < 400 && looksLikeLogin(finalUrl));
  if (gated) {
    if (isAceDeliverable(url)) {
      return {
        cls: 'PRIVATE-DELIVERABLE',
        note:
          'an ACE-authored Google deliverable that is shared with nobody — the recipient of the ' +
          'public summary link hits "You need access". Not a third-party login wall',
      };
    }
    if (isMemberGated(url)) {
      return {
        cls: 'MEMBER-GATED',
        note: 'requires MEMBERSHIP, not just sign-in — a signed-in non-member gets a flat 404',
      };
    }
    return { cls: 'AUTH-GATED', note: code === 401 || code === 403 ? 'requires sign-in' : `redirects to sign-in (${finalUrl.slice(0, 60)})` };
  }
  if (code === 404 || code === 410) return { cls: 'BROKEN', note: 'not found' };
  if (code >= 500) return { cls: 'BROKEN', note: 'server error' };
  if (code >= 200 && code < 400) return { cls: 'OK', note: '' };
  return { cls: 'REACHABLE', note: `HTTP ${code}` };
}

export interface CollectedUrl {
  /** Dotted payload path, e.g. `training.docs[2].url`. */
  label: string;
  url: string;
  /** The `access` the payload DECLARES for this link (`public` / `admin`), if any. */
  declaredAccess: string | null;
}

const URL_KEY_RE = /(_url$|_link$)/;
const EXPLICIT_URL_KEYS = new Set(['url', 'hq_url', 'nova_url', 'ocs_url', 'web_view_link', 'slideshow_url']);

function isUrlKey(key: string): boolean {
  return EXPLICIT_URL_KEYS.has(key) || URL_KEY_RE.test(key);
}

/**
 * Recursively collect every clickable URL in the payload, WITH the `access`
 * its own object declares.
 *
 * Two things the old collector could not do:
 *
 *  1. **Relative URLs.** It filtered on `v.startswith("http")`, so the footer's
 *     root-relative `workbench_url` ("See the full build process") was
 *     structurally invisible — and it 404'd anonymously for every reader on
 *     every run, because it was missing the `/ace` deployment prefix
 *     (defect 7). Relative values under a URL key are resolved against the
 *     summary PAGE url, exactly as a browser would.
 *  2. **The declared access tag.** Carrying it lets the auditor compare what
 *     the page CLAIMS about a link against what an anonymous visitor actually
 *     gets — an untagged link an outsider cannot open reads as broken rather
 *     than deliberate (defect 4), and a link tagged `public` that 401s is a
 *     lie the page is telling.
 */
export function collectUrls(node: unknown, pageUrl: string, path = ''): CollectedUrl[] {
  const out: CollectedUrl[] = [];
  if (Array.isArray(node)) {
    node.forEach((v, i) => out.push(...collectUrls(v, pageUrl, `${path}[${i}]`)));
    return out;
  }
  if (!node || typeof node !== 'object') return out;

  const obj = node as Record<string, unknown>;
  const declared = typeof obj.access === 'string' ? obj.access : null;
  for (const [k, v] of Object.entries(obj)) {
    const label = path ? `${path}.${k}` : k;
    if (typeof v === 'string' && isUrlKey(k) && v) {
      if (/^https?:\/\//i.test(v)) {
        out.push({ label, url: v, declaredAccess: declared });
      } else if (v.startsWith('/') && pageUrl) {
        out.push({ label, url: new URL(v, pageUrl).toString(), declaredAccess: declared });
      }
    } else if (v && typeof v === 'object') {
      out.push(...collectUrls(v, pageUrl, label));
    }
  }
  return out;
}

export interface ProbedLink extends CollectedUrl {
  status: number | null;
  cls: LinkClass;
  note: string;
}

/**
 * Turn probed links into findings.
 *
 * Beyond "is it reachable", this is where the page's CLAIMS are checked
 * against reality — the tier that carried today's worst defects:
 *
 * - `LINK-UNTAGGED` (defect 4): links an external viewer cannot open — HQ apps,
 *   the Connect opp, the OCS console, labs dashboards, the solicitation — were
 *   shown with no tag, so they read as broken rather than deliberate.
 * - `LINK-ACCESS-MISLABELLED`: the payload says `public` and an anonymous
 *   visitor gets a gate. That is the page stating something untrue.
 */
export function auditLinks(links: ProbedLink[]): Finding[] {
  const out: Finding[] = [];
  for (const l of links) {
    if (l.cls === 'BROKEN') {
      out.push({
        code: 'LINK-BROKEN',
        severity: 'broken',
        where: l.label,
        detail: `${l.url} — ${l.note} (HTTP ${l.status ?? '—'})`,
        fix: 'fix the underlying product URL or stop surfacing it; a relative link that 404s usually means a missing deployment path prefix',
        defect: '7 (footer "See the full build process" was a hard 404 anonymously)',
      });
      continue;
    }
    if (l.cls === 'PRIVATE-DELIVERABLE') {
      out.push({
        code: 'LINK-PRIVATE-DELIVERABLE',
        severity: 'broken',
        where: l.label,
        detail: `${l.url} — ${l.note}`,
        fix: "drive_set_anyone_with_link on the file_id (role 'commenter' when the reviewer should be able to leave feedback), then re-audit for OK 200",
        defect: '1 (all 8 reviewer-facing Drive deliverables were private while QA reported 12 links · 0 BROKEN)',
      });
      continue;
    }
    if (l.declaredAccess === null) {
      out.push({
        code: 'LINK-UNTAGGED',
        severity: l.cls === 'OK' ? 'improvement' : 'misleading',
        where: l.label,
        detail:
          `${l.url} carries no \`access\` tag, and anonymously it is ${l.cls}. An outsider who ` +
          `clicks it and hits a wall reads the page as broken rather than as deliberately ` +
          `showing them an internal build tool`,
        fix: 'tag the link `public` / `admin` in ace-web apps/opps/summary.py so the page can say why it cannot be opened',
        defect: '4 (links an external viewer cannot open were shown untagged)',
      });
    } else if (l.declaredAccess === 'public' && l.cls !== 'OK' && l.cls !== 'REACHABLE') {
      out.push({
        code: 'LINK-ACCESS-MISLABELLED',
        severity: 'misleading',
        where: l.label,
        detail:
          `the page declares this link \`public\` but an anonymous visitor gets ${l.cls} ` +
          `(HTTP ${l.status ?? '—'}): ${l.url}`,
        fix: 'either share the artifact so it really is public, or correct its access tag — the page is currently telling the reader something untrue',
        defect: '1 / 4',
      });
    }
  }
  return out;
}

// ── Phase C: confidentiality ───────────────────────────────────────

/** Walk every leaf of the payload as (dotted path, value). */
export function walkLeaves(node: unknown, path = ''): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  if (Array.isArray(node)) {
    node.forEach((v, i) => out.push(...walkLeaves(v, `${path}[${i}]`)));
    return out;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out.push(...walkLeaves(v, path ? `${path}.${k}` : k));
    }
    return out;
  }
  out.push([path, node]);
  return out;
}

/** Strip list indices so `feedback[0].access` compares as `feedback.access`. */
function normalisePath(path: string): string {
  return path.replace(/\[\d+\]/g, '');
}

/**
 * What an ANONYMOUS visitor must not be handed.
 *
 * Two rules that look similar and are not:
 *
 * - **Usability** says every link is served to everyone, each declaring its own
 *   access — hiding a link an external reviewer can't use is as bad as letting
 *   it 404 silently, just quieter.
 * - **Confidentiality** REMOVES the row. A privately-captured reviewer's
 *   feedback ledger was linked from the unauthenticated summary (defect 3),
 *   while the reaction path in the very same payload explicitly refuses to
 *   republish that same review. The title alone ("2026-07-27 · Sophie
 *   Feintuch") discloses that a named person reviewed this run.
 *
 * So an `admin`-tagged link elsewhere in the payload is EXPECTED; an
 * `admin`-tagged entry inside `feedback[]` on an anonymous fetch is a leak.
 */
export function auditConfidentiality(payload: unknown, opts: { anonymous: boolean }): Finding[] {
  const out: Finding[] = [];
  if (!payload || typeof payload !== 'object') return out;
  const p = payload as Record<string, unknown>;

  // 1. Secret-shaped values (defect 2).
  for (const [path, value] of walkLeaves(p)) {
    const leaf = normalisePath(path).split('.').pop() ?? '';
    if (!SECRET_KEY_RE.test(leaf)) continue;
    if (typeof value !== 'string' || !value) continue;
    const norm = normalisePath(path);
    if (norm in ACCEPTED_PUBLIC_SECRETS) continue;
    out.push({
      code: 'CONF-SECRET-EXPOSED',
      severity: 'misleading',
      where: path,
      detail:
        `the anonymous payload carries a secret-shaped value at \`${path}\` that is not on the ` +
        `accepted list. Every value on this payload is readable by anyone who has the link`,
      fix:
        'either stop serving it, or add it to ACCEPTED_PUBLIC_SECRETS in lib/run-surface-audit.ts ' +
        'WITH the reasoning that makes it safe (and mirror it in ace-web test_public_surface_contract.py)',
      defect: '2 (the public payload served the OCS embed key anonymously)',
    });
  }

  // 2. A privately-captured review's ledger, republished (defect 3).
  if (opts.anonymous && Array.isArray(p.feedback)) {
    p.feedback.forEach((row, i) => {
      if (!row || typeof row !== 'object') return;
      const r = row as Record<string, unknown>;
      if (r.access === 'admin') {
        out.push({
          code: 'CONF-PRIVATE-REVIEW-LINKED',
          severity: 'misleading',
          where: `feedback[${i}] (${String(r.title ?? '')})`,
          detail:
            'a privately-captured reviewer\'s feedback ledger is linked from the UNAUTHENTICATED ' +
            'summary. The reaction path in this same payload explicitly refuses to republish a ' +
            'private review; linking the ledger rendered from it walks straight around that. The ' +
            'title alone discloses that a named person reviewed this run',
          fix: 'ace-web apps/opps/summary.py :: _read_feedback must omit a non-public ledger when viewer_is_member is false',
          defect: '3 (a private reviewer\'s ledger linked from the unauthenticated summary)',
        });
      }
    });
  }

  // 3. `viewer.is_member` must be false on an anonymous probe — otherwise the
  //    audit is looking at the MEMBER variant of the payload and every
  //    confidentiality conclusion above is about the wrong document.
  if (opts.anonymous) {
    const viewer = p.viewer as Record<string, unknown> | undefined;
    if (viewer && viewer.is_member === true) {
      out.push({
        code: 'PROBE-NOT-ANONYMOUS',
        severity: 'misleading',
        where: 'viewer.is_member',
        detail:
          'the payload came back with viewer.is_member=true, so this probe was NOT anonymous — ' +
          'a member sees a different document. Every confidentiality finding above is about the ' +
          'wrong variant of the page',
        fix: 'clear cookies / credentials and re-run; a member\'s view is a different test',
      });
    }
  }
  return out;
}

// ── Phase D: completeness against what the run produced ────────────

/**
 * Reviewer-facing products a run can produce, and where each must surface on
 * the page.
 *
 * `path` is dotted from `phases`. `mode: 'children'` means every child of that
 * map is its own product (the training docs and the synthetic workflow
 * dashboards are keyed maps, not lists).
 *
 * Defect 6: the PDD and the Work Order — the two artifacts a partner is BEST
 * placed to critique — were absent from the page entirely, and no check noticed,
 * because nothing compared the page against what the run had actually made.
 *
 * Deliberately EXCLUDES `apps.*.nova_url`: a Nova build URL is an internal
 * build-tool artifact, and "the page doesn't link our build tool" is correct
 * behaviour, not a gap. Expecting it would train the reader to ignore this
 * check.
 *
 * Key names calibrated against a real `run_state.yaml`
 * (`spark-facilitator/20260813-2126`, 2026-08-14) rather than assumed —
 * `pdd`/`work_order` carry a bare `file_id` with no URL at all, which a
 * `url`-only reader would have silently skipped. That is the same class of
 * miss as defect 5.
 */
export const EXPECTED_PRODUCTS: readonly {
  label: string;
  path: string;
  mode: 'single' | 'children';
  section: string;
}[] = [
  { label: 'PDD', path: 'idea-to-design.products.pdd', mode: 'single', section: 'design.docs' },
  { label: 'Work Order', path: 'idea-to-design.products.work_order', mode: 'single', section: 'design.docs' },
  { label: 'Learn app', path: 'commcare-setup.products.apps.learn', mode: 'single', section: 'apps' },
  { label: 'Deliver app', path: 'commcare-setup.products.apps.deliver', mode: 'single', section: 'apps' },
  { label: 'Connect opportunity', path: 'connect-setup.products.connect.opportunity', mode: 'single', section: 'connect.opportunity' },
  { label: 'OCS chatbot', path: 'ocs-setup.products.ocs_chatbot', mode: 'single', section: 'assistant' },
  { label: 'Training deck', path: 'qa-and-training.products.training.deck', mode: 'single', section: 'training.deck' },
  { label: 'Training doc', path: 'qa-and-training.products.training.docs', mode: 'children', section: 'training.docs' },
  { label: 'Solicitation', path: 'solicitation-management.products.solicitation', mode: 'single', section: 'solicitation' },
  { label: 'Dashboard', path: 'synthetic-data-and-workflows.products.synthetic.workflows', mode: 'children', section: 'dashboards' },
];

/**
 * Keys a run_state product uses for "where this thing lives", in preference
 * order. A product may carry ONLY a `file_id` (the PDD does), so a reader that
 * looks for `url` alone silently sees nothing — which is exactly the failure
 * mode this whole module exists to make impossible.
 */
const PRODUCT_LOCATION_KEYS = [
  'url',
  'web_view_link',
  'hq_url',
  'admin_url',
  'run_url',
  'public_url',
  'file_id',
] as const;

function getPath(obj: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((acc, k) => {
    if (acc && typeof acc === 'object' && !Array.isArray(acc)) return (acc as Record<string, unknown>)[k];
    return undefined;
  }, obj);
}

/** The canonical identity of a product, from whichever location key it carries. */
function productIdentity(product: unknown): { key: string; shown: string } | null {
  if (!product || typeof product !== 'object') return null;
  const p = product as Record<string, unknown>;
  for (const k of PRODUCT_LOCATION_KEYS) {
    const v = p[k];
    if (typeof v !== 'string' || !v) continue;
    return k === 'file_id' ? { key: `gdoc:${v}`, shown: `file_id ${v}` } : { key: canonicalDocUrl(v), shown: v };
  }
  return null;
}

/**
 * Walkthroughs are counted, not URL-matched.
 *
 * Every other product here is checked by resolving its link on the page, but a
 * walkthrough legitimately has no link in two of its four states (`withheld`,
 * `unavailable`) — so a link check would flag a page that is behaving
 * correctly. What must hold instead is far simpler and stronger: **the page
 * has one entry for every walkthrough the run produced.** Each entry then
 * declares its own state.
 *
 * This is the check that was missing when it mattered.
 * `spark-facilitator/20260813-2126` produced a 12-scene narrated video,
 * published it to Drive, recorded it in `run_state`, and served
 * `walkthroughs: []` — because the reader's accepted-URL-key list did not
 * include the key the run happened to write (ace#1432). No finding fired: the
 * contract check only inspects items that are present, so an empty list is
 * indistinguishable from a run that made nothing, and completeness had no
 * walkthrough row at all. Count parity closes both halves at once, and it
 * cannot be defeated by a future key rename.
 */
export function auditWalkthroughParity(payload: unknown, phases: unknown): Finding[] {
  const produced = getPath(phases, 'synthetic-data-and-workflows.products.synthetic.walkthroughs');
  if (!Array.isArray(produced) || produced.length === 0) return [];
  const shown = getPath(payload, 'walkthroughs');
  const shownCount = Array.isArray(shown) ? shown.length : 0;
  if (shownCount >= produced.length) return [];
  return [
    {
      code: 'WALKTHROUGH-DROPPED',
      severity: 'misleading',
      where: 'walkthroughs',
      detail:
        `the run produced ${produced.length} walkthrough(s) and the page shows ${shownCount}. ` +
        'A produced walkthrough that never reaches the page reads exactly like a run that never ' +
        'made one — the reader is not withholding it, it is denying it exists',
      fix:
        'surface every entry in ace-web `_read_walkthroughs` — a walkthrough with no recognised ' +
        'URL key belongs on the page as `availability: unavailable`, never dropped. If a URL was ' +
        'written under a new key, add it to `_WALKTHROUGH_URL_KEYS`',
      defect: '7 (a passing walkthrough served as `walkthroughs: []`)',
    },
  ];
}

/** Phase statuses / verdicts that mean "this phase finished clean". */
const CLEAN_PHASE_STATUSES = new Set(['done', 'complete', 'completed', 'pass', 'passed']);
const FAILING_STEP_VERDICTS = new Set(['fail', 'failed', 'halt', 'blocked', 'reject']);

/**
 * Did the run generate its data, and does the page SAY so?
 *
 * Phase 7 invents facilitators, visits, anomalies and a coaching task. On
 * `spark-facilitator/20260828-0703` the run recorded `provider: ace-run`,
 * `labs_synthetic_opp_id: 10054`, `user_visits: 223`, `user_data: 12` and
 * `completed_works: 0` — 223 invented records attributed to 12 invented
 * facilitators — and the DASHBOARDS section carried no qualifier at all, so an
 * outsider read every named persona and every planted anomaly as an
 * observation of a real programme (ace#1867).
 *
 * Sibling of `auditWalkthroughParity`: a page that is silent about the
 * provenance of a number is not neutral about it, it is asserting the number is
 * what it appears to be.
 */
export function auditSyntheticLabelling(payload: unknown, phases: unknown): Finding[] {
  const source = getPath(phases, 'synthetic-data-and-workflows.products.synthetic.source');
  if (!source || typeof source !== 'object') return [];
  const counts = getPath(source, 'record_counts');
  const visits = typeof getPath(counts, 'user_visits') === 'number'
    ? (getPath(counts, 'user_visits') as number)
    : null;
  const labelled = getPath(payload, 'synthetic.is_synthetic') === true;
  if (labelled) return [];
  return [
    {
      code: 'SYNTHETIC-UNLABELLED',
      severity: 'misleading',
      where: 'synthetic',
      detail:
        `the run GENERATED its dataset${visits === null ? '' : ` (${visits} records)`} and the page ` +
        'carries no `synthetic` label, so the dashboards and the demo present invented ' +
        'facilitators, visits and anomalies as observations of a real programme',
      fix:
        'surface `products.synthetic.source` through ace-web `_read_synthetic` and render the ' +
        'label on the dashboards and walkthrough sections — from the run\'s own counts, never hardcoded',
      defect: '(ace#1867) 223 generated records and 12 invented facilitators shown unqualified',
    },
  ];
}

/**
 * Did a phase finish anything but clean, and does the page SAY so?
 *
 * `spark-facilitator/20260828-0703` wrote `status: partial`, `verdict:
 * partial-deliver-eval-blocked-on-phase1-gap` and `pdd-to-deliver-app-eval →
 * fail` on the `entity_state_fidelity` hard gate — payment-key fidelity — and
 * the COMMCARE APPS section showed both apps with no status at all. The page
 * was indistinguishable from a clean run, so the reader had no way even to ask
 * about something the page did not admit existed (ace-web#744).
 */
export function auditBuildStatusParity(payload: unknown, phases: unknown): Finding[] {
  const phase = getPath(phases, 'commcare-setup');
  if (!phase || typeof phase !== 'object') return [];
  const status = String(getPath(phase, 'status') ?? '').trim().toLowerCase();
  const steps = getPath(phase, 'steps');
  const failingSteps = steps && typeof steps === 'object'
    ? Object.entries(steps as Record<string, unknown>)
        .filter(([, step]) =>
          FAILING_STEP_VERDICTS.has(
            String(getPath(step, 'verdict') ?? '').trim().toLowerCase(),
          ))
        .map(([name]) => name)
    : [];
  const unclean = (status !== '' && !CLEAN_PHASE_STATUSES.has(status)) || failingSteps.length > 0;
  if (!unclean) return [];
  if (getPath(payload, 'build') != null) return [];
  return [
    {
      code: 'BUILD-STATUS-HIDDEN',
      severity: 'misleading',
      where: 'build',
      detail:
        `Phase 3 finished \`${status || 'not-clean'}\`` +
        (failingSteps.length > 0 ? ` with ${failingSteps.join(', ')} failing` : '') +
        ', and the page carries no `build` block — so the apps render exactly as they would on a ' +
        'clean run and the reader cannot tell the two apart',
      fix:
        'surface `phases.commcare-setup.{status, verdict, status_note, steps}` (and ' +
        '`blocker_dispositions`) through ace-web `_read_build`, rendered with the same honest ' +
        'vocabulary the Phase 7 walkthrough already uses for a non-converged score',
      defect: '(ace-web#744) a partial run rendered identically to a clean one',
    },
  ];
}

/**
 * Compare the page against `run_state.yaml`: did the run PRODUCE something the
 * page never shows?
 *
 * Without a run state this returns a single BLOCKING `COMPLETENESS-UNVERIFIED`
 * — the same precedent as `MEMBER-UNVERIFIED`: "we did not check" is not "it is
 * fine", and treating it as fine is the entire bug.
 */
export function auditCompleteness(payload: unknown, runState: unknown | null): Finding[] {
  if (runState === null || runState === undefined) {
    return [
      {
        code: 'COMPLETENESS-UNVERIFIED',
        severity: 'misleading',
        where: '(run_state.yaml)',
        detail:
          'no run_state was supplied, so nothing compared the page against what the run actually ' +
          'produced. A product the run made and the page never shows is invisible to every other ' +
          'check here — it renders as a section that simply is not there',
        fix: 'pass --run-state <path> (read ACE/<opp>/runs/<run-id>/run_state.yaml via drive_read_file), or state explicitly that completeness was not verified',
        defect: '6 (the PDD and Work Order were absent from the page entirely)',
      },
    ];
  }
  const out: Finding[] = [];
  const phases = getPath(runState, 'phases');
  out.push(...auditWalkthroughParity(payload, phases));
  out.push(...auditSyntheticLabelling(payload, phases));
  out.push(...auditBuildStatusParity(payload, phases));
  const onPage = new Set(
    collectUrls(payload, 'https://labs.connect.dimagi.com/ace/')
      .map((u) => canonicalDocUrl(u.url)),
  );

  for (const spec of EXPECTED_PRODUCTS) {
    const node = getPath(phases, spec.path);
    if (!node || typeof node !== 'object') continue;
    const products: Array<[string, unknown]> =
      spec.mode === 'children'
        ? Object.entries(node as Record<string, unknown>)
        : [[spec.label, node]];

    for (const [name, product] of products) {
      const id = productIdentity(product);
      if (id === null) continue;
      if (onPage.has(id.key)) continue;
      out.push({
        code: 'MISSING-ARTIFACT',
        severity: 'misleading',
        where: spec.section,
        detail:
          `the run produced ${spec.label === name ? spec.label : `${spec.label} \`${name}\``} ` +
          `(${id.shown}) and the page links nothing that resolves to it. The page therefore reads ` +
          `as if it was never made`,
        fix: `surface it in ace-web apps/opps/summary.py under \`${spec.section}\`, or say on the page why it is withheld`,
        defect: '6 (PDD + Work Order absent from the page entirely)',
      });
    }
  }
  return out;
}

/** Google Doc URLs differ by `/edit`, `?usp=drivesdk` etc. — compare on the file id. */
export function canonicalDocUrl(url: string): string {
  const m = url.match(/\/d\/([A-Za-z0-9_-]{10,})/);
  if (m) return `gdoc:${m[1]}`;
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/$/, '')}`;
  } catch {
    return url;
  }
}

// ── Phase E: document fidelity ─────────────────────────────────────

/**
 * A `--doc-source` map: published-doc url → the markdown it was published
 * from, or an EXPLICIT `null` meaning "the author asserts no source artifact
 * exists for this one."
 */
export type DocSourceMap = Record<string, string | null>;

/**
 * Resolve one document's source markdown out of a supplied `--doc-source` map.
 *
 * There are THREE states here and collapsing the last two is what ace#1687
 * was. Measured live on `hh-poverty-targeting/20260824-1404`: three audits
 * minutes apart, the two with no map listed 6 and 8 unsourced documents, and
 * the one carrying a map with a SINGLE entry dropped `DOC-FIDELITY-UNVERIFIED`
 * entirely. Supplying a source for one document switched the check off for the
 * other five.
 *
 * - map not supplied at all        → `undefined` — nothing was attempted.
 * - url ABSENT from a supplied map → `undefined` — nothing was attempted *for
 *   this url*. A partial map must NARROW the finding, never erase it; supplying
 *   the sources you can recover is the natural thing to do and must not buy a
 *   green surface with the check turned off.
 * - url PRESENT with `null`        → `null` — the sentinel. The author has
 *   deliberately declared no source exists, so the check stands down for this
 *   url alone. That claim is written by hand, one url at a time; it is never
 *   inferred from silence.
 *
 * Keys match on canonical doc identity, so a map keyed by the spelling Drive
 * hands back (`…/edit?usp=drivesdk`) still matches the spelling the payload
 * carries. A key that matches nothing simply leaves its document unverified —
 * loudly, which is the safe direction.
 */
export function resolveDocSource(
  map: DocSourceMap | null | undefined,
  url: string,
): string | null | undefined {
  if (!map) return undefined;
  const want = canonicalDocUrl(url);
  for (const [key, value] of Object.entries(map)) {
    if (canonicalDocUrl(key) === want) return value;
  }
  return undefined;
}

/**
 * Markers that a Google Doc is showing the reader raw markdown rather than
 * rendered prose (defect 11: documents rendered as literal `##`, `**`, and YAML
 * frontmatter because they were uploaded as `text/plain`).
 *
 * Deliberately anchored to line starts / paired delimiters so prose that
 * happens to contain an asterisk doesn't trip it.
 */
const LITERAL_MARKDOWN_PATTERNS: readonly { re: RegExp; what: string }[] = [
  // NOTE the `[^\S\n]` instead of `\s`. With `\s` and the `m` flag, `\s+`
  // happily eats the NEWLINE, so a lone `#` — which is what a Google Docs table
  // column literally named "#" exports as — matched against the first character
  // of the NEXT line. Measured on spark-facilitator's PDD, 2026-08-14: a clean,
  // properly-converted document was reported as raw markdown. A false positive
  // here is not harmless; it is the same class of bug as a false negative, and
  // it trains the reader to ignore the auditor.
  { re: /^#{1,6}[^\S\n]+\S[^\n]*$/m, what: 'ATX headings (`## ...`)' },
  { re: /\*\*[^*\n]{2,}\*\*/, what: 'bold markers (`**...**`)' },
  { re: /^---[^\S\n]*$[\s\S]{0,400}?^---[^\S\n]*$/m, what: 'YAML frontmatter fence' },
  { re: /^[^\S\n]*\|[^\n]+\|[^\S\n]*$/m, what: 'pipe tables' },
  { re: /!\[[^\]]*\]\([^)]*\)/, what: 'unresolved image references (`![alt](...)`)' },
  { re: /^[^\S\n]*```/m, what: 'code fences' },
];

export interface DocProbe {
  /** Payload label, e.g. `training.docs[1].url`. */
  label: string;
  url: string;
  /** Plain-text export of the published doc, or null if it could not be read. */
  text: string | null;
  /** Number of `<img` tags in the HTML export, or null if not fetched. */
  imageCount: number | null;
  /**
   * Source markdown this doc was published FROM.
   *
   * `undefined` = nothing was supplied for this doc, so fidelity is UNVERIFIED
   * and says so. `null` = the caller deliberately asserted there is no source
   * artifact. Never conflate the two — see `resolveDocSource` (ace#1687).
   */
  sourceMarkdown?: string | null;
  /** Why `text` is null, when it is — reported verbatim rather than guessed at. */
  unreadableReason?: string;
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export function countImageRefs(markdown: string): number {
  return (markdown.match(/!\[[^\]]*\]\([^)]*\)/g) ?? []).length;
}

/**
 * Judge a PUBLISHED reviewer-facing document.
 *
 * Two failures, both of which shipped with every content check green:
 *
 * - **defect 11** — the doc renders literal markdown, because it was uploaded
 *   as `text/plain` instead of converted.
 * - **defect 12** — a guide silently lost 44 screenshots and 224 words, because
 *   `![alt](drive:<id>)` is dropped by Drive's importer. Nothing compared the
 *   published doc against the markdown it was published from, so the loss was
 *   structurally invisible.
 *
 * Without `sourceMarkdown` the content-loss half cannot be judged, and this
 * says so (`DOC-FIDELITY-UNVERIFIED`) instead of scoring the doc clean. The
 * literal-markdown half needs nothing but the published text, and a guide with
 * zero images that talks about screenshots is a strong enough signal to raise
 * on its own.
 */
export function auditDocFidelity(probes: DocProbe[]): Finding[] {
  const out: Finding[] = [];
  // Collected rather than emitted per-document: one gap in the audit's inputs
  // is ONE finding. Eight identical paragraphs is how a real finding gets
  // scrolled past.
  const unsourced: string[] = [];
  for (const d of probes) {
    if (d.text === null) {
      out.push({
        code: 'DOC-FIDELITY-UNVERIFIED',
        severity: 'improvement',
        where: d.label,
        detail:
          `could not read the published text of ${d.url} anonymously` +
          (d.unreadableReason ? ` (${d.unreadableReason})` : '') +
          ', so its rendering was not judged',
        fix: 'share the doc anyone-with-link (it is reviewer-facing) and re-audit',
      });
      continue;
    }
    const hits = LITERAL_MARKDOWN_PATTERNS.filter((p) => p.re.test(d.text!)).map((p) => p.what);
    if (hits.length) {
      out.push({
        code: 'DOC-LITERAL-MARKDOWN',
        severity: 'misleading',
        where: d.label,
        detail:
          `the published document shows the reader raw markdown — ${hits.join(', ')}. It reads as ` +
          `a broken export, not a document`,
        fix:
          'republish via drive_create_doc_from_markdown (Drive CONVERTS markdown) rather than ' +
          'uploading the .md as text/plain, then re-audit',
        defect: '11 (documents rendered as literal markdown)',
      });
    }

    if (d.sourceMarkdown === undefined) {
      unsourced.push(d.label);
      continue;
    }
    if (d.sourceMarkdown === null) continue;

    const srcWords = countWords(stripMarkdownSyntax(d.sourceMarkdown));
    const gotWords = countWords(d.text);
    const srcImages = countImageRefs(d.sourceMarkdown);
    const gotImages = d.imageCount ?? 0;

    // 5% is noise (frontmatter, link syntax); anything more is content.
    if (srcWords > 0 && gotWords < srcWords * 0.95) {
      out.push({
        code: 'DOC-CONTENT-LOSS',
        severity: 'misleading',
        where: d.label,
        detail:
          `the published document has ${gotWords} words where the source had ${srcWords} — ` +
          `${srcWords - gotWords} words did not survive publication, and the page presents it as ` +
          `the complete deliverable`,
        fix: 'find what the importer dropped and republish; re-audit until the counts agree',
        defect: '12',
      });
    }
    if (srcImages > 0 && gotImages < srcImages) {
      out.push({
        code: 'DOC-CONTENT-LOSS',
        severity: 'misleading',
        where: d.label,
        detail:
          `the published document has ${gotImages} images where the source referenced ` +
          `${srcImages} — ${srcImages - gotImages} are missing. \`![alt](drive:<id>)\` is DROPPED ` +
          `by Drive's importer, silently`,
        fix:
          'insert the images via docs_batch_update after conversion (or upload them first and ' +
          'reference real Drive image URLs), then re-audit',
        defect: '12 (44 screenshots lost with every content check green)',
      });
    }
  }

  if (unsourced.length) {
    out.push({
      code: 'DOC-FIDELITY-UNVERIFIED',
      severity: 'misleading',
      where: unsourced.join(', '),
      detail:
        `${unsourced.length} published document(s) had no source markdown supplied, so nothing ` +
        `compared what was PUBLISHED against what was WRITTEN. Content the Drive importer drops ` +
        `is invisible to every other check here — one guide lost 44 screenshots and 224 words ` +
        `with every content check green`,
      fix:
        'pass --doc-source <json> mapping each url to the markdown it was published from ' +
        '(drive_read_file on the source artifact). A PARTIAL map is fine and narrows this ' +
        'finding to whatever is still missing — it does not switch the check off. To stand the ' +
        'check down for a document that genuinely has no source artifact, give that url an ' +
        'explicit null (`{"<url>": null}`); silence never means that',
      defect: '12 (a guide silently lost 44 screenshots and 224 words)',
    });
  }
  return out;
}

/**
 * Did the step-by-step GUIDES actually publish the screenshots the run captured?
 *
 * This is defect 12 in its most damaging form, and the form that needs no
 * source markdown to detect. `![alt](drive:<id>)` is DROPPED by Drive's
 * importer — silently — so a guide authored with 44 screenshots publishes with
 * none, and every content check stays green because the WORDS are all there.
 * The reader gets a step-by-step guide with no steps shown.
 *
 * The evidence is on both sides and both sides are cheap: the run's own
 * `app-screenshot-capture` step records how many PNGs it published, and the
 * published document's HTML export says how many images it contains. Nothing
 * compared them until now.
 *
 * Scoped to docs whose run_state key names a GUIDE. The FAQ, the quick-
 * reference card and the onboarding email are legitimately text.
 */
export function auditGuideScreenshots(runState: unknown, docs: DocProbe[]): Finding[] {
  if (!runState) return [];
  const captured = screenshotsCaptured(runState);
  if (captured === null) return [];

  const guideIds = new Map<string, string>(); // file id -> run_state key
  const guides = getPath(runState, 'phases.qa-and-training.products.training.docs');
  if (guides && typeof guides === 'object') {
    for (const [key, val] of Object.entries(guides as Record<string, unknown>)) {
      if (!/guide/i.test(key)) continue;
      const id = productIdentity(val);
      if (id) guideIds.set(id.key, key);
    }
  }
  if (!guideIds.size) return [];

  const out: Finding[] = [];
  for (const d of docs) {
    const key = guideIds.get(canonicalDocUrl(d.url));
    if (!key) continue;
    if (d.imageCount === null) continue; // could not read — DOC-FIDELITY-UNVERIFIED covers it
    if (d.imageCount > 0) continue;
    out.push({
      code: 'DOC-SCREENSHOTS-ABSENT',
      severity: 'misleading',
      where: d.label,
      detail:
        `\`${key}\` is published with ZERO images, while this run captured ` +
        `${captured.count === null ? 'screenshots' : `${captured.count} screenshots`} ` +
        `(${captured.evidence}). A step-by-step guide with no steps shown reads as complete — ` +
        `every word is there — which is exactly why nothing caught it`,
      fix:
        'Render the markdown, THEN embed: `npx tsx scripts/embed-doc-screenshots.ts <docId> ' +
        '--screenshots <folderId>` (Docs API insertInlineImage via docs_batch_update). It anchors ' +
        'on the references the prose already carries and verifies the published image count. Note ' +
        'the importer DOES fetch a real https image src — it just sizes it at the natural ' +
        '1080x2400, i.e. a page and a half per screenshot — which is why the embed is a second step',
      defect: '12 (a guide silently lost 44 screenshots and 224 words)',
    });
  }
  return out;
}

/** Evidence that this run captured screenshots at all, and how many. */
function screenshotsCaptured(runState: unknown): { count: number | null; evidence: string } | null {
  const steps = getPath(runState, 'phases.qa-and-training.steps');
  if (!steps || typeof steps !== 'object') return null;
  const step = (steps as Record<string, unknown>)['app-screenshot-capture'];
  if (!step || typeof step !== 'object') return null;
  const s = step as Record<string, unknown>;
  const artifact = typeof s.artifact === 'string' ? s.artifact : '';
  const note = typeof s.note === 'string' ? s.note : '';
  const m = note.match(/(\d+)\s*PNGs?/i);
  if (!artifact && !m) return null;
  return {
    count: m ? Number(m[1]) : null,
    evidence: artifact ? `run_state step app-screenshot-capture → ${artifact}` : 'run_state step app-screenshot-capture',
  };
}

/**
 * Rough plain-text of markdown, for comparable word counts.
 *
 * NOTE the GFM-table handling, which is load-bearing and was missing until
 * ace#1838. A pipe-delimited row survives `split(/\s+/)` as its DELIMITERS:
 * `| Deliver unit | 1 USD |` contributes three `|` tokens and `|---|---|`
 * contributes one more, none of which exist in the published Google Doc — it
 * renders a real table. That inflates the SOURCE count only, and once the
 * inflation crosses the 5% band in `auditDocFidelity` the auditor reports
 * DOC-CONTENT-LOSS — a MISLEADING-tier, share-blocking finding — against a
 * document that lost nothing. Measured on hh-poverty-targeting/20260828-0702:
 * the PDD scored 8183 source words vs 7659 published and was reported as
 * having dropped 524; normalising the pipes away gave 7642 vs 7659 and a
 * token-by-token diff of the two showed exactly one difference, the published
 * export's UTF-8 BOM. Every ACE PDD carries payment-unit and verification
 * tables, so this fired on essentially every run.
 *
 * Only DELIMITERS are removed, never cell contents — a table the importer
 * genuinely dropped still shows up, because its cell words are still counted
 * on the source side and still absent from the published text.
 */
export function stripMarkdownSyntax(md: string): string {
  return md
    .replace(/^---[\s\S]*?^---\s*$/m, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    // GFM table separator rows: a line made only of `|`, `-`, `:` and spaces,
    // carrying at least one pipe. The class is `[ \t]`, NOT `\s` — with `\s`
    // and the `m` flag the quantifier eats the NEWLINE and swallows whatever
    // follows, which is the same footgun already recorded on
    // LITERAL_MARKDOWN_PATTERNS above.
    .replace(/^[ \t]*\|[-:| \t]*$/gm, '')
    // Remaining cell delimiters. A space, not '', so `a|b` stays two words.
    .replace(/\|/g, ' ')
    .replace(/[*_`>]/g, '');
}

// ── Phase F: folding in the rendered-DOM report ────────────────────

/**
 * What the browser probe (`scripts/audit-run-surface-render.ts`) reports back.
 * Kept as a plain data contract so the fold-in logic is testable without a
 * browser.
 */
export interface RenderReport {
  /** URLs the page actually rendered as clickable hrefs (absolute). */
  renderedHrefs: string[];
  /** Visible "Not created" placeholder labels found on the page. */
  notCreatedLabels: string[];
  /** true when a decision row's edit commits on pick (no separate Save click). */
  decisionEditCommitsOnPick: boolean | null;
  /** true when a decision's phase/provenance is visible with NO user interaction. */
  provenanceVisibleByDefault: boolean | null;
  /** Anonymous reachability of the two public write endpoints. */
  writePaths: { comment: number | null; edit: number | null };
  /** Anything the probe could not determine, with why. */
  undetermined: string[];
}

export function auditRender(payload: unknown, report: RenderReport, pageUrl: string): Finding[] {
  const out: Finding[] = [];
  const rendered = new Set(report.renderedHrefs.map(canonicalDocUrl));

  // A populated section that contributes NOTHING to the rendered page, on a
  // page that is simultaneously drawing "Not created" placeholders, is the
  // rendered face of a key-contract mismatch: the data is there, the renderer
  // cannot see it, and the reader is told it was never made.
  if (report.notCreatedLabels.length) {
    for (const [name, contract] of Object.entries(SURFACE_CONTRACT)) {
      if (!contract.reviewerFacing) continue;
      const data = getPath(payload, name);
      const populated = Array.isArray(data) ? data.length > 0 : data !== null && data !== undefined;
      if (!populated) continue;
      const links = collectUrls({ [name]: data }, pageUrl);
      if (!links.length) continue;
      const anyRendered = links.some((l) => rendered.has(canonicalDocUrl(l.url)));
      if (!anyRendered) {
        out.push({
          code: 'RENDER-CONTRADICTS-PAYLOAD',
          severity: 'misleading',
          where: name,
          detail:
            `\`${name}\` is populated in the payload (${links.length} link(s)) but not one of them ` +
            `is rendered, and the page is drawing "Not created" placeholders ` +
            `(${report.notCreatedLabels.join(', ')}). The reader is being told work that exists was ` +
            `never made`,
          fix: "reconcile the renderer's key names against the payload — this is what a key-contract mismatch looks like on screen",
          defect: '5 (walkthroughs and dashboards said "Not created" when both existed)',
        });
      }
    }
  }

  for (const link of collectUrls(payload, pageUrl)) {
    // Only reviewer-facing sections must be VISIBLE; internal ones may be
    // deliberately styled down but should still be present.
    if (!rendered.has(canonicalDocUrl(link.url))) {
      out.push({
        code: 'RENDER-LINK-NOT-SHOWN',
        severity: 'improvement',
        where: link.label,
        detail: `the payload carries ${link.url} but the rendered page has no href to it`,
        fix: 'either render it or drop it from the payload — a link the API serves and the page hides is dead weight that later reads as missing',
        defect: '5 / 6',
      });
    }
  }

  if (report.decisionEditCommitsOnPick === false) {
    out.push({
      code: 'RENDER-EDIT-NEEDS-EXTRA-COMMIT',
      severity: 'improvement',
      where: 'decisions (edit affordance)',
      detail:
        'changing a decision requires a separate commit step (pick → name → Save) on every row, ' +
        'where the Workbench commits on click. A reviewer working through 42 rows pays that three ' +
        'times per row, and the two surfaces disagree about what "changing an answer" means',
      fix: 'commit on pick, as the Workbench does; keep the name prompt once per session, not once per row',
      defect: '9 (pick → name → Save on every row; caught only by a human comparing by eye)',
    });
  }
  if (report.decisionEditCommitsOnPick === null) {
    out.push({
      code: 'RENDER-UNDETERMINED',
      severity: 'improvement',
      where: 'decisions (edit affordance)',
      detail: 'the probe could not find the decision edit control, so the commit affordance was not judged',
      fix: 'check the selectors in scripts/audit-run-surface-render.ts against the current page markup',
    });
  }

  if (report.provenanceVisibleByDefault === false) {
    out.push({
      code: 'RENDER-PROVENANCE-HIDDEN',
      severity: 'misleading',
      where: 'decisions (phase grouping)',
      detail:
        'which phase produced a decision is only visible after expanding a disclosure. The review ' +
        'surface is organised by phase precisely so a reader can see where a call came from; ' +
        'behind a collapsed control, by default, it is not there',
      fix: 'render the phase grouping expanded by default',
      defect: '10 (decisions grouped by phase only inside a collapsed disclosure)',
    });
  }

  for (const [name, status] of Object.entries(report.writePaths)) {
    if (status === null || status === 404 || status === 405 || (status >= 500 && status < 600)) {
      out.push({
        code: 'WRITE-PATH-UNREACHABLE',
        severity: 'broken',
        where: `write path: ${name}`,
        detail:
          `the public ${name} endpoint answered ${status ?? 'nothing'} to an anonymous probe. ` +
          `"Can a partner actually respond?" is the point of this surface`,
        fix: 'check the public write routes in ace-web apps/opps/api.py',
      });
    }
  }

  for (const u of report.undetermined) {
    out.push({
      code: 'RENDER-UNDETERMINED',
      severity: 'improvement',
      where: '(render probe)',
      detail: u,
      fix: 'update the probe, or record explicitly that this aspect was not judged',
    });
  }
  return out;
}

// ── Reporting ──────────────────────────────────────────────────────

export interface AuditSummary {
  broken: number;
  misleading: number;
  improvement: number;
  safeToShare: boolean;
}

export function summarise(findings: Finding[]): AuditSummary {
  const count = (s: AuditSeverity) => findings.filter((f) => f.severity === s).length;
  const broken = count('broken');
  const misleading = count('misleading');
  return {
    broken,
    misleading,
    improvement: count('improvement'),
    safeToShare: broken === 0 && misleading === 0,
  };
}

export const SEVERITY_ORDER: readonly AuditSeverity[] = ['broken', 'misleading', 'improvement'];

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      a.code.localeCompare(b.code) ||
      a.where.localeCompare(b.where),
  );
}

// ── Per-reviewer membership ────────────────────────────────────────
//
// `MEMBER-GATED` says "this link needs membership". It does NOT say whether the
// person we are about to send it to HAS that membership — and this audit probes
// anonymously, so it cannot find out.
//
// For three runs that gap was covered by prose: the output told the reader to
// "confirm every named reviewer actually holds membership", and the confirming
// got done by an agent choosing to comply, at exactly the moment (about to send
// a reply) when it feels already-done. On 2026-07-23 that produced a written
// claim to an external partner — "you already had access there, so nothing to
// do" — that a read-back showed was false, and it stayed false for a week.
//
// What makes it worth automating: a reviewer without membership gets a flat
// 404, indistinguishable from "this run does not exist". It never reads as "you
// need access", so they report it as us shipping a broken link — which is
// exactly how ace#913 and ace#916 reached us (ace#1060).
//
// This does NOT grow three auth paths. The read-backs already exist —
// `scripts/grant-review-access.ts --dry-run` (HQ + OCS) and
// `lib/connect-member-table.ts` (Connect). It consumes their results and
// REFUSES TO CERTIFY without them.

export type MemberSurface = 'hq' | 'ocs' | 'connect';

const MEMBER_SURFACES: readonly (readonly [string, MemberSurface])[] = [
  ['commcarehq.org', 'hq'],
  ['openchatstudio.com', 'ocs'],
  ['connect.dimagi.com', 'connect'],
];

export const READBACK_HINT: Readonly<Record<MemberSurface, string>> = {
  hq: 'npx tsx scripts/grant-review-access.ts --dry-run (HQ role read-back)',
  ocs: 'npx tsx scripts/grant-review-access.ts --dry-run (OCS group read-back)',
  connect:
    "connect_add_org_member's pre-read of /organization/member_table (lib/connect-member-table.ts)",
};

/** Which read-back path can answer for this URL, or null if it isn't gated. */
export function memberSurface(url: string): MemberSurface | null {
  if (!isMemberGated(url)) return null;
  try {
    const host = new URL(url).hostname;
    for (const [suffix, surface] of MEMBER_SURFACES) {
      if (host.endsWith(suffix)) return surface;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** `{surface: {email: boolean}}` as produced by the read-back tools above. */
export type Memberships = Partial<Record<MemberSurface, Record<string, boolean>>>;

/**
 * Judge one (member-gated link, named reviewer) pair.
 *
 * A surface or email that is ABSENT from the read-back is UNVERIFIED, never OK
 * — "we did not check" is not "it is fine", and treating it as fine is the
 * whole bug.
 */
export function auditReviewerMembership(
  links: ProbedLink[],
  reviewers: string[],
  memberships: Memberships,
): Finding[] {
  const out: Finding[] = [];
  for (const l of links) {
    const surface = memberSurface(l.url);
    if (surface === null) continue;
    for (const reviewer of reviewers) {
      const known = memberships[surface];
      if (!known || !(reviewer in known)) {
        out.push({
          code: 'MEMBER-UNVERIFIED',
          severity: 'misleading',
          where: `${l.label} → ${reviewer}`,
          detail:
            `no membership read-back for ${reviewer} on ${surface}, so whether they can open ` +
            `${l.url} is unknown. A non-member gets a flat 404 — indistinguishable from "this run ` +
            `does not exist" — and reports it as us shipping a broken link`,
          fix: `run ${READBACK_HINT[surface]} and pass the result via --memberships`,
        });
        continue;
      }
      if (!known[reviewer]) {
        out.push({
          code: 'MEMBER-MISSING',
          severity: 'broken',
          where: `${l.label} → ${reviewer}`,
          detail: `${reviewer} is NOT a member on ${surface} and will get a flat 404 on ${l.url}`,
          fix: 'grant access first (skills/share-run-access), or do not present this link to them as reviewer-facing',
        });
      }
    }
  }
  return out;
}

/**
 * A member-gated link with NO named reviewer is a deliberate hole, not a pass.
 *
 * Anonymous reachability proves a link works for somebody. Until the audit is
 * told who it is being prepared for, it cannot say the page is safe to share
 * with them — so it says that, rather than printing a green tick.
 */
export function auditUnresolvedMemberGates(links: ProbedLink[], reviewers: string[]): Finding[] {
  if (reviewers.length > 0) return [];
  const gated = links.filter((l) => l.cls === 'MEMBER-GATED');
  if (!gated.length) return [];
  return [
    {
      code: 'REVIEWERS-UNDECLARED',
      severity: 'misleading',
      where: gated.map((l) => l.label).join(', '),
      detail:
        `${gated.length} link(s) on this page require MEMBERSHIP, and no reviewer was named, so ` +
        `nothing checked whether the people this run is being shared with can open them. ` +
        `Anonymous reachability only proves the link works for somebody`,
      fix: 'pass --reviewer <email> per person (plus --memberships), or withhold these links as internal build tools',
      defect: '4 (links an external viewer cannot open, shown as if they could)',
    },
  ];
}
