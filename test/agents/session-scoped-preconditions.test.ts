import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';

// ---------------------------------------------------------------------------
// dimagi-internal/ace#1604 — a SESSION-scoped precondition must not be cached
// as PHASE-scoped state.
//
// The defect: `agents/commcare-setup.md § Step 0` is the hard gate that proves
// this session's Nova MCP connection is usable. `run_state.yaml` is per-RUN
// state that outlives the session, so on a mid-phase resume the executor steps
// over the already-`done` prefix of the phase — and Step 0 with it. Measured on
// `spark-facilitator/20260820-0817`: the resumed session's Nova connection was
// bound to a DIFFERENT principal than `NOVA_API_KEY` names, every Nova read
// answered normally about another account's apps, and the first call for this
// run's app returned `App not found` for an app built the day before. The L0
// binding fence did not cover it either: it gated on `pending` phases, and a
// resumed phase is `in_progress`.
//
// CLAUDE.md § "Phase preconditions are restored, not adapted" is the governing
// rule — declare the precondition, restore/verify it unconditionally on every
// entry, fail loud. This test makes that mechanical for the session-scoped
// class specifically, so the NEXT phase agent that adds an MCP-binding guard
// cannot regress the same way.
//
// SCOPE, deliberately narrow. Four assertions, each with a positive proof:
//   1. Every phase agent doc that guards a session-bound MCP connection
//      declares that guard SESSION-SCOPED and unconditional on resume.
//   2. Each such declaration actually says "resume" — a marker that omits the
//      entry it protects reads as ordinary emphasis.
//   3. The orchestrator's L0 binding fence covers `in_progress` phases, not
//      just `pending` — otherwise the fence is absent from the one entry that
//      needs it.
//   4. Both the fence and Phase 3's Step 0 assert Nova's PRINCIPAL (an
//      addressed `list_apps` check against the run's recorded `nova_app_id`s),
//      not merely that Nova's atoms resolve. A resolvable-but-wrong-principal
//      connection is invisible to a resolvability check.
// ---------------------------------------------------------------------------

const AGENTS_DIR = fileURLToPath(new URL('../../agents/', import.meta.url));

/** A guard about THIS SESSION's MCP connection — the class that must not be cached. */
const SESSION_BINDING_GUARD =
  /bind(s|ing)? at session start|did not bind at level 0|bound a different principal|respawned by `\/reload-plugins`/i;

const MARKER = 'SESSION-SCOPED PRECONDITION';

interface Line {
  n: number;
  text: string;
  /** Enclosing heading titles, outermost first. */
  path: string[];
}

function parse(file: string): Line[] {
  const md = readFileSync(`${AGENTS_DIR}${file}`, 'utf8');
  const out: Line[] = [];
  const stack: { level: number; title: string }[] = [];
  md.split('\n').forEach((text, i) => {
    const h = /^(#{1,6})\s+(.+?)\s*$/.exec(text);
    if (h) {
      const level = h[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title: h[2] });
    }
    out.push({ n: i + 1, text, path: stack.map((s) => s.title) });
  });
  return out;
}

/** Is section `a` the same as `b`, or an ancestor of it? */
function covers(a: string[], b: string[]): boolean {
  return a.length <= b.length && a.every((t, i) => t === b[i]);
}

function frontmatter(file: string): Record<string, unknown> {
  const md = readFileSync(`${AGENTS_DIR}${file}`, 'utf8');
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  if (!m) return {};
  try {
    return (yaml.parse(m[1]) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

const agentFiles = readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'));
/** Phase agents: the docs `/ace:run` executes as a numbered phase. */
const phaseDocs = agentFiles.filter((f) => typeof frontmatter(f).phase_ordinal === 'number');

describe('session-scoped preconditions are re-asserted on resume (#1604)', () => {
  it('finds the phase agent docs to check', () => {
    // Guards the guard: if frontmatter parsing silently returns nothing, the
    // rule below would pass vacuously.
    expect(phaseDocs.length).toBeGreaterThanOrEqual(5);
    expect(phaseDocs).toContain('commcare-setup.md');
    expect(phaseDocs).toContain('qa-and-training.md');
  });

  it('every phase agent guarding a session-bound MCP declares it session-scoped', () => {
    const offenders: string[] = [];

    for (const file of phaseDocs) {
      const lines = parse(file);
      const guards = lines.filter((l) => SESSION_BINDING_GUARD.test(l.text));
      if (guards.length === 0) continue;

      const markers = lines.filter((l) => l.text.includes(MARKER));
      const uncovered = guards.filter((g) => !markers.some((m) => covers(m.path, g.path)));
      if (uncovered.length === 0) continue;

      offenders.push(
        `${file}: ${uncovered.length} session-binding guard line(s) in a section with no ` +
          `"${MARKER}" declaration\n` +
          uncovered
            .slice(0, 4)
            .map((g) => `    agents/${file}:${g.n}  [${g.path.join(' > ')}]`)
            .join('\n'),
      );
    }

    expect(
      offenders.join('\n\n'),
      'A phase agent guards a fact about THIS Claude Code session (which MCP bound, ' +
        'and as which principal) without declaring the guard session-scoped.\n\n' +
        'Such a guard is stepped over on a mid-phase resume, because the resume reads ' +
        'per-RUN `run_state.yaml` step state written by a PREVIOUS session (ace#1604). ' +
        `Add a "${MARKER}" paragraph to the guard's section stating that it re-runs on ` +
        'every entry into the phase, including a mid-phase resume, whatever the recorded ' +
        'step state says. See CLAUDE.md § Phase preconditions are restored, not adapted.',
    ).toBe('');
  });

  it('each session-scoped declaration says it survives a resume', () => {
    const offenders: string[] = [];
    for (const file of phaseDocs) {
      const md = readFileSync(`${AGENTS_DIR}${file}`, 'utf8');
      if (!md.includes(MARKER)) continue;
      for (const block of md.split(MARKER).slice(1)) {
        if (!/resume/i.test(block.slice(0, 900))) {
          offenders.push(`agents/${file}: a "${MARKER}" declaration never mentions resume`);
        }
      }
    }
    expect(
      offenders.join('\n'),
      'The declaration exists but never names the entry it protects. The whole point is ' +
        'that a RESUME must re-run it; a marker that omits that reads as ordinary emphasis.',
    ).toBe('');
  });

  it('the L0 binding fence covers in_progress phases, not just pending', () => {
    const md = readFileSync(`${AGENTS_DIR}ace-orchestrator.md`, 'utf8');
    const start = md.indexOf('**Step 2a — Assert the atoms actually resolved');
    expect(start, 'orchestrator lost its Pre-flight Step 2a binding fence').toBeGreaterThan(-1);

    // Narrow to the run-shape sentence itself — the clause that decides WHICH
    // phases the fence covers. A whole-section scan is too loose: `in_progress`
    // appears in neighbouring prose for unrelated reasons, which would let the
    // exact ace#1604 regression back in.
    const shape = /Then assert, against the run's shape \(([^)]*)\)/.exec(md.slice(start));
    expect(shape, "Step 2a lost its 'against the run's shape' clause").not.toBeNull();

    expect(
      /in_progress/.test(shape![1]),
      'The L0 MCP-binding fence asserts atoms only for `pending` phases. A resumed phase ' +
        'is `in_progress`, so the fence is absent from exactly the entry that needs it — ' +
        'the defect in ace#1604. Gate on `pending` OR `in_progress`.',
    ).toBe(true);
  });

  it('the Nova binding check asserts the PRINCIPAL, not just resolvability', () => {
    const docs: [string, string][] = [
      ['agents/ace-orchestrator.md (Pre-flight Step 2a)', 'ace-orchestrator.md'],
      ['agents/commcare-setup.md (Step 0)', 'commcare-setup.md'],
    ];

    for (const [label, file] of docs) {
      const md = readFileSync(`${AGENTS_DIR}${file}`, 'utf8');
      expect(
        /list_apps/.test(md) && /nova_app_id/.test(md),
        `${label} must assert Nova's principal by checking the run's recorded ` +
          '`nova_app_id`s against `list_apps`. `get_hq_connection` returning ' +
          '`configured: true`, and Nova atoms merely RESOLVING, are both satisfied by a ' +
          'connection bound to a different account entirely (ace#1604).',
      ).toBe(true);
    }
  });
});
