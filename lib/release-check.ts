//
// release-check — is this run ready to put in front of a partner?
//
// "Ready" used to be a claim. This module makes it a verdict a gate computes,
// over EVIDENCE the existing gates already produce — it re-implements none of
// them. Each `assess*` function reads one class of evidence (QA results, eval
// verdicts, the opportunity post-condition, the output-preview gap list, live
// link probes, the run-surface audit, the chatbot transcript, the app release)
// and turns it into findings; `buildReleaseVerdict` rolls them into ONE answer:
// READY iff there are no blockers.
//
// Every finding names its OWNER (the skill whose output it is about) and the
// FIX ROUTE (what to run). `releaseGate` is what `/ace:release` calls before it
// invites anyone: the most recent verdict must be READY and newer than the
// run's last write.
//
// Pure. `scripts/release-check.ts` gathers the evidence (Drive inventory via
// the service account, live probes) and writes the files.

import { parse as parseYaml } from 'yaml';
import { validateQAResult } from './qa-types.js';
import { checkOppPostcondition, type OppDecided, type OppReadback } from './connect-opp-postcondition.js';
import { hqEnterpriseFlipSteps } from './hq-enterprise-flip.js';

export const RELEASE_CHECK_SCHEMA_VERSION = 1 as const;
export const RELEASE_VERDICT_NAME = 'release-check_verdict.yaml';
export const RELEASE_REPORT_NAME = 'release-check_report.md';

export type ReleaseArea =
  | 'qa'
  | 'eval'
  | 'connect'
  | 'previews'
  | 'links'
  | 'public-summary'
  | 'chatbot'
  | 'apps'
  | 'hq'
  | 'run-state';

export interface ReleaseFinding {
  id: string;
  area: ReleaseArea;
  severity: 'blocker' | 'warning';
  /** The skill whose output the finding is about. */
  owner: string;
  detail: string;
  /** What to run / change to clear it. */
  fix: string;
}

/** One file in the run folder, as the inventory reads it. */
export interface RunFile {
  /** Path relative to the run folder, e.g. `4-connect/build-memo.md`. */
  path: string;
  modifiedTime: string;
  mimeType?: string;
  /** Text for QA results and verdicts (others omitted). */
  text?: string;
}

const QA_RESULT = /(^|\/)([a-z0-9-]+)-qa_result(?:-[a-z0-9]+)?\.ya?ml$/;
const EVAL_VERDICT = /(^|\/)([a-z0-9-]+?)-eval_verdict(?:-([a-z]+))?\.ya?ml$/;

function t(s: string | undefined): number {
  const n = Date.parse(s ?? '');
  return Number.isNaN(n) ? 0 : n;
}

let lastParseError = '';

function parse(text: string | undefined): Record<string, unknown> | null {
  lastParseError = '';
  if (!text) {
    lastParseError = 'no text could be read';
    return null;
  }
  try {
    const d = parseYaml(text.replace(/\r\n/g, '\n'));
    return d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : null;
  } catch (e) {
    lastParseError = (e as Error).message.split('\n')[0];
    return null;
  }
}

/**
 * Drive stamps a COPY with the copy time, so a fork's artifact and the verdict
 * graded on it land seconds apart in either order (spark-facilitator/
 * 20260926-1800: every pair within 20 s). Stale means changed AFTER grading by
 * more than a copy window — a real regeneration, not a copy order.
 */
export const STALE_TOLERANCE_MS = 10 * 60_000;

function isStale(artifact: RunFile, gate: RunFile): boolean {
  return t(artifact.modifiedTime) - t(gate.modifiedTime) > STALE_TOLERANCE_MS;
}

/** Newest write among a producer's own files (verdicts and results excluded). */
function producerLatest(files: readonly RunFile[], producer: string): RunFile | null {
  let best: RunFile | null = null;
  for (const f of files) {
    const base = f.path.split('/').pop() ?? '';
    // `<producer>.md`, `<producer>_<role>.yaml`, `<producer>.source.md` — not another skill sharing the prefix.
    if (!(base.startsWith(`${producer}.`) || base.startsWith(`${producer}_`))) continue;
    if (/_verdict|qa_result|release-check/.test(base)) continue;
    if (!best || t(f.modifiedTime) > t(best.modifiedTime)) best = f;
  }
  return best;
}

function capturedArtifact(files: readonly RunFile[], capturePath: unknown): RunFile | null {
  if (typeof capturePath !== 'string' || !capturePath) return null;
  const want = capturePath.replace(/^\/+/, '');
  return files.find((f) => f.path === want) ?? null;
}

// ---------------------------------------------------------------------------
// 1. QA results and eval verdicts — every step's gates
// ---------------------------------------------------------------------------

export interface GateCatalog {
  /** Skills that have a standalone `-qa` skill (dir `skills/<x>-qa`). */
  qaSkills: ReadonlySet<string>;
  /** Skills that have an `-eval` skill (dir `skills/<x>-eval`). */
  evalSkills: ReadonlySet<string>;
}

/** `phases.*.steps` that ran (`done` / `partial` / `pass…`), by skill name. */
export function stepsThatRan(runState: unknown): Array<{ phase: string; skill: string; status: string }> {
  const out: Array<{ phase: string; skill: string; status: string }> = [];
  const phases = (runState as { phases?: Record<string, { steps?: Record<string, { status?: string }> }> })?.phases ?? {};
  for (const [phase, block] of Object.entries(phases)) {
    for (const [skill, step] of Object.entries(block?.steps ?? {})) {
      const status = String(step?.status ?? '');
      if (/^(done|partial|complete|pass)/.test(status)) out.push({ phase, skill, status });
    }
  }
  return out;
}

export function assessGates(files: readonly RunFile[], runState: unknown, catalog: GateCatalog): ReleaseFinding[] {
  const findings: ReleaseFinding[] = [];
  const qaFiles = files.filter((f) => QA_RESULT.test(f.path));
  const evalFiles = files.filter((f) => EVAL_VERDICT.test(f.path));

  // Every QA result present: canonical, non-zero, passing, fresh.
  for (const f of qaFiles) {
    const producer = QA_RESULT.exec(f.path)![2];
    const skill = `${producer}-qa`;
    const data = parse(f.text);
    let problem: string | null = null;
    try {
      validateQAResult(data);
    } catch (e) {
      const issues = (e as { issues?: Array<{ path: unknown[]; message: string }> }).issues;
      problem = issues?.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') ?? (e as Error).message;
    }
    if (problem) {
      findings.push({
        id: `qa-malformed:${skill}`, area: 'qa', severity: 'blocker', owner: skill,
        detail: `${f.path} is not a lib/qa-types.ts result (${problem}) — ace-web shows it as "0/0 checks"`,
        fix: `re-run ${skill}; it writes through scripts/qa-result.ts`,
      });
      continue;
    }
    if (data!.verdict !== 'pass') {
      const failures = Array.isArray(data!.failures) ? (data!.failures as Array<{ check?: string; detail?: string }>) : [];
      findings.push({
        id: `qa-fail:${skill}`, area: 'qa', severity: 'blocker', owner: skill,
        detail: `${skill} verdict ${String(data!.verdict)}: ${failures.map((x) => `${x.check}: ${x.detail}`).join('; ') || '(no failures listed)'}`,
        fix: `apply each failure's auto_fix_hint in ${producer}, then re-run ${skill}`,
      });
    }
    const artifact = capturedArtifact(files, data!.capture_path) ?? producerLatest(files, producer);
    if (artifact && isStale(artifact, f)) {
      findings.push({
        id: `qa-stale:${skill}`, area: 'qa', severity: 'blocker', owner: skill,
        detail: `${artifact.path} changed after ${f.path} was written — the result no longer describes the artifact`,
        fix: `re-run ${skill}`,
      });
    }
  }

  // Every eval verdict present: in its pass band, fresh.
  for (const f of evalFiles) {
    const m = EVAL_VERDICT.exec(f.path)!;
    const producer = m[2];
    const skill = `${producer}-eval`;
    const data = parse(f.text);
    if (!data) {
      findings.push({ id: `eval-unreadable:${skill}`, area: 'eval', severity: 'blocker', owner: skill, detail: `${f.path} does not parse as YAML (${lastParseError}) — a reader that tolerates it sees something other than what was written`, fix: `re-run ${skill} and write the verdict through a YAML serializer` });
      continue;
    }
    const verdict = String(data.verdict ?? '');
    const score = typeof data.overall_score === 'number' ? data.overall_score : null;
    const threshold = typeof (data.gate as { threshold?: unknown } | undefined)?.threshold === 'number' ? (data.gate as { threshold: number }).threshold : null;
    const belowBand = verdict !== 'pass' || (score !== null && threshold !== null && score < threshold);
    if (belowBand) {
      const surfaced = Array.isArray(data.auto_surfaced) ? (data.auto_surfaced as Array<{ severity?: string; message?: string }>) : [];
      const top = surfaced.filter((s) => s.severity === 'BLOCKER').map((s) => s.message).slice(0, 3);
      findings.push({
        id: `eval-below-band:${skill}${m[3] ? `-${m[3]}` : ''}`, area: 'eval', severity: 'blocker', owner: producer,
        detail: `${skill} ${verdict}${score !== null ? ` ${score}` : ''}${threshold !== null ? ` (pass band ≥ ${threshold})` : ''}${top.length ? ` — ${top.join('; ')}` : ''}`,
        fix: `fix ${producer}'s output per the verdict, then re-run ${skill}`,
      });
    }
    const artifact = capturedArtifact(files, data.capture_path) ?? producerLatest(files, producer);
    if (artifact && isStale(artifact, f)) {
      findings.push({
        id: `eval-stale:${skill}`, area: 'eval', severity: 'blocker', owner: skill,
        detail: `${artifact.path} changed after ${f.path} was graded`,
        fix: `re-run ${skill}`,
      });
    }
  }

  // Every step that ran and HAS a gate must have that gate's file.
  const haveQa = new Set(qaFiles.map((f) => QA_RESULT.exec(f.path)![2]));
  const haveEval = new Set(evalFiles.map((f) => EVAL_VERDICT.exec(f.path)![2]));
  for (const { skill, phase } of stepsThatRan(runState)) {
    if (catalog.qaSkills.has(skill) && !haveQa.has(skill)) {
      findings.push({
        id: `qa-missing:${skill}-qa`, area: 'qa', severity: 'blocker', owner: `${skill}-qa`,
        detail: `${skill} ran in ${phase} but ${skill}-qa has no result in the run — the gate never ran or never wrote`,
        fix: `run ${skill}-qa`,
      });
    }
    if (catalog.evalSkills.has(skill) && !haveEval.has(skill)) {
      findings.push({
        id: `eval-missing:${skill}-eval`, area: 'eval', severity: 'blocker', owner: `${skill}-eval`,
        detail: `${skill} ran in ${phase} but ${skill}-eval has no verdict — its quality is unverified`,
        fix: `run ${skill}-eval`,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// 2. Connect opportunity post-condition (live read-back)
// ---------------------------------------------------------------------------

export function assessPostcondition(read: OppReadback | null, decided: OppDecided | null): ReleaseFinding[] {
  if (!read || !decided) {
    return [{ id: 'connect-postcondition-unrun', area: 'connect', severity: 'blocker', owner: 'connect-opp-setup', detail: 'the live opportunity was not read back', fix: 'run connect-opp-setup Step 11 reads (connect_get_opportunity, connect_list_payment_units, connect_list_flw_invites)' }];
  }
  const r = checkOppPostcondition(read, decided);
  return r.checks
    .filter((c) => !c.pass)
    .map((c) => ({
      id: `connect-${c.id}`,
      area: 'connect' as const,
      // Its own rule: what blocks the device walk blocks a release; the rest is a warning a reviewer must be told about.
      severity: c.blocksPhase6 || c.id === 'is_test' ? ('blocker' as const) : ('warning' as const),
      owner: 'connect-opp-setup',
      detail: c.detail,
      fix: c.id === 'verification_rules_persisted'
        ? 'state it in the build memo as a known limitation; apply the rules on the partner (PM→NM) opportunity (ace#2419)'
        : 're-run connect-opp-setup Steps 6.5–7 and its Step 11 read-back',
    }));
}

// ---------------------------------------------------------------------------
// 3. Output previews
// ---------------------------------------------------------------------------

export interface PreviewGapLite {
  id?: string;
  output_key?: string;
  phase?: string;
  reason?: string;
}

export interface PreviewLook {
  /** Frame id / path, and what the look found. */
  frame: string;
  ok: boolean;
  detail: string;
}

export function assessPreviews(gaps: readonly PreviewGapLite[] | null, looks: readonly PreviewLook[] = []): ReleaseFinding[] {
  const out: ReleaseFinding[] = [];
  if (gaps === null) {
    out.push({ id: 'previews-unchecked', area: 'previews', severity: 'blocker', owner: 'output-preview-capture', detail: "ace-web's preview-gaps list was not read", fix: 'scripts/output-preview-capture.ts gaps --refresh' });
  } else {
    for (const g of gaps) {
      out.push({
        id: `preview-gap:${g.id ?? g.output_key}`, area: 'previews', severity: 'blocker', owner: 'output-preview-capture',
        detail: `${g.output_key} (${g.phase}) has no picture and is not a doc the page draws (${g.reason ?? 'no-preview'})`,
        fix: 'run output-preview-capture for the run, then re-check with gaps --refresh',
      });
    }
  }
  for (const l of looks) {
    if (!l.ok) out.push({ id: `preview-bad-frame:${l.frame}`, area: 'previews', severity: 'blocker', owner: 'output-preview-capture', detail: l.detail, fix: 're-capture that output (output-preview-capture --only <gap id>) and look again' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. Links resolve for the intended audience
// ---------------------------------------------------------------------------

export interface LinkProbe {
  /** What the link is (product key, summary section). */
  label: string;
  url: string;
  /** `public` = anyone with the link (the summary says so); `member` = a signed-in reviewer. */
  audience: 'public' | 'member';
  /** The session it was probed with. */
  session: string;
  ok: boolean;
  status: number;
  final_url: string;
  detail: string;
  owner: string;
}

export function assessLinks(probes: readonly LinkProbe[] | null): ReleaseFinding[] {
  if (probes === null) return [{ id: 'links-unchecked', area: 'links', severity: 'blocker', owner: 'release-check', detail: 'output links were not probed', fix: 'scripts/release-check.ts links' }];
  return probes
    .filter((p) => !p.ok)
    .map((p) => ({
      id: `link:${p.label}`, area: 'links' as const, severity: 'blocker' as const, owner: p.owner,
      detail: `${p.label} (${p.audience}, probed as ${p.session}): ${p.detail} — ${p.url}`,
      fix: p.audience === 'public' ? 'make it publicly reachable or stop calling it public on the summary' : 'fix the URL its producer recorded (scope params, ids)',
    }));
}

// ---------------------------------------------------------------------------
// 5. Public summary — run-surface-audit's own findings
// ---------------------------------------------------------------------------

export interface SurfaceAuditFinding {
  code: string;
  severity: 'broken' | 'misleading' | 'improvement';
  where: string;
  detail: string;
  fix: string;
}

export function assessSurfaceAudit(audit: { findings?: SurfaceAuditFinding[] } | null, claims?: { all_met?: boolean; unmet?: number; not_reached?: number } | null): ReleaseFinding[] {
  const out: ReleaseFinding[] = [];
  if (!audit) {
    out.push({ id: 'surface-unaudited', area: 'public-summary', severity: 'blocker', owner: 'run-surface-audit', detail: 'the public run summary was not audited', fix: 'npx tsx scripts/audit-run-surface.ts <opp> <run> --json --run-state … --run-files …' });
  } else {
    for (const f of audit.findings ?? []) {
      if (f.severity === 'improvement') continue;
      out.push({
        id: `surface:${f.code}:${f.where}`.slice(0, 160), area: 'public-summary',
        severity: f.severity === 'broken' ? 'blocker' : 'warning', owner: 'run-surface-audit',
        detail: `${f.detail} (${f.where})`, fix: f.fix,
      });
    }
  }
  if (claims && claims.all_met === false) {
    out.push({
      id: 'claims-not-all-met', area: 'public-summary', severity: 'warning', owner: 'ace-orchestrator',
      detail: `run claims: ${claims.unmet ?? 0} unmet, ${claims.not_reached ?? 0} not reached — the summary must say so plainly`,
      fix: 'verify_run_claims; make sure every unmet claim carries a `says` sentence',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 6. Chatbot answers a real question; 7. apps released
// ---------------------------------------------------------------------------

export function assessChatbot(transcript: RunFile | null, now: string, maxAgeDays = 7): ReleaseFinding[] {
  if (!transcript) {
    return [{ id: 'chatbot-untested', area: 'chatbot', severity: 'blocker', owner: 'ocs-chatbot-qa', detail: 'no ocs-chatbot-qa transcript in the run', fix: 'run ocs-chatbot-qa --quick' }];
  }
  const out: ReleaseFinding[] = [];
  const ageDays = (t(now) - t(transcript.modifiedTime)) / 86_400_000;
  if (ageDays > maxAgeDays) {
    out.push({ id: 'chatbot-transcript-old', area: 'chatbot', severity: 'blocker', owner: 'ocs-chatbot-qa', detail: `the latest chatbot transcript is ${Math.floor(ageDays)} days old — the bot may not answer today`, fix: 'run ocs-chatbot-qa --quick' });
  }
  const text = transcript.text ?? '';
  if (/structural[_ ]pass:\s*false|Complete:\s*false/i.test(text)) {
    out.push({ id: 'chatbot-transcript-failed', area: 'chatbot', severity: 'blocker', owner: 'ocs-chatbot-qa', detail: 'the latest transcript records a failed or incomplete exchange', fix: 'fix the bot (ocs-agent-setup), then ocs-chatbot-qa --quick' });
  }
  return out;
}

export function assessApps(files: readonly RunFile[], runState: unknown): ReleaseFinding[] {
  const apps = (runState as { phases?: Record<string, { products?: { apps?: Record<string, { released_build_id?: unknown }> } }> })?.phases?.['commcare-setup']?.products?.apps ?? {};
  const out: ReleaseFinding[] = [];
  for (const kind of ['learn', 'deliver']) {
    const a = apps[kind] ?? (apps as Record<string, { released_build_id?: unknown }>)[`${kind}_app`];
    if (!a?.released_build_id) out.push({ id: `app-unreleased:${kind}`, area: 'apps', severity: 'blocker', owner: 'app-release', detail: `no released build recorded for the ${kind} app`, fix: 'run app-release' });
  }
  if (!files.some((f) => /app-release-qa_result\.ya?ml$/.test(f.path))) {
    out.push({ id: 'app-release-qa-missing', area: 'apps', severity: 'blocker', owner: 'app-release-qa', detail: 'no app-release-qa result — the released builds were never shown to install', fix: 'run app-release-qa' });
  }
  return out;
}

/** `commcare_get_subscription`'s output, as release-check reads it. */
export interface HqPlanLite {
  domain?: string;
  edition?: string;
  is_paid_edition?: boolean;
}

/**
 * The run's HQ space must be on a paid plan before outsiders are let in. A
 * new space starts on Free (ace#2552); the fix is one superuser step, normally
 * done at clone setup (lib/clone-setup-checklist.ts item 1b),
 * so the blocker's `fix` IS that step, verbatim, with the URL (ace#2600).
 */
export function assessHqPlan(hqDomain: string | null, plan: HqPlanLite | null): ReleaseFinding[] {
  if (!hqDomain) {
    return [{ id: 'hq-domain-unknown', area: 'hq', severity: 'blocker', owner: 'commcare-setup', detail: 'run_state records no HQ project space for the apps (phases.commcare-setup.products.apps.domain)', fix: 'record the apps\' domain in run_state (clone-to-new-workspace 4a.4)' }];
  }
  if (!plan) {
    return [{ id: 'hq-plan-unchecked', area: 'hq', severity: 'blocker', owner: 'release-check', detail: `the plan of HQ space ${hqDomain} was not read`, fix: `commcare_get_subscription(domain: ${hqDomain}) → pass it as --hq-plan` }];
  }
  if (plan.domain && plan.domain !== hqDomain) {
    return [{ id: 'hq-plan-wrong-space', area: 'hq', severity: 'blocker', owner: 'release-check', detail: `--hq-plan is for ${plan.domain}, but the run's apps are in ${hqDomain}`, fix: `commcare_get_subscription(domain: ${hqDomain})` }];
  }
  if (plan.is_paid_edition) return [];
  return [{
    id: `hq-plan-free:${hqDomain}`, area: 'hq', severity: 'blocker', owner: 'HQ superuser (operator)',
    detail: `HQ space ${hqDomain} is on ${plan.edition || 'an unpaid plan'} — its API is closed, and a partner would be handed a practice-only space`,
    fix: hqEnterpriseFlipSteps(hqDomain),
  }];
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

export interface ReleaseVerdict {
  schema_version: typeof RELEASE_CHECK_SCHEMA_VERSION;
  kind: 'release-check';
  workspace: string;
  opp: string;
  run_id: string;
  checked_at: string;
  /** Newest write in the run folder the check saw (release-check files excluded). */
  run_last_write: string;
  verdict: 'READY' | 'NOT_READY';
  /** True when the check ran read-only (no gate re-runs, no writes) — informational, never releasable. */
  read_only: boolean;
  counts: { blockers: number; warnings: number };
  /** Areas the check covered, each with its blocker / warning counts. */
  areas: Record<ReleaseArea, { blockers: number; warnings: number }>;
  blockers: ReleaseFinding[];
  warnings: ReleaseFinding[];
}

export function runLastWrite(files: readonly RunFile[]): string {
  let max = 0;
  let iso = '';
  for (const f of files) {
    if (/release-check_/.test(f.path)) continue;
    const v = t(f.modifiedTime);
    if (v > max) {
      max = v;
      iso = f.modifiedTime;
    }
  }
  return iso;
}

const AREAS: ReleaseArea[] = ['qa', 'eval', 'connect', 'previews', 'links', 'public-summary', 'chatbot', 'apps', 'hq', 'run-state'];

export function buildReleaseVerdict(input: {
  workspace: string;
  opp: string;
  runId: string;
  checkedAt: string;
  files: readonly RunFile[];
  findings: readonly ReleaseFinding[];
  readOnly?: boolean;
}): ReleaseVerdict {
  const seen = new Set<string>();
  const unique = input.findings.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)));
  const blockers = unique.filter((f) => f.severity === 'blocker');
  const warnings = unique.filter((f) => f.severity === 'warning');
  const areas = Object.fromEntries(
    AREAS.map((a) => [a, { blockers: blockers.filter((f) => f.area === a).length, warnings: warnings.filter((f) => f.area === a).length }]),
  ) as ReleaseVerdict['areas'];
  return {
    schema_version: RELEASE_CHECK_SCHEMA_VERSION,
    kind: 'release-check',
    workspace: input.workspace,
    opp: input.opp,
    run_id: input.runId,
    checked_at: input.checkedAt,
    run_last_write: runLastWrite(input.files),
    verdict: blockers.length === 0 ? 'READY' : 'NOT_READY',
    read_only: !!input.readOnly,
    counts: { blockers: blockers.length, warnings: warnings.length },
    areas,
    blockers,
    warnings,
  };
}

/**
 * `/ace:release`'s gate. Releasable iff the most recent verdict is READY, was
 * not a read-only dry run, belongs to THIS workspace/opp/run, and is newer than
 * every write in the run folder since (a gate re-run or a fix after the check
 * makes it stale).
 */
export function releaseGate(
  verdict: Partial<ReleaseVerdict> | null,
  current: { workspace: string; opp: string; runId: string; files: readonly RunFile[] },
): { ok: boolean; reason: string } {
  if (!verdict) return { ok: false, reason: `no ${RELEASE_VERDICT_NAME} in the run — run release-check first` };
  if (verdict.workspace !== current.workspace || verdict.opp !== current.opp || verdict.run_id !== current.runId) {
    return { ok: false, reason: `the verdict is for ${verdict.workspace}/${verdict.opp}/${verdict.run_id}, not ${current.workspace}/${current.opp}/${current.runId} — run release-check on this run (in this workspace)` };
  }
  if (verdict.read_only) return { ok: false, reason: 'the latest release-check was a read-only dry run — run it for real' };
  if (verdict.verdict !== 'READY') {
    const list = (verdict.blockers ?? []).map((b) => `- ${b.owner}: ${b.detail} → ${String(b.fix).replace(/\n/g, '\n    ')}`).join('\n');
    return { ok: false, reason: `release-check says NOT_READY (${verdict.counts?.blockers ?? '?'} blocker(s)):\n${list}` };
  }
  const last = runLastWrite(current.files);
  if (t(last) > t(verdict.checked_at)) {
    return { ok: false, reason: `the run changed after the check (last write ${last}, checked ${verdict.checked_at}) — re-run release-check` };
  }
  return { ok: true, reason: `READY, checked ${verdict.checked_at}, nothing written since` };
}

/** The human report — plain markdown (rendered as a Google Doc by the skill). */
export function renderReleaseReport(v: ReleaseVerdict): string {
  const lines: string[] = [];
  lines.push(`# Release check — ${v.opp} / ${v.run_id}`);
  lines.push('');
  lines.push(`**${v.verdict === 'READY' ? 'READY to release' : 'NOT READY to release'}** — ${v.counts.blockers} blocker(s), ${v.counts.warnings} warning(s). Checked ${v.checked_at} in workspace \`${v.workspace}\`${v.read_only ? ' (read-only dry run — not releasable as recorded)' : ''}.`);
  lines.push('');
  lines.push('| Area | Blockers | Warnings |');
  lines.push('|---|---|---|');
  for (const [a, c] of Object.entries(v.areas)) lines.push(`| ${a} | ${c.blockers} | ${c.warnings} |`);
  for (const [title, list] of [['Blockers — must fix before release', v.blockers], ['Warnings — should fix', v.warnings]] as const) {
    lines.push('');
    lines.push(`## ${title}`);
    lines.push('');
    if (!list.length) lines.push('None.');
    // A multi-line fix (the HQ superuser steps) stays inside its bullet.
    for (const f of list) lines.push(`- **${f.area} · ${f.owner}** — ${f.detail}. *Fix:* ${f.fix.replace(/\n/g, '\n  ')}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * What Phase 4 DECIDED, read back from run_state — the `decided` half of the
 * post-condition when release-check re-runs it after the fact. A rule Connect
 * refused is recorded as `not_applied_reason` with an empty rule list
 * (spark-facilitator/20260926-1800, ace#2419); that counts as a decided rule
 * that did not persist, not as "no rules were decided".
 */
export function decidedFromRunState(runState: unknown): OppDecided {
  const c = ((runState as { phases?: Record<string, { products?: { connect?: Record<string, unknown> } }> })?.phases?.['connect-setup']?.products?.connect ?? {}) as Record<string, unknown>;
  const pus = Array.isArray(c.payment_units) ? (c.payment_units as Array<{ name?: unknown }>) : [];
  const v = (c.verification ?? {}) as { form_field_rules?: unknown[]; form_field_rules_saved?: unknown; not_applied_reason?: unknown };
  const written = Array.isArray(v.form_field_rules) ? v.form_field_rules.length : 0;
  const expected = written || (typeof v.not_applied_reason === 'string' && v.not_applied_reason.trim() ? 1 : 0);
  return {
    paymentUnitNames: pus.map((p) => String(p.name ?? '')).filter(Boolean),
    formFieldRulesExpected: expected,
    formFieldRulesSaved: typeof v.form_field_rules_saved === 'number' ? v.form_field_rules_saved : null,
    expectActive: true,
    expectTestUserInvited: true,
  };
}
