/**
 * ace#1964 — discover the Bash-reachable scripts that must load the
 * plugin-data `.env`, so the rule is a CI ratchet instead of a list.
 *
 * ## The class
 *
 * A script under `scripts/` that a skill / agent / command invokes runs from a
 * plain Bash tool call, which inherits NONE of ACE's secrets. CLAUDE.md
 * § Gotchas says it plainly: "values are loaded into MCP subprocesses, not the
 * parent shell, so `$ACE_*` in your shell will normally be empty." So any such
 * script that reads a credential has to load `<plugin-data>/.env` itself, and
 * `lib/load-plugin-env.ts` is the one idiom for that (ace#1957).
 *
 * ace#1957 fixed two scripts and left the rest. The reason a backlog could
 * accumulate at all is that nothing DERIVED the set: each was a separate edit
 * nobody was tracking, and each failed only on the machine where the variable
 * happened not to be exported — reading as a provisioning or auth problem
 * rather than an env-loading one. So this module derives the set rather than
 * listing it, and `test/scripts/bash-reachable-env-loading.test.ts` asserts
 * over whatever it finds. A NEW offending script fails CI the day it lands.
 *
 * ## What counts
 *
 * - **Bash-reachable** — the script's basename appears anywhere under
 *   `skills/`, `agents/`, or `commands/`. Deliberately loose: a documented
 *   pointer ("diagnostic probe: `npx tsx scripts/x.ts`") is just as reachable
 *   as a fenced command block, and both are how an operator or an agent
 *   actually gets there.
 * - **Reads a secret** — it reads a `process.env` variable that the
 *   plugin-data `.env` is the source of truth for. That set is DERIVED from
 *   `.env.tpl`, the declared contract for what lives in `.env`, plus a small
 *   documented set of vars real `.env` files carry that the template does not
 *   declare (`EXTRA_GUARDED_VARS`). Anchoring to `.env.tpl` means adding a key
 *   to the template automatically widens the ratchet.
 *
 * A script matching both must call `loadPluginEnv(import.meta.url)` BEFORE its
 * first guarded read. Position matters, not mere presence: ESM evaluates the
 * whole module body top-down, and `scripts/run-nova-media-upload.ts` read
 * `NOVA_MCP_URL` at module top level, so a call placed "before `main()`" was
 * already too late (ace#1957 / PR #1965).
 *
 * ## Why the TypeScript AST and not a regex
 *
 * The first cut of this module blanked comments and strings with a hand-rolled
 * scanner. It silently mis-parsed `name.replace(/'/g, ...)` — the apostrophe
 * inside a regex literal opened a string that swallowed the next 400 lines, so
 * `scripts/grant-review-access.ts` reported its first credential read 467 lines
 * late and `scripts/probe-connect-learn-handoff.ts` dropped out of the results
 * entirely. That is the same failure `scripts/dump-atom-schemas.ts` already
 * carries (CLAUDE.md § Gotchas: a bare apostrophe in a `//` comment silently
 * drops every later atom), and a ratchet that under-detects is worse than no
 * ratchet — it reports green over the very thing it exists to catch. So the
 * parse goes through `typescript`, already a pinned devDependency and already
 * what CI type-checks with. `assertParsed` is the belt against the same class
 * one level up: a file the parser did not fully understand throws rather than
 * silently contributing zero reads.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

/**
 * Variables a real `<plugin-data>/.env` supplies that `.env.tpl` does not
 * declare. Each needs a reason — this is the only hand-maintained input, and
 * it must stay small or it becomes the stale list this module exists to avoid.
 */
export const EXTRA_GUARDED_VARS: Record<string, string> = {
  // Set in `.env` on a machine pointed at a non-production Nova; the ace#1957
  // regression test writes it into its throwaway `.env` for exactly this
  // reason. Absent from `.env.tpl` because production is the default.
  NOVA_MCP_URL: 'non-default Nova host, read from .env when present',
  // Same shape for connect-labs.
  LABS_BASE_URL: 'non-default connect-labs host, read from .env when present',
  // The shell-override spelling of the ace-web host, documented in
  // `commands/ace-web-pat-mint.md` and read by `scripts/ace-web-pat-mint.ts`
  // plus several skills. `.env.tpl` declares the same host as
  // `ACE_WEB_BASE_URL`, so the two names never meet and a machine provisioned
  // by `/ace:setup` supplies neither to those Bash paths — they always take the
  // hardcoded default. That drift is a named residual of ace#1964, out of its
  // scope because reconciling the names changes default semantics. Guarded here
  // so the script is at least held to loading `.env` at all.
  ACE_WEB_BASE: 'ace-web host, the shell-override spelling of ACE_WEB_BASE_URL',
  // The Google SA key path. ACE installs the key beside `.env` in plugin data,
  // and every Drive-touching script honours an override from the environment.
  GOOGLE_APPLICATION_CREDENTIALS: 'Google SA key path override',
};

/**
 * Scripts deliberately exempt from the rule, each with a reason. Empty is the
 * healthy state — an entry here is a hole in the ratchet and should be rare.
 */
export const EXEMPT_SCRIPTS: Record<string, string> = {};

/** The directories a script must be named in to count as Bash-reachable. */
export const REFERENCE_ROOTS = ['skills', 'agents', 'commands'];

/** Parse the `KEY=` names declared in `.env.tpl`. */
export function parseEnvTemplateKeys(tplSource: string): string[] {
  const keys = new Set<string>();
  for (const line of tplSource.split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (m) keys.add(m[1]);
  }
  return [...keys].sort();
}

/** The full guarded set: `.env.tpl` keys plus the documented extras. */
export function guardedVars(tplSource: string): Set<string> {
  return new Set([...parseEnvTemplateKeys(tplSource), ...Object.keys(EXTRA_GUARDED_VARS)]);
}

export interface EnvRead {
  variable: string;
  /** Character offset of the read in the source. */
  index: number;
  /** 1-based line number. */
  line: number;
}

export interface ScriptAnalysis {
  /** Every `process.env.<NAME>` / `process.env['NAME']` read, in source order. */
  envReads: EnvRead[];
  /** Offset of `loadPluginEnv(import.meta.url)`, or -1 when absent. */
  loaderIndex: number;
}

function isProcessEnv(node: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process' &&
    node.name.text === 'env'
  );
}

/**
 * Walk one TypeScript source and record every `process.env` read plus the
 * position of the `loadPluginEnv(import.meta.url)` call.
 *
 * Comments, strings, template literals and regex literals are handled by the
 * parser rather than by us, which is the whole point — see the module header.
 */
export function analyzeScriptSource(fileName: string, source: string): ScriptAnalysis {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  assertParsed(fileName, sf);
  const envReads: EnvRead[] = [];
  let loaderIndex = -1;

  const record = (variable: string, pos: number) => {
    envReads.push({
      variable,
      index: pos,
      line: sf.getLineAndCharacterOfPosition(pos).line + 1,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && isProcessEnv(node.expression)) {
      record(node.name.text, node.getStart(sf));
    } else if (
      ts.isElementAccessExpression(node) &&
      isProcessEnv(node.expression) &&
      ts.isStringLiteralLike(node.argumentExpression)
    ) {
      record(node.argumentExpression.text, node.getStart(sf));
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'loadPluginEnv' &&
      loaderIndex === -1
    ) {
      loaderIndex = node.getStart(sf);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);

  envReads.sort((a, b) => a.index - b.index);
  return { envReads, loaderIndex };
}

/**
 * Belt against the under-detection failure mode: a file the parser choked on
 * contributes zero reads and therefore passes, which is exactly how a broken
 * analyzer reports green over a real defect. TypeScript records syntax errors
 * on the source file, so surface them instead of swallowing them.
 */
export function assertParsed(fileName: string, sf: ts.SourceFile): void {
  const diags = (sf as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
  if (diags && diags.length > 0) {
    const first = ts.flattenDiagnosticMessageText(diags[0].messageText, ' ');
    throw new Error(
      `${fileName}: ${diags.length} parse diagnostic(s); the analyzer cannot ` +
        `trust this walk. First: ${first}`,
    );
  }
}

export interface ScriptFinding {
  /** Repo-relative path, e.g. `scripts/probe-nova-contract.ts`. */
  script: string;
  /** Files under skills/ agents/ commands/ that name it. */
  referencedBy: string[];
  /** Guarded vars it reads, deduped, in source order. */
  guardedVarsRead: string[];
  /** Its first guarded read — the one the loader has to precede. */
  firstRead: EnvRead;
  /** Offset of `loadPluginEnv(import.meta.url)`, or -1 when absent. */
  loaderIndex: number;
  /** True when the loader runs before the first guarded read. */
  ok: boolean;
}

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * Walk `scripts/*.ts` and return one finding per script that is both
 * Bash-reachable and reads a guarded variable. The `ok: false` entries are the
 * ratchet's failures.
 */
export function discoverBashReachableScripts(repoRoot: string): ScriptFinding[] {
  const guarded = guardedVars(fs.readFileSync(path.join(repoRoot, '.env.tpl'), 'utf8'));

  const referenceFiles: Array<{ rel: string; text: string }> = [];
  for (const root of REFERENCE_ROOTS) {
    for (const f of walk(path.join(repoRoot, root))) {
      referenceFiles.push({
        rel: path.relative(repoRoot, f),
        text: fs.readFileSync(f, 'utf8'),
      });
    }
  }

  const scriptsDir = path.join(repoRoot, 'scripts');
  const findings: ScriptFinding[] = [];
  for (const name of fs.readdirSync(scriptsDir).sort()) {
    if (!name.endsWith('.ts')) continue;
    const rel = `scripts/${name}`;
    if (rel in EXEMPT_SCRIPTS) continue;

    const base = name.replace(/\.ts$/, '');
    const referencedBy = referenceFiles.filter((f) => f.text.includes(base)).map((f) => f.rel);
    if (referencedBy.length === 0) continue;

    const source = fs.readFileSync(path.join(scriptsDir, name), 'utf8');
    const analysis = analyzeScriptSource(rel, source);
    const reads = analysis.envReads.filter((r) => guarded.has(r.variable));
    if (reads.length === 0) continue;

    findings.push({
      script: rel,
      referencedBy,
      guardedVarsRead: [...new Set(reads.map((r) => r.variable))],
      firstRead: reads[0],
      loaderIndex: analysis.loaderIndex,
      ok: analysis.loaderIndex > -1 && analysis.loaderIndex < reads[0].index,
    });
  }
  return findings;
}
