//
// validate-release-readiness — is this run ready to
// put in front of a partner, and exactly what will releasing it share?
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
// FIX ROUTE (what to run). On READY the verdict also carries the RELEASE PLAN
// (lib/release-plan.ts) — the exact share actions `/ace:release` will execute,
// hashed. `releaseGate` is what `/ace:release` calls before it shares anything:
// the most recent verdict must be READY, for this run, newer than the run's
// last write, over the same run_state, for exactly the requested reviewers and
// options, with an untampered plan. Any mismatch is a refusal, never adapted to.
//
// Pure. `scripts/release-readiness.ts` gathers the evidence (Drive inventory via
// the service account, live probes) and writes the files.

import { parse as parseYaml } from 'yaml';
import { validateQAResult } from './qa-types.js';
import { checkOppPostcondition, type OppDecided, type OppReadback } from './connect-opp-postcondition.js';
import { hqEnterpriseFlipSteps } from './hq-enterprise-flip.js';
import { collapseSharedCauses, plainFinding } from './release-readiness-plain.js';
import { driveFileId } from './preview-capture.js';
import { auditDecisionsPlainLanguage, describePlainLanguageGate } from './decisions-enrich.js';
import { parseDecisionsYaml } from './decisions-schema.js';
import type { DecisionOverrideRow } from './decision-overrides.js';
import { requiredBeforeBlockers } from './open-asks.js';
import { APP_RELEASE_SUMMARY, parseAppReleaseSummary, releaseRecordFor, runStateRelease, type ReleaseRecord } from './app-release-record.js';
import { planHash, reviewersKey, type PlanProblem, type ReleaseOptions, type ReleasePlan, type Reviewer } from './release-plan.js';

export const RELEASE_READINESS_SCHEMA_VERSION = 2 as const;
export const RELEASE_VERDICT_KIND = 'release-readiness' as const;
export const RELEASE_VERDICT_NAME = 'release-readiness_verdict.yaml';
export const RELEASE_REPORT_NAME = 'release-readiness_report.md';
/** The verdict's own files, excluded from "the run's last write". */
export const VERDICT_FILE = /(^|\/)release-readiness_[^/]*$/;

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
  | 'reviewers'
  | 'drive'
  | 'release-plan'
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
  /**
   * Plain language for whoever releases the run — what is wrong, no ACE
   * internals (skill names, payload paths). Filled by `buildReleaseVerdict`
   * (lib/release-readiness-plain.ts); ace-web prefers it over `detail`.
   */
  summary?: string;
  /** What to do, addressed to a person. ace-web prefers it over `fix`. */
  action?: string;
  /** ids of findings folded into this one because they share its root cause. */
  merged?: string[];
}

/** One file in the run folder, as the inventory reads it. */
export interface RunFile {
  /** Path relative to the run folder, e.g. `4-connect/connect-opp-setup.md`. */
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
    if (/_verdict|qa_result|release-readiness_/.test(base)) continue;
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

/** The wording for a `warn` that cleared its score band; release-readiness-plain keys on it. */
export const CLEARED_BAND_PHRASE = 'cleared the score band but a dimension is still below 7';

/** Dimensions scoring below `floor`, from a verdict's `dimensions` map (`{name: {score}}` or `{name: score}`). */
export function dimensionsBelow(dimensions: unknown, floor: number): Array<{ name: string; score: number }> {
  if (!dimensions || typeof dimensions !== 'object') return [];
  const out: Array<{ name: string; score: number }> = [];
  for (const [name, v] of Object.entries(dimensions as Record<string, unknown>)) {
    const score = typeof v === 'number' ? v : typeof (v as { score?: unknown } | null)?.score === 'number' ? (v as { score: number }).score : null;
    if (score !== null && score < floor) out.push({ name, score });
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
    // The gate is deliberately strict: anything other than `pass` blocks a
    // release, including a `warn` whose score cleared the band (a dimension
    // < 7 — skills/run-surface-audit-eval § Verdict mapping). That case gets
    // its own wording: "scored below its pass mark" is false at 7.4 vs 7.0.
    const belowBand = verdict !== 'pass' || (score !== null && threshold !== null && score < threshold);
    if (belowBand) {
      const surfaced = Array.isArray(data.auto_surfaced) ? (data.auto_surfaced as Array<{ severity?: string; message?: string }>) : [];
      const top = surfaced.filter((s) => s.severity === 'BLOCKER').map((s) => s.message).slice(0, 3);
      const clearedBand = verdict === 'warn' && score !== null && threshold !== null && score >= threshold;
      const weak = clearedBand ? dimensionsBelow(data.dimensions, 7) : [];
      const head = `${skill} ${verdict}${score !== null ? ` ${score}` : ''}${threshold !== null ? ` (pass band ≥ ${threshold})` : ''}`;
      findings.push({
        id: `eval-below-band:${skill}${m[3] ? `-${m[3]}` : ''}`, area: 'eval', severity: 'blocker', owner: producer,
        detail: clearedBand
          ? `${head} — ${CLEARED_BAND_PHRASE}: ${weak.length ? weak.map((d) => `${d.name} ${d.score}`).join(', ') : '(no dimension scores recorded)'}; release requires verdict pass`
          : `${head}${top.length ? ` — ${top.join('; ')}` : ''}`,
        fix: clearedBand
          ? `raise ${weak.length ? weak.map((d) => d.name).join(', ') : "the verdict's sub-7 dimensions"} to 7 in ${producer}'s output, then re-run ${skill}`
          : `fix ${producer}'s output per the verdict, then re-run ${skill}`,
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
        ? 'record it as a rule row with `enforcement: gap` in decisions.yaml (it becomes a review ask); apply the rules on the partner (PM→NM) opportunity (ace#2419)'
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
  if (probes === null) return [{ id: 'links-unchecked', area: 'links', severity: 'blocker', owner: 'validate-release-readiness', detail: 'output links were not probed', fix: 'scripts/release-readiness.ts links' }];
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
  summary?: string;
  action?: string;
}

export function assessSurfaceAudit(
  audit: { findings?: SurfaceAuditFinding[] } | null,
  claims?: { all_met?: boolean; unmet?: number; not_reached?: number } | null,
  opts: { plannedDriveIds?: ReadonlySet<string> } = {},
): ReleaseFinding[] {
  const out: ReleaseFinding[] = [];
  if (!audit) {
    out.push({ id: 'surface-unaudited', area: 'public-summary', severity: 'blocker', owner: 'run-surface-audit', detail: 'the public run summary was not audited', fix: 'npx tsx scripts/audit-run-surface.ts <opp> <run> --json --run-state … --run-files …' });
  } else {
    for (const f of audit.findings ?? []) {
      if (f.severity === 'improvement') continue;
      // A private document the release plan shares (a `drive_share` action) is
      // the plan doing its job, not a blocker: sharing happens at release.
      if (f.code === 'LINK-PRIVATE-DELIVERABLE') {
        const id = driveFileId(f.detail.split(' ')[0]);
        if (id && opts.plannedDriveIds?.has(id)) continue;
      }
      out.push({
        id: `surface:${f.code}:${f.where}`.slice(0, 160), area: 'public-summary',
        severity: f.severity === 'broken' ? 'blocker' : 'warning', owner: 'run-surface-audit',
        detail: `${f.detail} (${f.where})`, fix: f.fix,
        // REVIEWERS-UNDECLARED gets a sharper, link-naming plain line in
        // lib/release-readiness-plain.ts; any other code keeps the audit's own.
        ...(f.code !== 'REVIEWERS-UNDECLARED' && f.summary && f.action ? { summary: f.summary, action: f.action } : {}),
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

/**
 * Run files whose TEXT the inventory reads (every other file is path + mtime
 * only). Every gate that reads a file's text needs its file here — ace#2698's
 * app-release_summary.md was missing, so the apps gate could never see it.
 */
export const INVENTORY_TEXT_WANTED = /-qa_result(?:-[a-z0-9]+)?\.ya?ml$|-eval_verdict(?:-[a-z]+)?\.ya?ml$|ocs-chatbot-qa_transcript[^/]*\.md$|release-readiness_verdict\.yaml$|(^|\/)decisions\.ya?ml$|(^|\/)app-release_summary\.md$/;

/** app-release's summary — the SOLE owner of released build state. Re-exported from lib/app-release-record.ts. */
export { APP_RELEASE_SUMMARY };

/** `apps.<kind>_app` from app-release_summary.md frontmatter, or null when the file/frontmatter is unreadable. */
function releaseRecords(files: readonly RunFile[]): Record<string, ReleaseRecord> | null {
  return parseAppReleaseSummary(files.find((f) => APP_RELEASE_SUMMARY.test(f.path))?.text);
}

/**
 * Both apps released, plus a passing app-release-qa. The release is read from
 * its contracted owner, `3-commcare/app-release_summary.md` frontmatter
 * `apps.<kind>_app.{hq_app_id, build_id, is_released}`. Nothing contracts a
 * release key in run_state `products.apps` (lib/phase-products-schema.ts
 * `AppEntry`), and reading one there alone raised false "unreleased" blockers
 * on spark-facilitator/20261004-1706, whose agent wrote `hq_build_id` +
 * `released_at` (ace#2698). Only when the summary is unreadable does this fall
 * back to the run_state shapes producers have actually written.
 */
export function assessApps(files: readonly RunFile[], runState: unknown): ReleaseFinding[] {
  const apps = ((runState as { phases?: Record<string, { products?: { apps?: Record<string, Record<string, unknown>> } }> })?.phases?.['commcare-setup']?.products?.apps ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const records = releaseRecords(files);
  const out: ReleaseFinding[] = [];
  const unreleased = (kind: string, detail: string): ReleaseFinding => ({ id: `app-unreleased:${kind}`, area: 'apps', severity: 'blocker', owner: 'app-release', detail, fix: 'run app-release' });
  for (const kind of ['learn', 'deliver']) {
    const a = apps[kind] ?? apps[`${kind}_app`];
    if (records) {
      const r = releaseRecordFor(records, kind);
      if (!r?.build_id || r.is_released !== true) {
        out.push(unreleased(kind, `app-release_summary.md records no released build for the ${kind} app (needs apps.${kind}_app.build_id and is_released: true)`));
        continue;
      }
      // The summary must describe THIS run's app. A clone that copied the apps
      // but never re-recorded the release keeps the source's record.
      if (r.hq_app_id && a?.hq_app_id && String(r.hq_app_id) !== String(a.hq_app_id)) {
        out.push({
          id: `app-release-other-app:${kind}`, area: 'apps', severity: 'blocker', owner: 'app-release',
          detail: `app-release_summary.md records a release of ${kind} app ${String(r.hq_app_id)}, but this run's ${kind} app is ${String(a.hq_app_id)}`,
          fix: "release this run's app and rewrite app-release_summary.md (on a clone: clone-to-new-workspace § 4a.3, then § 4e)",
        });
      }
      continue;
    }
    if (!runStateRelease(a)) out.push(unreleased(kind, `no released build recorded for the ${kind} app (app-release_summary.md unreadable, and run_state records none)`));
  }
  if (!files.some((f) => /app-release-qa_result\.ya?ml$/.test(f.path))) {
    out.push({ id: 'app-release-qa-missing', area: 'apps', severity: 'blocker', owner: 'app-release-qa', detail: 'no app-release-qa result — the released builds were never shown to install', fix: 'run app-release-qa' });
  }
  return out;
}

/** The run's decisions log in the inventory (a Google Doc named `decisions.yaml`). */
export const DECISIONS_FILE = /(^|\/)decisions\.ya?ml$/;

/**
 * Every decision row a partner reads on the public run-summary page reads as
 * plain language (`auditDecisionsPlainLanguage`, lib/decisions-enrich.ts): a
 * `plain` sentence on each, a `plain_value` where the option is jargon, and
 * no field ids, `=` expressions, run ids, record ids, issue numbers or
 * "Phase N" in what is shown. One blocker per producing skill, naming each
 * row id + field + token. Reproducer: spark-facilitator/20261001-2208, whose
 * public page showed `"meeting_conducted = yes"`, "opportunity ad6c2d40" and
 * "(Phase 6)" in decision rows.
 */
export function assessDecisionsPlainLanguage(files: readonly RunFile[]): ReleaseFinding[] {
  const file = files.find((f) => DECISIONS_FILE.test(f.path));
  if (!file) return [];
  if (!file.text) {
    return [{
      id: 'decisions-unread', area: 'public-summary', severity: 'blocker', owner: 'decisions-render',
      detail: 'decisions.yaml is in the run but its text could not be read, so its plain-language gate did not run',
      fix: 're-run the inventory step; decisions.yaml must be readable as text',
      summary: 'The list of build decisions on the review page could not be checked.',
      action: 'Run the readiness check again; if it repeats, ask the build team to look at the decisions file.',
    }];
  }
  let failures;
  try {
    failures = auditDecisionsPlainLanguage(parseDecisionsYaml(file.text)).findings;
  } catch (e) {
    return [{
      id: 'decisions-unparseable', area: 'public-summary', severity: 'blocker', owner: 'decisions-render',
      detail: `decisions.yaml does not parse: ${(e as Error).message.split('\n')[0]}`,
      fix: 'repair decisions.yaml so it parses (lib/decisions-schema.ts)',
      summary: 'The list of build decisions on the review page could not be read.',
      action: 'Ask the build team to repair the decisions file, then run the readiness check again.',
    }];
  }
  const bySkill = new Map<string, typeof failures>();
  for (const f of failures) bySkill.set(f.skill, [...(bySkill.get(f.skill) ?? []), f]);
  return [...bySkill].map(([skill, fs]) => {
    const rows = new Set(fs.map((f) => f.id)).size;
    return {
      id: `decisions-plain:${skill}`, area: 'public-summary' as const, severity: 'blocker' as const, owner: skill,
      detail: `${rows} decision row(s) a partner reads are not plain language — ${describePlainLanguageGate(fs)}`,
      fix: 'rewrite plain / plain_value / check_at / correct_looks_like on each row named (docs/decisions-contract.md § Plain-language gate)',
      summary: `${rows} item${rows === 1 ? '' : 's'} in the list of build decisions would show a partner internal field names, codes or build-stage numbers instead of a plain sentence.`,
      action: 'Ask the build team to rewrite those decisions in plain words, then run the readiness check again.',
    };
  });
}

/**
 * An unanswered `review_ask: required-before` decision row is a release
 * blocker naming the question (owner decision 2026-10-04,
 * docs/superpowers/specs/2026-10-04-open-questions-into-decisions-design.md):
 * the design said its answer is needed before a lifecycle gate, and no working
 * default is safe to show outside reviewers as settled. An unanswered
 * `recommended-confirmation` is NOT a finding — the run is built on it and the
 * decisions review is where it gets confirmed. Saved rulings in
 * `inputs/decision-overrides.yaml` (passed as `overrides`) answer an ask even
 * when the row was written before the ruling was saved. Unreadable or
 * unparseable logs are already blockers in `assessDecisionsPlainLanguage`.
 */
export function assessRequiredBeforeAsks(
  files: readonly RunFile[],
  overrides: readonly DecisionOverrideRow[] | null = null,
): ReleaseFinding[] {
  const file = files.find((f) => DECISIONS_FILE.test(f.path));
  if (!file?.text) return [];
  let log;
  try {
    log = parseDecisionsYaml(file.text);
  } catch {
    return [];
  }
  return requiredBeforeBlockers(log, { overrides }).blocking.map((a) => ({
    id: `required-before:${a.id}`,
    area: 'public-summary' as const,
    severity: 'blocker' as const,
    owner: a.skill,
    detail: `decision ${a.id} must be answered before ${a.needed_by} and is unanswered: ${a.question}`,
    fix: `get the answer from ${a.owner ?? 'its owner'}${a.answer_channel ? ` (${a.answer_channel})` : ''} and save it in the decisions review (inputs/decision-overrides.yaml)`,
    summary: `A question must be answered before ${a.needed_by} and has no answer yet: ${a.question}`,
    action: `Ask ${a.owner ?? 'the person who owns it'} to answer it in the decisions review, then run the readiness check again.`,
  }));
}

/** `commcare_get_subscription`'s output, as validate-release-readiness reads it. */
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
    return [{ id: 'hq-plan-unchecked', area: 'hq', severity: 'blocker', owner: 'validate-release-readiness', detail: `the plan of HQ space ${hqDomain} was not read`, fix: `commcare_get_subscription(domain: ${hqDomain}) → pass it as --hq-plan` }];
  }
  if (plan.domain && plan.domain !== hqDomain) {
    return [{ id: 'hq-plan-wrong-space', area: 'hq', severity: 'blocker', owner: 'validate-release-readiness', detail: `--hq-plan is for ${plan.domain}, but the run's apps are in ${hqDomain}`, fix: `commcare_get_subscription(domain: ${hqDomain})` }];
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

/** The release plan's problems (lib/release-plan.ts) as findings. */
export function assessPlan(problems: readonly PlanProblem[]): ReleaseFinding[] {
  return problems.map((p) => ({
    id: p.id,
    area: (p.id.startsWith('reviewers') ? 'reviewers' : p.id.startsWith('drive') ? 'drive' : 'release-plan') as ReleaseArea,
    severity: p.severity,
    owner: 'validate-release-readiness',
    detail: p.detail,
    fix: p.fix,
    summary: p.summary,
    action: p.action,
  }));
}

export interface ReleaseVerdict {
  schema_version: typeof RELEASE_READINESS_SCHEMA_VERSION;
  kind: typeof RELEASE_VERDICT_KIND;
  workspace: string;
  opp: string;
  run_id: string;
  checked_at: string;
  /** Newest write in the run folder the check saw (the verdict's own files excluded). */
  run_last_write: string;
  verdict: 'READY' | 'NOT_READY';
  /** True when the check ran read-only (no gate re-runs, no writes) — informational, never releasable. */
  read_only: boolean;
  counts: { blockers: number; warnings: number };
  /** Areas the check covered, each with its blocker / warning counts. */
  areas: Record<ReleaseArea, { blockers: number; warnings: number }>;
  blockers: ReleaseFinding[];
  warnings: ReleaseFinding[];
  /** Who the run is being released to (required for READY). */
  reviewers: Reviewer[];
  /** `runStateHash` of run_state.yaml as validated — the release refuses a different one. */
  run_state_hash: string;
  /** `planHash(release_plan)`, or null when there is no plan. */
  plan_hash: string | null;
  /** The exact share actions `/ace:release` executes — present only on READY. */
  release_plan: ReleasePlan | null;
}

export function runLastWrite(files: readonly RunFile[]): string {
  let max = 0;
  let iso = '';
  for (const f of files) {
    if (VERDICT_FILE.test(f.path)) continue;
    const v = t(f.modifiedTime);
    if (v > max) {
      max = v;
      iso = f.modifiedTime;
    }
  }
  return iso;
}

const AREAS: ReleaseArea[] = ['qa', 'eval', 'connect', 'previews', 'links', 'public-summary', 'chatbot', 'apps', 'hq', 'reviewers', 'drive', 'release-plan', 'run-state'];

export function buildReleaseVerdict(input: {
  workspace: string;
  opp: string;
  runId: string;
  checkedAt: string;
  files: readonly RunFile[];
  findings: readonly ReleaseFinding[];
  readOnly?: boolean;
  reviewers?: readonly Reviewer[];
  runStateHash?: string;
  plan?: ReleasePlan | null;
}): ReleaseVerdict {
  const seen = new Set<string>();
  const deduped = input.findings.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)));
  // One item per root cause, each with a plain `summary` / `action`
  // (lib/release-readiness-plain.ts). `detail` / `fix` are kept for compatibility.
  const unique = collapseSharedCauses(deduped).map((f) => ({
    ...f,
    ...(f.summary && f.action ? {} : plainFinding(f, { workspace: input.workspace })),
  }));
  const blockers = unique.filter((f) => f.severity === 'blocker');
  const warnings = unique.filter((f) => f.severity === 'warning');
  const areas = Object.fromEntries(
    AREAS.map((a) => [a, { blockers: blockers.filter((f) => f.area === a).length, warnings: warnings.filter((f) => f.area === a).length }]),
  ) as ReleaseVerdict['areas'];
  const reviewers = [...(input.reviewers ?? [])];
  // No reviewers → no plan → never READY, whatever else passed.
  const ready = blockers.length === 0 && reviewers.length > 0 && !!input.plan;
  const plan = ready ? input.plan! : null;
  return {
    schema_version: RELEASE_READINESS_SCHEMA_VERSION,
    kind: RELEASE_VERDICT_KIND,
    workspace: input.workspace,
    opp: input.opp,
    run_id: input.runId,
    checked_at: input.checkedAt,
    run_last_write: runLastWrite(input.files),
    verdict: ready ? 'READY' : 'NOT_READY',
    read_only: !!input.readOnly,
    counts: { blockers: blockers.length, warnings: warnings.length },
    areas,
    blockers,
    warnings,
    reviewers,
    run_state_hash: input.runStateHash ?? '',
    plan_hash: plan ? planHash(plan) : null,
    release_plan: plan,
  };
}

/** What `/ace:release` was asked to do — compared to the plan, never adapted to it. */
export interface ReleaseRequest {
  workspace: string;
  opp: string;
  runId: string;
  files: readonly RunFile[];
  /** `runStateHash` of run_state.yaml as it is now. */
  runStateHash: string;
  reviewers: readonly Reviewer[];
  options: ReleaseOptions;
}

/**
 * `/ace:release`'s gate. Releasable iff the most recent verdict is a READY
 * release-readiness verdict, was not a read-only dry run, belongs to THIS
 * workspace/opp/run, is newer than every write in the run folder, was taken
 * over the same run_state, carries an untampered plan, and that plan is for
 * exactly the reviewers and options requested now. Every mismatch refuses
 * with its reason; none is adapted to.
 */
export function releaseGate(verdict: Partial<ReleaseVerdict> | null, current: ReleaseRequest): { ok: boolean; reason: string } {
  const again = 'run /ace:validate-release-readiness on this run with the same reviewers and flags';
  const kind = (verdict as { kind?: string } | null)?.kind;
  if (!verdict) return { ok: false, reason: `no ${RELEASE_VERDICT_NAME} in the run — ${again}` };
  if (kind !== RELEASE_VERDICT_KIND || verdict.schema_version !== RELEASE_READINESS_SCHEMA_VERSION) {
    return { ok: false, reason: `the verdict is a ${kind ?? 'unknown'} v${verdict.schema_version ?? '?'} verdict with no release plan — ${again}` };
  }
  if (verdict.workspace !== current.workspace || verdict.opp !== current.opp || verdict.run_id !== current.runId) {
    return { ok: false, reason: `the verdict is for ${verdict.workspace}/${verdict.opp}/${verdict.run_id}, not ${current.workspace}/${current.opp}/${current.runId} — ${again} (in this workspace)` };
  }
  if (verdict.read_only) return { ok: false, reason: `the latest validation was a read-only dry run — ${again}` };
  if (verdict.verdict !== 'READY') {
    const list = (verdict.blockers ?? [])
      .map((b) =>
        b.summary
          ? `- ${b.summary} → ${b.action ?? b.fix}\n    (${b.owner}: ${b.detail} → ${String(b.fix).replace(/\n/g, '\n    ')})`
          : `- ${b.owner}: ${b.detail} → ${String(b.fix).replace(/\n/g, '\n    ')}`,
      )
      .join('\n');
    return { ok: false, reason: `validate-release-readiness says NOT_READY (${verdict.counts?.blockers ?? '?'} blocker(s)):\n${list}` };
  }
  const plan = verdict.release_plan;
  if (!plan || !Array.isArray(plan.actions)) return { ok: false, reason: `the READY verdict carries no release plan — ${again}` };
  if (!verdict.plan_hash || planHash(plan) !== verdict.plan_hash) {
    return { ok: false, reason: 'the release plan does not match its recorded hash — it was edited after validation; refusing' };
  }
  if (plan.workspace !== current.workspace || plan.opp !== current.opp || plan.run_id !== current.runId) {
    return { ok: false, reason: `the release plan is for ${plan.workspace}/${plan.opp}/${plan.run_id} — ${again}` };
  }
  const want = reviewersKey(current.reviewers);
  const have = reviewersKey(plan.reviewers ?? []);
  if (want !== have) {
    return { ok: false, reason: `the reviewers requested (${want || 'none'}) are not the reviewers validated (${have || 'none'}) — ${again}` };
  }
  for (const k of ['forward_source', 'allow_cross_workspace_forward', 'allow_shared_connect'] as const) {
    if (!!current.options[k] !== !!plan.options?.[k]) {
      return { ok: false, reason: `${k.replace(/_/g, '-')} is ${current.options[k] ? 'on' : 'off'} now but was ${plan.options?.[k] ? 'on' : 'off'} when validated — ${again}` };
    }
  }
  if (!verdict.run_state_hash || verdict.run_state_hash !== current.runStateHash) {
    return { ok: false, reason: `run_state.yaml changed after validation (hash ${verdict.run_state_hash || 'none'} → ${current.runStateHash}) — ${again}` };
  }
  const last = runLastWrite(current.files);
  if (t(last) > t(verdict.checked_at)) {
    return { ok: false, reason: `the run changed after the validation (last write ${last}, validated ${verdict.checked_at}) — ${again}` };
  }
  return { ok: true, reason: `READY, validated ${verdict.checked_at}, nothing written since; plan ${verdict.plan_hash} (${plan.actions.length} share actions)` };
}

/** The human report — plain markdown (rendered as a Google Doc by the skill). */
export function renderReleaseReport(v: ReleaseVerdict, planText?: string): string {
  const lines: string[] = [];
  lines.push(`# Release readiness — ${v.opp} / ${v.run_id}`);
  lines.push('');
  lines.push(`**${v.verdict === 'READY' ? 'READY to release' : 'NOT READY to release'}** — ${v.counts.blockers} blocker(s), ${v.counts.warnings} warning(s). Validated ${v.checked_at} in workspace \`${v.workspace}\`${v.read_only ? ' (read-only dry run — not releasable as recorded)' : ''}.`);
  lines.push('');
  lines.push(`Reviewers: ${v.reviewers?.length ? v.reviewers.map((r) => `${r.email} (${r.role})`).join(', ') : 'none named — a run cannot be READY without them'}.`);
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
    for (const f of list) {
      if (f.summary) {
        lines.push(`- **${f.summary}** ${f.action ?? ''}`.trimEnd());
        lines.push(`  - *For the build team (${f.area} · ${f.owner}):* ${f.detail}. *Fix:* ${f.fix.replace(/\n/g, '\n    ')}`);
        if (f.merged?.length) lines.push(`  - *Same cause as:* ${f.merged.join(', ')}`);
      } else {
        lines.push(`- **${f.area} · ${f.owner}** — ${f.detail}. *Fix:* ${f.fix.replace(/\n/g, '\n  ')}`);
      }
    }
  }
  if (v.release_plan && planText) {
    lines.push('');
    lines.push('## Release plan — what `/ace:release` will share, and nothing else');
    lines.push('');
    lines.push('```');
    lines.push(planText.trimEnd());
    lines.push('```');
  }
  return lines.join('\n') + '\n';
}

/**
 * What Phase 4 DECIDED, read back from run_state — the `decided` half of the
 * post-condition when validate-release-readiness re-runs it after the fact. A rule Connect
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
