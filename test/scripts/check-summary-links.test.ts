/**
 * Preventer suite for `scripts/check-summary-links.py`.
 *
 * The checker is the ONLY structural gate between "an ACE run finished" and
 * "we hand the summary URL to an external partner". Two defects let a run whose
 * deliverables were all unreachable pass green on
 * `spark-facilitator/20260813-2126` (`12 links - 0 BROKEN`, exit 0):
 *
 *  1. A private `docs.google.com` 401 was bucketed as AUTH-GATED — the same
 *     class as a legitimate third-party login wall — and AUTH-GATED passes.
 *     `skills/run-summary-qa` has carried the correct rule in PROSE since
 *     ace#902 ("treat a private ACE-authored deliverable doc as a must-fix");
 *     prose the model must remember is not enforcement (the ace#1060 shape).
 *  2. `collect_urls` filtered on `v.startswith("http")`, so EVERY relative URL
 *     on the page was invisible — including the summary footer's
 *     `workbench_url` ("See the full build process"), which 404s anonymously.
 *
 * These tests pin both as executable rules. The script is stdlib-only python3
 * by design (it runs under whatever python3 an installed plugin finds on PATH),
 * so the tests drive it through `python3` the same way `test/hooks/*` do —
 * classification is exercised through the pure `classify()` / `collect_urls()`
 * entry points, so nothing here touches the network.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-summary-links.py');

/** Import the checker by path and run `expr`, returning its JSON value. */
function pyEval(expr: string): any {
  const harness = [
    'import importlib.util, json, sys',
    `spec = importlib.util.spec_from_file_location("csl", ${JSON.stringify(SCRIPT)})`,
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    `print(json.dumps(${expr}))`,
  ].join('\n');
  // PYTHONDONTWRITEBYTECODE: importing the script by path would otherwise
  // drop a scripts/__pycache__/*.pyc into the working tree on every test run.
  const r = spawnSync('python3', ['-c', harness], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  expect(r.stderr, `python3 harness failed: ${r.stderr}`).not.toMatch(/Traceback/);
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout);
}

const PAGE = 'https://labs.connect.dimagi.com/ace/opps/dimagi-team/spark-facilitator/runs/20260813-2126/summary';

describe('check-summary-links: a private ACE-authored deliverable is a FAILURE, not an auth wall', () => {
  it('classifies a private Google Doc 401 as PRIVATE-DELIVERABLE', () => {
    const [cls] = pyEval(
      'm.classify("https://docs.google.com/document/d/1YBIpgqFx934QaOjsk7M3qrZsptV5J1_-kC_z-zpHglE/edit", 401, "")',
    );
    expect(cls).toBe('PRIVATE-DELIVERABLE');
  });

  it('classifies a private Google Slides deck and a Drive file the same way', () => {
    expect(pyEval('m.classify("https://docs.google.com/presentation/d/abc/edit", 403, "")')[0]).toBe(
      'PRIVATE-DELIVERABLE',
    );
    expect(pyEval('m.classify("https://drive.google.com/file/d/abc/view", 401, "")')[0]).toBe(
      'PRIVATE-DELIVERABLE',
    );
  });

  it('counts PRIVATE-DELIVERABLE among the classes that fail the run', () => {
    expect(pyEval('list(m.FAILING_CLASSES)')).toEqual(
      expect.arrayContaining(['BROKEN', 'PRIVATE-DELIVERABLE']),
    );
  });

  it('keeps a genuine third-party login wall an AUTH-GATED pass', () => {
    expect(pyEval('m.classify("https://labs.connect.dimagi.com/solicitations/13666/", 200, "https://labs.connect.dimagi.com/labs/login/?next=/x")')[0]).toBe(
      'AUTH-GATED',
    );
    expect(pyEval('m.classify("https://example.org/paywalled", 401, "")')[0]).toBe('AUTH-GATED');
    expect(pyEval('list(m.FAILING_CLASSES)')).not.toContain('AUTH-GATED');
  });

  it('still passes a SHARED (public) Google Doc', () => {
    expect(pyEval('m.classify("https://docs.google.com/document/d/abc/edit", 200, "https://docs.google.com/document/d/abc/edit")')[0]).toBe(
      'OK',
    );
  });

  it('does not let the membership gate swallow a private Google deliverable', () => {
    // MEMBER-GATED is also a non-pass, but the operator-facing remedy differs
    // (confirm membership vs. share the file), so the classes must not merge.
    expect(pyEval('m.classify("https://www.commcarehq.org/a/connect-ace-prod/apps/view/x/", 401, "")')[0]).toBe(
      'MEMBER-GATED',
    );
  });
});

describe('check-summary-links: relative URLs are collected and checked', () => {
  it('resolves a root-relative workbench_url against the page URL, as a browser would', () => {
    const collected = pyEval(
      `m.collect_urls({"workbench_url": "/w/dimagi-team/opps/spark-facilitator/runs/20260813-2126"}, base_url=${JSON.stringify(PAGE)})`,
    );
    expect(collected).toEqual([
      [
        'workbench_url',
        'https://labs.connect.dimagi.com/w/dimagi-team/opps/spark-facilitator/runs/20260813-2126',
      ],
    ]);
  });

  it('collects relative URLs nested in lists and objects', () => {
    const collected = pyEval(
      `m.collect_urls({"training": {"docs": [{"url": "/ace/x"}]}}, base_url=${JSON.stringify(PAGE)})`,
    );
    expect(collected).toEqual([['training.docs[0].url', 'https://labs.connect.dimagi.com/ace/x']]);
  });

  it('still collects absolute URLs unchanged', () => {
    const collected = pyEval(
      `m.collect_urls({"apps": [{"hq_url": "https://www.commcarehq.org/a/d/apps/view/x/"}]}, base_url=${JSON.stringify(PAGE)})`,
    );
    expect(collected).toEqual([['apps[0].hq_url', 'https://www.commcarehq.org/a/d/apps/view/x/']]);
  });

  it('ignores incidental slash-prefixed strings that are not link fields', () => {
    const collected = pyEval(
      `m.collect_urls({"drive_path": "/ACE/spark-facilitator/runs", "note": "/not a url"}, base_url=${JSON.stringify(PAGE)})`,
    );
    expect(collected).toEqual([]);
  });
});

/**
 * dimagi-internal/ace#1060 — the check that actually matters was prose.
 *
 * Found by the same reviewer, the same way, for the THIRD time (Sophie
 * Feintuch: #913 app links 404, #916 access claimed without read-back, now the
 * Connect opportunity link on hh-poverty-targeting/20260728-0705).
 *
 * The checker reported `12 links · 0 BROKEN` with 4 MEMBER-GATED, and its own
 * output then said the right thing — "confirm every named reviewer actually
 * holds membership … or don't present the link to them as reviewer-facing".
 * But it probes ANONYMOUSLY, so it cannot perform that confirmation. The check
 * therefore got done by an agent choosing to comply, at exactly the moment
 * (about to send a reply) when it feels already-done. On 2026-07-23 that
 * produced a written claim to an external partner:
 *
 *   "The Connect opportunity — you already had access there, so nothing to do."
 *
 * A read-back showed she was not in `ai-demo-space`'s member table. The
 * sentence was false when written and stayed false for a week.
 *
 * What makes it worth automating rather than remembering: a reviewer who lacks
 * membership gets a flat 404, indistinguishable from "this run doesn't exist".
 * It never reads as "you need access", so the reviewer reports it as us
 * shipping a broken link — which is exactly how #913 and #916 were reported.
 *
 * The script probes anonymously by design and must NOT grow three auth paths.
 * So it takes the read-backs the existing tools already produce
 * (`grant-review-access.ts --dry-run` for HQ/OCS, `lib/connect-member-table.ts`
 * for Connect) and REFUSES TO CERTIFY without them, rather than guessing.
 */
describe('per-reviewer membership gate (#1060)', () => {
  it('maps each member-gated host to the read-back path that can answer for it', () => {
    expect(pyEval('m.member_surface("https://www.commcarehq.org/a/connect-ace-prod/apps/")')).toBe('hq');
    expect(pyEval('m.member_surface("https://www.openchatstudio.com/a/connect-ace/chatbots/1/")')).toBe('ocs');
    expect(pyEval('m.member_surface("https://connect.dimagi.com/a/ai-demo-space/opportunity/x/")')).toBe('connect');
    expect(pyEval('m.member_surface("https://docs.google.com/document/d/x/edit")')).toBe(null);
  });

  it('MEMBER-OK when the read-back says the reviewer is a member', () => {
    const r = pyEval(
      'm.classify_reviewer("https://connect.dimagi.com/a/ai-demo-space/opportunity/x/", ' +
        '"sfeintuch@dimagi.com", {"connect": {"sfeintuch@dimagi.com": True}})',
    );
    expect(r[0]).toBe('MEMBER-OK');
  });

  it('MEMBER-MISSING on the live 2026-07-23 case — she was not in ai-demo-space', () => {
    const r = pyEval(
      'm.classify_reviewer("https://connect.dimagi.com/a/ai-demo-space/opportunity/x/", ' +
        '"sfeintuch@dimagi.com", {"connect": {"sfeintuch@dimagi.com": False}})',
    );
    expect(r[0]).toBe('MEMBER-MISSING');
    expect(r[1]).toMatch(/404/);
  });

  it('MEMBER-UNVERIFIED when no read-back was supplied — it refuses to certify, it does not guess', () => {
    const r = pyEval(
      'm.classify_reviewer("https://connect.dimagi.com/a/ai-demo-space/opportunity/x/", ' +
        '"sfeintuch@dimagi.com", {})',
    );
    expect(r[0]).toBe('MEMBER-UNVERIFIED');
    expect(r[1], 'must name the tool that produces the evidence').toMatch(/grant-review-access|member_table/);
  });

  it('both non-OK classes block sharing', () => {
    expect(pyEval('sorted(m.REVIEWER_BLOCKING)')).toEqual(['MEMBER-MISSING', 'MEMBER-UNVERIFIED']);
  });

  it('a non-member-gated link is not judged per reviewer', () => {
    expect(
      pyEval('m.classify_reviewer("https://docs.google.com/document/d/x/edit", "a@b.c", {})'),
    ).toBe(null);
  });
});
