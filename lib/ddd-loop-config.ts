/**
 * Where an ACE run's canopy DDD loop keeps its config, and what goes in it.
 *
 * canopy reads per-repo loop config from `<ddd_dir>/config.yaml`
 * (`scripts/ddd/loop_config.py`: `loop.fixed_surfaces`, `loop.product_repo`,
 * `product.lint.jargon`, timeouts, …) and resolves `ddd_dir` as
 * `repo_root` arg > `DDD_DIR` env > git toplevel of cwd > `~/.canopy/ddd/<cwd-basename>`
 * (`runstate._resolve_ddd_dir`). ACE runs the loop from a non-repo cwd and never
 * set `DDD_DIR`, so the dir was whatever the session's cwd happened to be called —
 * observed as `~/.canopy/ddd/runtime/` and `~/.canopy/ddd/ace-kaduna-graduation-20261015-1411/`,
 * different per machine and per run. Nothing ACE-specific could be configured
 * there because there was no stable "there". The kaduna session improvised its
 * own config.yaml with bare-word surfaces (`labs`, `template`, `seed`); the noora
 * session had none and declined the same out-of-scope finding 145 times.
 *
 * ## The choice: `DDD_DIR = ~/.canopy/ddd/<key>` next to `CANOPY_DDD_RUNS_DIR = ~/.canopy/ddd/runs/<key>`
 *
 * `<key>` is the run-scoped `ace-<opp>-<run-id>` Phase 7 already pins the runs
 * root to (ace#2287, `lib/ddd-run-adoption.ts`). Using the same key:
 *   - is deterministic from what the hand-off already records (`runs_dir`), so a
 *     resumed or forked run lands on the same dir with nothing new to persist;
 *   - is exactly canopy's own out-of-repo layout (`~/.canopy/ddd/<name>/`), so a
 *     session that cd's into a dir of that name resolves to the same place;
 *   - keeps the runs root holding only run dirs. Nesting it as
 *     `<runs_dir>/ddd` would put a non-run directory where
 *     `resolveDddRunAdoption` and canopy's run listing enumerate runs.
 *
 * The config itself is versioned in `config/ddd-loop.yaml` and written fresh
 * before every dispatch (idempotent) with the run's canopy-web `workspace:` on
 * top — the same file canopy's auth already reads it from (ace#2805).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

export const DDD_LOOP_TEMPLATE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'config',
  'ddd-loop.yaml',
);

/** A canopy-web workspace slug (what `bin/ace-canopy-web --workspace` accepts). */
const WORKSPACE = /^[a-z0-9][a-z0-9_-]*$/i;

function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p.replace(/^\$HOME(?=\/|$)/, home);
}

/**
 * `~/.canopy/ddd/runs/<key>` → `~/.canopy/ddd/<key>`. Throws on any other shape —
 * a guessed config dir is the bug this module exists to remove.
 */
export function dddDirForRunsDir(runsDir: string): string {
  const trimmed = runsDir.trim().replace(/\/+$/, '');
  const key = path.basename(trimmed);
  const parent = path.dirname(trimmed);
  if (!key || path.basename(parent) !== 'runs') {
    throw new Error(
      `runs_dir ${JSON.stringify(runsDir)} is not <...>/runs/<key>; cannot derive DDD_DIR from it`,
    );
  }
  return path.join(path.dirname(parent), key);
}

/** The text written to `$DDD_DIR/config.yaml`: the template with `workspace:` on top. */
export function renderDddLoopConfig(template: string, workspace: string): string {
  if (!WORKSPACE.test(workspace)) {
    throw new Error(`workspace ${JSON.stringify(workspace)} is not a canopy-web workspace slug`);
  }
  const parsed = parseYaml(template) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('config/ddd-loop.yaml did not parse to a mapping');
  }
  if ('workspace' in parsed) {
    throw new Error('config/ddd-loop.yaml must not set workspace: — the writer adds the run\'s own');
  }
  return (
    '# Written by ACE scripts/write-ddd-loop-config.ts from config/ddd-loop.yaml.\n' +
    '# Do not edit here: it is rewritten before every DDD dispatch. Change the template.\n' +
    `workspace: ${workspace}\n\n` +
    template
  );
}

export interface WriteResult {
  dddDir: string;
  runsDir: string;
  configPath: string;
  /** The shell block a `canopy:ddd` dispatch prompt must carry. */
  env: string;
}

/** `export` lines for a dispatch prompt — a subagent does not inherit the shell. */
export function dddDispatchEnv(runsDir: string, dddDir: string): string {
  return `export CANOPY_DDD_RUNS_DIR="${runsDir}"\nexport DDD_DIR="${dddDir}"`;
}

/**
 * Write `<dddDir>/config.yaml` for a run. `dddDir` defaults to the one derived
 * from `runsDir`; `~` / `$HOME` are expanded so the printed exports are absolute.
 */
export function writeDddLoopConfig(opts: {
  runsDir: string;
  workspace: string;
  dddDir?: string | null;
  templatePath?: string;
  home?: string;
}): WriteResult {
  const home = opts.home ?? os.homedir();
  const runsDir = expandHome(opts.runsDir.trim(), home);
  const dddDir = expandHome((opts.dddDir ?? '').trim() || dddDirForRunsDir(runsDir), home);
  const content = renderDddLoopConfig(
    fs.readFileSync(opts.templatePath ?? DDD_LOOP_TEMPLATE, 'utf8'),
    opts.workspace,
  );
  fs.mkdirSync(dddDir, { recursive: true });
  fs.mkdirSync(runsDir, { recursive: true });
  const configPath = path.join(dddDir, 'config.yaml');
  fs.writeFileSync(configPath, content);
  return { dddDir, runsDir, configPath, env: dddDispatchEnv(runsDir, dddDir) };
}
