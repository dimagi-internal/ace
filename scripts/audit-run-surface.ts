#!/usr/bin/env npx tsx
/**
 * Audit ACE's EXTERNAL REVIEW SURFACE for one run — the public run-summary page
 * an outside partner is sent to.
 *
 *   npx tsx scripts/audit-run-surface.ts <opp-slug> <run-id> [options]
 *
 * SUPERSEDES `scripts/check-summary-links.py`. That checker asked one question
 * ("does this URL resolve?") and answered it well; on 2026-08-14 it printed
 * `12 links · 0 BROKEN`, exit 0, on a page with twelve real defects, because
 * eleven of them were not link reachability. Its rules — the PRIVATE-DELIVERABLE
 * class, MEMBER-GATED, relative-URL resolution, per-reviewer membership — are
 * ported into `lib/run-surface-audit.ts` intact and are still enforced here.
 *
 * ── What it checks ────────────────────────────────────────────────────
 *
 *   A. CONTRACT     the payload is the shape this auditor knows how to audit.
 *                   An unknown section, a missing section, or a populated
 *                   section missing the key we read all BLOCK — never a silent
 *                   zero. (The auditor must fail loudly when its own
 *                   assumptions are wrong; see the lib header.)
 *   B. LINKS        every link, absolute AND relative, probed ANONYMOUSLY and
 *                   classified; plus the page's declared `access` tag checked
 *                   against what an outsider actually gets.
 *   C. CONFIDENTIAL secret-shaped values on the anonymous payload; a private
 *                   review's ledger republished; and a guard that the probe
 *                   really was anonymous.
 *   D. COMPLETENESS what the run produced (`run_state.yaml`) vs what the page
 *                   shows. Unverified without `--run-state`, and unverified
 *                   BLOCKS. Plus the deep-QA gate, whose evidence is the run
 *                   FOLDER rather than run_state (`/ace:qa-deep` writes no
 *                   pointer): unverified without `--run-files`, same rule.
 *   E. DOCS         each publicly-readable deliverable fetched and judged:
 *                   literal markdown on screen, and (with `--doc-source`)
 *                   content the Drive importer silently dropped.
 *   F. RENDER       a headless anonymous browser pass (`--render`) for the
 *                   things no payload check can see: a section that says "Not
 *                   created" while its data exists, the decision-edit
 *                   affordance, whether provenance is visible by default, and
 *                   whether the write paths answer.
 *
 * ── Probing posture ───────────────────────────────────────────────────
 *
 * ANONYMOUS by construction — no cookies, no service-account auth, no PAT. A
 * member's view is a different document (`viewer.is_member` changes what is
 * served) and a different test; if the payload comes back with
 * `viewer.is_member: true` this script says so and treats every
 * confidentiality conclusion as void.
 *
 * READ-ONLY. It never writes to Drive, never changes sharing, never sends
 * anything. The write paths are probed for REACHABILITY with a deliberately
 * invalid body, so the handler is proven live without a single fabricated
 * comment landing in a real opp. The end-to-end write ROUND-TRIP is covered
 * hermetically in ace-web's own test suite, against a fake Drive — see
 * `## What this cannot catch` in `skills/run-surface-audit/SKILL.md`.
 *
 * Exit 0 iff no `broken` and no `misleading` findings.
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  auditCompleteness,
  auditConfidentiality,
  auditDeepQaParity,
  auditContract,
  auditDocFidelity,
  auditGuideScreenshots,
  auditLinks,
  auditRender,
  auditReviewerMembership,
  auditUnresolvedMemberGates,
  classifyLink,
  collectUrls,
  isAceDeliverable,
  resolveDocSource,
  sortFindings,
  summarise,
  type DocProbe,
  type DocSourceMap,
  type Finding,
  type Memberships,
  type ProbedLink,
  type RenderReport,
} from '../lib/run-surface-audit.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

interface Args {
  slug: string;
  runId: string;
  workspace: string;
  base: string;
  json: boolean;
  render: boolean;
  reviewers: string[];
  memberships: string | null;
  runState: string | null;
  runFiles: string | null;
  docSource: string | null;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const args: Args = {
    slug: '',
    runId: '',
    workspace: 'dimagi-team',
    base: 'https://labs.connect.dimagi.com/ace',
    json: false,
    render: false,
    reviewers: [],
    memberships: null,
    runState: null,
    runFiles: null,
    docSource: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--workspace': args.workspace = argv[++i]; break;
      case '--base': args.base = argv[++i]; break;
      case '--json': args.json = true; break;
      case '--render': args.render = true; break;
      case '--reviewer': args.reviewers.push(argv[++i]); break;
      case '--memberships': args.memberships = argv[++i]; break;
      case '--run-state': args.runState = argv[++i]; break;
      case '--run-files': args.runFiles = argv[++i]; break;
      case '--doc-source': args.docSource = argv[++i]; break;
      default:
        if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
        positional.push(a);
    }
  }
  [args.slug, args.runId] = positional;
  if (!args.slug || !args.runId) {
    throw new Error('usage: audit-run-surface.ts <opp-slug> <run-id> [--render] [--reviewer <email>] [--memberships <json>] [--run-state <yaml>] [--run-files <json>] [--doc-source <json>]');
  }
  return args;
}

/**
 * Fetch with redirects followed, returning the landing status AND the landing
 * URL. Redirects are followed deliberately: a login redirect resolves to 200 on
 * the login page, and the distinction between "gated" and "broken" lives in
 * WHERE it landed, not in the first status.
 *
 * Explicitly anonymous: no credentials, no cookie jar.
 */
async function probe(url: string, timeoutMs = 20_000): Promise<{ status: number | null; finalUrl: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      redirect: 'follow',
      credentials: 'omit',
      headers: { 'User-Agent': 'ace-run-surface-audit/1 (anonymous outsider probe)' },
      signal: ctl.signal,
    });
    return { status: resp.status, finalUrl: resp.url || url };
  } catch (e) {
    return { status: null, finalUrl: String((e as Error).message ?? e) };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Plain-text (and image-count) export of a Google Doc, ANONYMOUSLY.
 *
 * Sequential and retried, not parallel. A first cut fired the txt and html
 * exports concurrently across every deliverable and Google throttled one of
 * them, which surfaced as "could not read this document" — a transient network
 * condition wearing the costume of a real finding. An auditor that cries wolf
 * gets ignored, so a read failure is retried once and reports the status it
 * actually saw.
 *
 * Returns `text: null` when the document genuinely could not be read.
 */
async function fetchDocText(url: string): Promise<{ text: string | null; images: number | null; why: string }> {
  const m = url.match(/\/d\/([A-Za-z0-9_-]{10,})/);
  if (!m) return { text: null, images: null, why: 'not a Drive document URL' };
  const id = m[1];
  // Slides and Sheets have no plain-text export; they are judged by the link
  // probe only, and this says so rather than reporting them unread.
  if (!url.includes('/document/')) return { text: null, images: null, why: 'not a Google Doc (no text export)' };

  async function get(fmt: 'txt' | 'html'): Promise<{ ok: boolean; body: string; status: number }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(`https://docs.google.com/document/d/${id}/export?format=${fmt}`, {
          redirect: 'follow',
          credentials: 'omit',
        });
        if (r.ok && !r.url.includes('accounts.google.com')) return { ok: true, body: await r.text(), status: r.status };
        if (attempt === 0) {
          await new Promise((res) => setTimeout(res, 1500));
          continue;
        }
        return { ok: false, body: '', status: r.status };
      } catch {
        if (attempt === 0) await new Promise((res) => setTimeout(res, 1500));
      }
    }
    return { ok: false, body: '', status: 0 };
  }

  const txt = await get('txt');
  if (!txt.ok) return { text: null, images: null, why: `text export answered HTTP ${txt.status || 'nothing'} anonymously` };
  const html = await get('html');
  return {
    text: txt.body,
    images: html.ok ? (html.body.match(/<img\b/gi) ?? []).length : null,
    why: '',
  };
}

/** Minimal YAML subset reader — reuse the repo's yaml dep. */
async function readYaml(file: string): Promise<unknown> {
  const { parse } = await import('yaml');
  return parse(readFileSync(file, 'utf8'));
}

/**
 * Distinct phase labels the payload says this run's decisions carry.
 *
 * Handed to the browser probe so "is provenance visible by default?" is keyed
 * to THIS run's data rather than to a pattern guessing at the page's copy.
 */
function phaseLabels(payload: unknown): string[] {
  const rows = (payload as Record<string, any> | null)?.decisions?.rows;
  if (!Array.isArray(rows)) return [];
  return [...new Set(rows.map((r) => String(r?.phase_label ?? '')).filter(Boolean))];
}

function runRenderProbe(pageUrl: string, labels: string[]): RenderReport {
  const script = path.join(HERE, 'audit-run-surface-render.ts');
  const res = spawnSync('npx', ['tsx', script, pageUrl, JSON.stringify(labels)], {
    encoding: 'utf8',
    timeout: 180_000,
    env: process.env,
  });
  const raw = (res.stdout || '').trim();
  const start = raw.indexOf('{');
  if (start === -1) {
    return {
      renderedHrefs: [],
      notCreatedLabels: [],
      decisionEditCommitsOnPick: null,
      provenanceVisibleByDefault: null,
      writePaths: { comment: null, edit: null },
      undetermined: [
        `the browser probe produced no report (exit ${res.status}): ${(res.stderr || '').slice(-400)}`,
      ],
    };
  }
  try {
    return JSON.parse(raw.slice(start)) as RenderReport;
  } catch (e) {
    return {
      renderedHrefs: [],
      notCreatedLabels: [],
      decisionEditCommitsOnPick: null,
      provenanceVisibleByDefault: null,
      writePaths: { comment: null, edit: null },
      undetermined: [`the browser probe's report was unparseable: ${String(e)}`],
    };
  }
}

async function main(): Promise<number> {
  const a = parseArgs(process.argv.slice(2));
  const base = a.base.replace(/\/$/, '');
  const apiUrl = `${base}/api/opps/public/${a.workspace}/${a.slug}/runs/${a.runId}/summary`;
  const pageUrl = `${base}/opps/${a.workspace}/${a.slug}/runs/${a.runId}/summary`;

  let payload: unknown;
  try {
    const resp = await fetch(`${apiUrl}?force=1`, { credentials: 'omit' });
    if (!resp.ok) {
      console.error(`FAILED to fetch the summary payload (HTTP ${resp.status}): ${apiUrl}`);
      return 2;
    }
    payload = await resp.json();
  } catch (e) {
    console.error(`FAILED to fetch the summary payload: ${apiUrl}\n  ${String(e)}`);
    return 2;
  }

  const findings: Finding[] = [];

  // ── A. Contract ────────────────────────────────────────────────
  const contractFindings = auditContract(payload);
  findings.push(...contractFindings);
  if (contractFindings.some((f) => f.code === 'CONTRACT-NOT-AN-OBJECT')) {
    report(findings, pageUrl, a);
    return 2;
  }

  // ── B. Links (anonymous) ───────────────────────────────────────
  const collected = collectUrls(payload, pageUrl);
  const seen = new Set<string>();
  const unique = collected.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));
  const probed: ProbedLink[] = [];
  for (const c of unique) {
    const { status, finalUrl } = await probe(c.url);
    const { cls, note } = classifyLink(c.url, status, finalUrl);
    probed.push({ ...c, status, cls, note });
  }
  findings.push(...auditLinks(probed));

  let memberships: Memberships = {};
  if (a.memberships) memberships = JSON.parse(readFileSync(a.memberships, 'utf8')) as Memberships;
  findings.push(...auditReviewerMembership(probed, a.reviewers, memberships));
  findings.push(...auditUnresolvedMemberGates(probed, a.reviewers));

  // ── C. Confidentiality ─────────────────────────────────────────
  findings.push(...auditConfidentiality(payload, { anonymous: true }));

  // ── D. Completeness ────────────────────────────────────────────
  const runState = a.runState ? await readYaml(a.runState) : null;
  findings.push(...auditCompleteness(payload, runState));
  // `/ace:qa-deep` writes NOTHING into run_state.yaml on purpose, so the
  // deep gate is invisible to the completeness check above. Its evidence
  // is the two verdict FILES in the run folder — hence a separate input,
  // and a separate call rather than a hop through auditCompleteness
  // (which early-returns when --run-state is absent, and would then
  // swallow a deep-QA finding that --run-files could still have proved).
  const runFiles: string[] | null = a.runFiles
    ? (JSON.parse(readFileSync(a.runFiles, 'utf8')) as string[])
    : null;
  findings.push(...auditDeepQaParity(payload, runFiles));

  // ── E. Document fidelity ───────────────────────────────────────
  // `null` means the flag was never passed. A url ABSENT from a map that WAS
  // passed stays `undefined` (unverified), not `null` — see resolveDocSource.
  const docSources: DocSourceMap | null = a.docSource
    ? (JSON.parse(readFileSync(a.docSource, 'utf8')) as DocSourceMap)
    : null;
  const docProbes: DocProbe[] = [];
  for (const l of probed) {
    if (!isAceDeliverable(l.url)) continue;
    if (l.cls !== 'OK') continue; // a private doc is already a `broken` finding
    const { text, images, why } = await fetchDocText(l.url);
    if (text === null && why.startsWith('not a Google Doc')) continue; // Slides/Sheets
    const src = resolveDocSource(docSources, l.url);
    docProbes.push({ label: l.label, url: l.url, text, imageCount: images, sourceMarkdown: src, unreadableReason: why || undefined });
  }
  findings.push(...auditDocFidelity(docProbes));
  findings.push(...auditGuideScreenshots(runState, docProbes));

  // ── F. Render ──────────────────────────────────────────────────
  let render: RenderReport | null = null;
  if (a.render) {
    render = runRenderProbe(pageUrl, phaseLabels(payload));
    findings.push(...auditRender(payload, render, pageUrl));
  } else {
    findings.push({
      code: 'RENDER-UNVERIFIED',
      severity: 'misleading',
      where: '(rendered page)',
      detail:
        'the rendered page was not opened, so nothing checked what a reader actually SEES. Four ' +
        'of the twelve defects this audit exists for are invisible to a payload check: a section ' +
        'that says "Not created" while its data exists, the decision-edit affordance, provenance ' +
        'hidden behind a collapsed disclosure, and documents that render as raw markdown',
      fix: 'pass --render (headless Chromium, anonymous context)',
    });
  }

  report(findings, pageUrl, a, probed, render);
  return summarise(findings).safeToShare ? 0 : 1;
}

function report(
  findings: Finding[],
  pageUrl: string,
  a: Args,
  probed: ProbedLink[] = [],
  render: RenderReport | null = null,
): void {
  const sorted = sortFindings(findings);
  const s = summarise(findings);
  if (a.json) {
    console.log(JSON.stringify({ page_url: pageUrl, summary: s, findings: sorted, links: probed, render }, null, 2));
    return;
  }
  console.log(`External review surface audit — ${a.slug}/${a.runId}`);
  console.log(`Page (as an anonymous outsider sees it): ${pageUrl}\n`);

  if (probed.length) {
    console.log(`Links probed anonymously: ${probed.length}`);
    const byClass = probed.reduce<Record<string, number>>((acc, l) => {
      acc[l.cls] = (acc[l.cls] ?? 0) + 1;
      return acc;
    }, {});
    console.log(
      '  ' +
        Object.entries(byClass)
          .map(([k, v]) => `${k} ${v}`)
          .join(' · '),
    );
    console.log('');
  }

  const label: Record<string, string> = {
    broken: 'BROKEN — a reviewer hits a wall',
    misleading: 'MISLEADING — the page states something untrue',
    improvement: 'IMPROVEMENT — it would confuse or underserve them',
  };
  for (const sev of ['broken', 'misleading', 'improvement'] as const) {
    const group = sorted.filter((f) => f.severity === sev);
    if (!group.length) continue;
    console.log(`${label[sev]}  (${group.length})`);
    for (const f of group) {
      console.log(`  [${f.code}] ${f.where}`);
      console.log(`     ${f.detail}`);
      console.log(`     fix: ${f.fix}`);
      if (f.defect) console.log(`     regression corpus: defect ${f.defect}`);
    }
    console.log('');
  }

  console.log(
    s.safeToShare
      ? `SAFE TO SHARE — 0 broken, 0 misleading, ${s.improvement} improvement(s).`
      : `NOT SAFE TO SHARE — ${s.broken} broken, ${s.misleading} misleading, ${s.improvement} improvement(s).`,
  );
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(2);
  },
);
