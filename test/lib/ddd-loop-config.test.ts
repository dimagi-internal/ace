/**
 * config/ddd-loop.yaml + lib/ddd-loop-config.ts — ACE's canopy DDD loop config.
 *
 * Three things can silently go wrong, and canopy reports none of them: it drops a
 * malformed key or an uncompilable regex without a word ("a config problem must
 * never stop a run"), and a regex that matches the wrong findings pins work the
 * loop could have done. So:
 *
 *   1. the template's keys mirror canopy's schema (`scripts/ddd/loop_config.py`);
 *   2. every `fixed_surfaces[].match` is run through PYTHON's `re` (canopy's
 *      engine — the patterns use `(?s)` / `(?-i:…)`, which JS regexes reject)
 *      against real findings from the 2026-10-15 runs: declined labs findings
 *      must route to their surface, recipe/narration findings must stay in;
 *   3. where canopy is installed, canopy's own `loop_config.load` reads the file
 *      the writer produced and `floor.scope_detail` pins the noora floor finding.
 *
 * Python-backed suites skip, visibly, where python3 (or canopy + uv) is absent.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  DDD_LOOP_TEMPLATE,
  dddDirForRunsDir,
  dddDispatchEnv,
  renderDddLoopConfig,
  writeDddLoopConfig,
} from '../../lib/ddd-loop-config';
import { phase7DddStep } from '../../lib/ddd-handoff';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE_TEXT = fs.readFileSync(DDD_LOOP_TEMPLATE, 'utf8');
const TEMPLATE = parseYaml(TEMPLATE_TEXT) as Record<string, any>;
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(REPO, 'test', 'fixtures', 'ddd-loop-config', 'findings.json'), 'utf8'),
) as { findings: Array<{ run: string; detail: string; fix_recommendation: string; expect: string }> };

interface Surface { name: string; match: string; owner?: string; issue?: string; repo?: string }
const SURFACES: Surface[] = TEMPLATE.loop.fixed_surfaces;

// Mirrors canopy scripts/ddd/loop_config.py (DDDConfig / LoopConfig / ProductConfig / LintConfig).
const TOP_KEYS = ['loop', 'deploy_gate', 'inner_loop', 'inner_loop_off_reason', 'timeouts', 'product', 'fix_gate', 'auth_preflight', 'target_rubric'];
const LOOP_KEYS = ['objective', 'mode', 'backlog_min_findings', 'full_rejudge_every', 'judge_tiering', 'inner_loop_hint_minutes', 'floor_first', 'fixed_surfaces', 'narrative_mode', 'scoped_capture', 'recurring_after', 'plateau_rounds', 'product_repo', 'max_new_issues', 'writable_scopes'];
const SURFACE_KEYS = ['match', 'name', 'owner', 'issue', 'repo'];
const PRODUCT_KEYS = ['floor', 'presentation_floor', 'block_severities', 'polish_pass', 'lint'];
const LINT_KEYS = ['max_words_per_screen', 'max_long_lines_per_screen', 'long_line_words', 'max_new_long_lines', 'glossary', 'fonts', 'jargon'];
// canopy owner_routing: `_REPO` / `_ISSUE` (`owner/repo`, `owner/repo#n`).
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const ISSUE_RE = /^[\w.-]+\/[\w.-]+#\d+$/;

function hasPython(): boolean {
  return spawnSync('python3', ['-c', 'pass'], { timeout: 15_000 }).status === 0;
}

/** Python `re.search(pat, text, re.I)` per surface, first match wins — canopy floor.scope_detail. */
function pyClassify(surfaces: Surface[], texts: string[]): string[] {
  const script = [
    'import json, re, sys',
    'd = json.load(sys.stdin)',
    'out = []',
    'for t in d["texts"]:',
    '    hit = "in"',
    '    for s in d["surfaces"]:',
    '        if re.search(s["match"], t, re.I):',
    '            hit = s["name"]; break',
    '    out.append(hit)',
    'print(json.dumps(out))',
  ].join('\n');
  const r = spawnSync('python3', ['-I', '-c', script], {
    input: JSON.stringify({ surfaces, texts }),
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`python failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

/** Python `re.compile` each pattern (null) or its error. */
function pyCompileErrors(patterns: string[]): Array<string | null> {
  const script =
    'import json, re, sys\nout = []\nfor p in json.load(sys.stdin):\n    try:\n        re.compile(p); out.append(None)\n    except re.error as e:\n        out.append(str(e))\nprint(json.dumps(out))';
  const r = spawnSync('python3', ['-I', '-c', script], { input: JSON.stringify(patterns), encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) throw new Error(`python failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

describe('config/ddd-loop.yaml — shape (mirrors canopy loop_config)', () => {
  it('uses only keys canopy reads', () => {
    for (const k of Object.keys(TEMPLATE)) expect(TOP_KEYS).toContain(k);
    for (const k of Object.keys(TEMPLATE.loop)) expect(LOOP_KEYS).toContain(k);
    for (const k of Object.keys(TEMPLATE.product)) expect(PRODUCT_KEYS).toContain(k);
    for (const k of Object.keys(TEMPLATE.product.lint)) expect(LINT_KEYS).toContain(k);
  });

  it('leaves workspace to the writer (it is per run)', () => {
    expect(TEMPLATE).not.toHaveProperty('workspace');
  });

  it('names the surfaces with owner, issue form and repo canopy routes on', () => {
    expect(SURFACES.map((s) => s.name)).toEqual([
      'connect-labs-chrome',
      'ace-synthetic-opp-naming',
      'labs-product-gap',
    ]);
    for (const s of SURFACES) {
      for (const k of Object.keys(s)) expect(SURFACE_KEYS).toContain(k);
      expect(s.owner, s.name).toBeTruthy();
      expect(s.repo, s.name).toMatch(REPO_RE);
      if (s.issue) expect(s.issue, s.name).toMatch(ISSUE_RE);
    }
    // The report PAGES are in scope since 2026-10-16 (ACE's Labs template workflows,
    // config/labs-report-templates.yaml): no surface may pin them again.
    expect(SURFACES.some((s) => s.name === 'labs-report-template')).toBe(false);
    // Registry, pipelines and data are Labs data the loop writes (Jon, 2026-10-16): no surface for them.
    for (const gone of ['labs-engine', 'labs-semantic-registry']) expect(SURFACES.some((s) => s.name === gone)).toBe(false);
    expect(SURFACES.find((s) => s.name === 'labs-product-gap')!.repo).toBe('dimagi-internal/connect-labs');
    const chrome = SURFACES.find((s) => s.name === 'connect-labs-chrome')!;
    expect(chrome.owner).toBe('Connect Labs');
    expect(chrome.repo).toBe('dimagi-internal/connect-labs');
    expect(TEMPLATE.loop.product_repo).toBe('dimagi-internal/connect-labs');
  });

  it('every surface carries the same keep-mixed-findings-in guard', () => {
    const guard = (m: string) => m.slice(0, m.indexOf(')).*?(') + 6);
    const guards = new Set(SURFACES.map((s) => guard(s.match)));
    expect(guards.size).toBe(1);
    expect([...guards][0].startsWith('(?s)^(?!')).toBe(true);
  });
});

describe.skipIf(!hasPython())('config/ddd-loop.yaml — regexes vs real findings (python re)', () => {
  it('every surface regex and jargon regex compiles under python re', () => {
    const pats = [...SURFACES.map((s) => s.match), ...Object.keys(TEMPLATE.product.lint.jargon)];
    expect(pyCompileErrors(pats)).toEqual(pats.map(() => null));
  });

  it('declined labs findings route to their surface; recipe/narration findings stay in', () => {
    const rows = FIXTURE.findings;
    expect(rows.filter((r) => r.expect === 'in').length).toBeGreaterThanOrEqual(30);
    for (const s of SURFACES) expect(rows.some((r) => r.expect === s.name), s.name).toBe(true);
    const got = pyClassify(SURFACES, rows.map((r) => `${r.detail} ${r.fix_recommendation}`));
    const wrong = rows
      .map((r, i) => ({ expect: r.expect, got: got[i], text: `${r.detail} ${r.fix_recommendation}`.slice(0, 140) }))
      .filter((x) => x.expect !== x.got);
    expect(wrong).toEqual([]);
  });

  it('pins the noora floor finding (the launcher over report text) to Connect Labs', () => {
    const floor = FIXTURE.findings.find((r) => r.detail.includes("floating 'Ask an agent' button occludes footer text"));
    expect(floor).toBeDefined();
    expect(pyClassify(SURFACES, [`${floor!.detail} ${floor!.fix_recommendation}`])).toEqual(['connect-labs-chrome']);
  });

  it('report-page findings (connect-labs#2578, kaduna) are IN scope; Labs chrome stays out', () => {
    const page = [
      "Two of the four headline tiles truncate their label: 'TRANSFER ...' and 'SHORT VISI...'. In the indicator_programme_report tile component, move the 'lower is better' direction chip to its own line.",
      'With no targets in the registry, the partner table still shows a legend for states that cannot occur. In indicator_programme_report, render the band legend and the Attention column only when an indicator defines a band.',
      "Delete the 'NOT RANKED · FOR COMPARISON ONLY' sub-header row from the Benchmarks table.",
      "In the indicator_opp_report Benchmarks strip, scale each row's peer marks to that row's own observed min-max range, not to a shared 0-100% axis.",
    ];
    expect(pyClassify(SURFACES, page)).toEqual(['in', 'in', 'in', 'in']);
    // Registry / pipeline / snapshot-shaped findings are Labs DATA the loop writes — IN.
    const data = [
      "[REGISTRY] Add a values map for visit_outcome in the semantic registry so 'not_home' reads 'Not at home'.",
      'The visits pipeline does not carry the transfer date; add the field to the pipeline schema.',
      'The snapshot does not carry per-day counts for the enrolment card.',
    ];
    expect(pyClassify(SURFACES, data)).toEqual(['in', 'in', 'in']);
    expect(pyClassify(SURFACES, ["The floating 'Ask an agent' launcher is drawn over the Exits trend card."])).toEqual(['connect-labs-chrome']);
  });

  it('a mixed finding that also asks for a recipe or narration change stays in', () => {
    const texts = [
      "The floating 'Ask an agent' button overlaps the table. RECIPE: move the hold so the table is above it.",
      'PRODUCT: remove the legend. NARRATION: say what plan means.',
      "Drop the Attention column; in the recipe, scroll_to the partner row before the hold.",
    ];
    expect(pyClassify(SURFACES, texts)).toEqual(['in', 'in', 'in']);
  });

  it('jargon additions flag the ACE vocabulary that reached page text, and not plain copy', () => {
    const jargon = Object.keys(TEMPLATE.product.lint.jargon).map((match, i) => ({ name: `j${i}`, match }));
    const leaked = [
      'Rayuwa Caregivers Alliance (example) (id: 10140 visits: 388)',
      'Invented example data generated for ACE run smallholder-seasonal/20261015-1402 (PDD v0.3).',
      'Built by ACE Phase 7 demo-data-setup',
    ];
    expect(pyClassify(jargon, leaked).every((h) => h !== 'in')).toBe(true);
    expect(pyClassify(jargon, ['Newborn care classes programme (synthetic) · 8 facilities · as of 11 Oct'])).toEqual(['in']);
  });
});

describe('lib/ddd-loop-config — DDD_DIR and the written config', () => {
  it('derives DDD_DIR beside the runs root, keyed the same', () => {
    expect(dddDirForRunsDir('/Users/x/.canopy/ddd/runs/ace-noora-health-20261015-1129')).toBe(
      '/Users/x/.canopy/ddd/ace-noora-health-20261015-1129',
    );
    expect(dddDirForRunsDir('~/.canopy/ddd/runs/ace-spark-facilitator-20261001-2208/')).toBe(
      '~/.canopy/ddd/ace-spark-facilitator-20261001-2208',
    );
    expect(() => dddDirForRunsDir('/Users/x/somewhere/else')).toThrow(/runs/);
  });

  it('renders workspace on top of the template and refuses a bad slug', () => {
    const out = renderDddLoopConfig(TEMPLATE_TEXT, 'connect');
    const parsed = parseYaml(out) as Record<string, any>;
    expect(parsed.workspace).toBe('connect');
    expect(parsed.loop).toEqual(TEMPLATE.loop);
    expect(() => renderDddLoopConfig(TEMPLATE_TEXT, 'connect; rm -rf /')).toThrow(/slug/);
    expect(() => renderDddLoopConfig('workspace: x\n', 'connect')).toThrow(/workspace/);
  });

  it('writes $DDD_DIR/config.yaml (expanding ~) and returns the dispatch exports', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ddd-loop-config-'));
    try {
      const r = writeDddLoopConfig({ runsDir: '~/.canopy/ddd/runs/ace-noora-health-20261015-1129', workspace: 'connect', home });
      expect(r.dddDir).toBe(path.join(home, '.canopy/ddd/ace-noora-health-20261015-1129'));
      expect(r.configPath).toBe(path.join(r.dddDir, 'config.yaml'));
      expect(fs.existsSync(r.runsDir)).toBe(true);
      expect((parseYaml(fs.readFileSync(r.configPath, 'utf8')) as any).workspace).toBe('connect');
      expect(r.env).toBe(dddDispatchEnv(r.runsDir, r.dddDir));
      expect(r.env).toContain(`export DDD_DIR="${r.dddDir}"`);
      expect(r.env).toContain(`export CANOPY_DDD_RUNS_DIR="${r.runsDir}"`);
      // Idempotent: a second write over the first is the same file.
      const first = fs.readFileSync(r.configPath, 'utf8');
      writeDddLoopConfig({ runsDir: r.runsDir, workspace: 'connect', home });
      expect(fs.readFileSync(r.configPath, 'utf8')).toBe(first);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('Phase 7 hand-off carries DDD_DIR', () => {
  const base = {
    prompt_file_id: '1abc',
    runs_dir: '/Users/x/.canopy/ddd/runs/ace-noora-health-20261015-1129',
    narrative_slug: 'newborn-care-classes-programme-cascade',
    resume_run_id: null,
    workspace: 'connect',
    prepared_at: '2026-10-16T00:00:00Z',
  };
  const step = (h: object) => phase7DddStep({ status: 'in_progress', products: { synthetic: { ddd_handoff: h } } });

  it('keeps a recorded ddd_dir', () => {
    const r = step({ ...base, ddd_dir: '/elsewhere/ddd' });
    expect(r.step === 'dispatch-ddd' && r.handoff.ddd_dir).toBe('/elsewhere/ddd');
  });

  it('derives ddd_dir for a hand-off written before the field existed (no rebuild)', () => {
    const r = step(base);
    expect(r.step).toBe('dispatch-ddd');
    expect(r.step === 'dispatch-ddd' && r.handoff.ddd_dir).toBe('/Users/x/.canopy/ddd/ace-noora-health-20261015-1129');
  });

  it('an odd runs_dir leaves ddd_dir unset rather than failing the hand-off', () => {
    const r = step({ ...base, runs_dir: '/tmp/custom-root' });
    expect(r.step).toBe('dispatch-ddd');
    expect(r.step === 'dispatch-ddd' && r.handoff.ddd_dir).toBeUndefined();
  });

  it('an empty ddd_dir is malformed', () => {
    expect(step({ ...base, ddd_dir: '  ' }).step).toBe('malformed');
  });

  it('Phase 7 and the orchestrator write the config and export DDD_DIR into the dispatch', () => {
    const phase7 = fs.readFileSync(path.join(REPO, 'agents', 'synthetic-data-and-workflows.md'), 'utf8');
    const orch = fs.readFileSync(path.join(REPO, 'agents', 'ace-orchestrator.md'), 'utf8');
    for (const doc of [phase7, orch]) {
      expect(doc).toContain('scripts/write-ddd-loop-config.ts');
      expect(doc).toContain('DDD_DIR');
    }
    expect(phase7).toMatch(/ddd_dir: \$DDD_DIR/);
  });
});

// ---------------------------------------------------------------------------
// canopy's own loader, where canopy is installed (CI: the canopy repo is private).
// ---------------------------------------------------------------------------

function canopyRuntime(): string | null {
  const ok = (d: string | undefined | null): d is string =>
    !!d && fs.existsSync(path.join(d, 'scripts', 'ddd', 'loop_config.py'));
  const env = process.env.CANOPY_RUNTIME_DIR;
  if (env) return ok(env) ? env : null;
  if (process.env.CANOPY_PLUGIN_DIR) {
    const d = path.join(process.env.CANOPY_PLUGIN_DIR, 'runtime');
    return ok(d) ? d : null;
  }
  try {
    const installed = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8'),
    );
    for (const [k, v] of Object.entries<any>(installed.plugins ?? {})) {
      if (!k.startsWith('canopy@')) continue;
      for (const inst of v ?? []) {
        const d = inst?.installPath && path.join(inst.installPath, 'runtime');
        if (ok(d)) return d;
      }
    }
  } catch {
    /* not installed */
  }
  return null;
}

const RUNTIME = canopyRuntime();
const HAS_UV = spawnSync('uv', ['--version'], { timeout: 15_000 }).status === 0;
/** `loop.writable_scopes` shipped in canopy#969; an older installed runtime skips (visibly) rather than fails. */
const HAS_WRITABLE_SCOPES = !!RUNTIME && fs.readFileSync(path.join(RUNTIME, 'scripts', 'ddd', 'loop_config.py'), 'utf8').includes('writable_scopes');

describe.skipIf(!RUNTIME || !HAS_UV || !HAS_WRITABLE_SCOPES)('canopy loop_config.load reads writable_scopes (canopy#969)', () => {
  it('round-trips [data, registry, seed] from the written config', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ddd-loop-canopy-ws-'));
    try {
      const r = writeDddLoopConfig({ runsDir: path.join(home, 'runs', 'ace-kaduna-graduation-20261015-1411'), workspace: 'connect', home });
      const script = [
        'import json, sys',
        `sys.path.insert(0, ${JSON.stringify(RUNTIME)})`,
        'from scripts.ddd import loop_config',
        'c = loop_config.load(json.load(sys.stdin)["dir"])',
        'print(json.dumps(list(c.loop.writable_scopes)))',
      ].join('\n');
      const out = spawnSync('uv', ['run', '--quiet', '--project', RUNTIME!, 'python', '-c', script], {
        input: JSON.stringify({ dir: r.dddDir }),
        encoding: 'utf8',
        timeout: 120_000,
      });
      expect(out.status, out.stderr).toBe(0);
      expect(JSON.parse(out.stdout.trim().split('\n').pop()!)).toEqual(['data', 'registry', 'seed']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!RUNTIME || !HAS_UV)('canopy loop_config.load reads the written config', () => {
  it('parses every surface, product_repo and jargon, and pins the noora floor finding', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ddd-loop-canopy-'));
    try {
      const r = writeDddLoopConfig({ runsDir: path.join(home, 'runs', 'ace-noora-health-20261015-1129'), workspace: 'connect', home });
      const floor = FIXTURE.findings.find((x) => x.detail.includes("floating 'Ask an agent' button occludes footer text"))!;
      const script = [
        'import json, sys',
        `sys.path.insert(0, ${JSON.stringify(RUNTIME)})`,
        'from scripts.ddd import loop_config, floor',
        'd = json.load(sys.stdin)',
        'c = loop_config.load(d["dir"])',
        'f = floor.scope_detail(d["finding"], surfaces=c.loop.surfaces, fixed_surfaces=c.loop.fixed_surfaces)',
        'print(json.dumps({"surfaces": [[s.name, s.owner, s.issue, getattr(s, "repo", None)] for s in c.loop.surfaces],',
        '  "product_repo": getattr(c.loop, "product_repo", None), "jargon": list(c.product.lint.jargon),',
        '  "scope": [f["edit_scope"], f["surface"], f["owner"]]}))',
      ].join('\n');
      const out = spawnSync('uv', ['run', '--quiet', '--project', RUNTIME!, 'python', '-c', script], {
        input: JSON.stringify({ dir: r.dddDir, finding: { detail: floor.detail, fix_recommendation: floor.fix_recommendation, route: 'PRODUCT' } }),
        encoding: 'utf8',
        timeout: 120_000,
      });
      expect(out.status, out.stderr).toBe(0);
      const got = JSON.parse(out.stdout.trim().split('\n').pop()!);
      expect(got.surfaces.map((s: string[]) => s[0])).toEqual(SURFACES.map((s) => s.name));
      expect(got.surfaces[2]).toEqual(['labs-product-gap', 'Connect Labs (product bug or missing feature)', null, 'dimagi-internal/connect-labs']);
      expect(got.product_repo).toBe('dimagi-internal/connect-labs');
      for (const j of Object.keys(TEMPLATE.product.lint.jargon)) expect(got.jargon).toContain(j);
      expect(got.scope).toEqual(['out', 'connect-labs-chrome', 'Connect Labs']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
