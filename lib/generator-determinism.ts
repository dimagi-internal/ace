/**
 * Determinism contract for hand-authored synthetic-data generators.
 *
 * dimagi-internal/ace#1388. `spark-facilitator/20260813-2126` Phase 7 authored
 * its dataset with a hand-written Python generator instead of the labs manifest
 * DSL, and both its docstring and the run_state `authoring_note` asserted it was
 * "deterministic under one seed". It was not: re-running the unmodified script
 * gave 227 / 242 / 231 records against a shipped 232, with only 209 of the 232
 * record ids overlapping. That dataset is the substrate of a funder-facing
 * walkthrough asserting 232 records, 176 payable and a 33-record hero week — so
 * it now exists in exactly one place and cannot be regenerated.
 *
 * ## The cause was NOT the one the ticket named
 *
 * ace#1388 diagnosed set iteration steering the draw order. The generator
 * contains no `set()` at all. The actual cause is builtin `hash()` used as a
 * STABLE DERIVATION primitive:
 *
 *     h  = (hash((u, week)) >> 3) % 100   # how many records
 *     k  = (hash((week, u)) >> 5) % 100   # what kind the first one is
 *     ENTITY_ID = {u: uuid(random.Random(hash(c) & 0xFFFFFFFF)...) ...}
 *
 * `hash()` of a str — or of a tuple containing one — is randomised per process
 * by design (PEP 456, a collision-DoS mitigation). It is perfectly stable
 * WITHIN a process, which is exactly what makes it such an inviting idiom for
 * "derive a fixed value from a key", and it silently reshuffles across runs.
 * Here it decided the record COUNT, which is why the totals moved at all.
 *
 * Measured 2026-08-14 by replacing ONLY the `hash()` calls with a blake2b
 * digest and changing nothing else:
 *
 *     original:      232 / 237 / 221 records under PYTHONHASHSEED 1 / 2 / 3
 *     hash()-fixed:  224 / 224 / 224, sha256 1f5e7c89c572617f all three
 *
 * So `hash()` is the headline finding. Hash-ordered iteration is kept as a
 * second class because it produces the same symptom and the same remedy shape.
 *
 * ## The obvious self-check does not work
 *
 * The natural fix — "generate twice in one process, assert byte-identical" —
 * passes over this exact bug. `PYTHONHASHSEED` is drawn once per PROCESS, so
 * `hash('alice')` is fixed for that process's lifetime and both generations
 * walk the set in the same order. Measured (2026-08-14, python3, macOS):
 *
 *     in-process identical: True      <- both generations agree
 *     PYTHONHASHSEED=1 -> digest 43274
 *     PYTHONHASHSEED=2 -> digest 19928
 *     PYTHONHASHSEED=3 -> digest 48117
 *
 * A green in-process check over a live defect is worse than no check, so this
 * module treats one as its own finding rather than as compliance. The check
 * that catches it re-executes the generator across processes under DIFFERENT
 * hash seeds and compares the bytes.
 *
 * ## Scope, stated honestly
 *
 * The static half catches DIRECT iteration over a set-valued expression in a
 * loop that draws. It does NOT chase taint — a dict built by iterating a set
 * has nondeterministic insertion order, and iterating that dict is then just as
 * unsafe while looking innocent. That residual is why the cross-process check
 * is mandatory rather than advisory: it is the half that catches causes nobody
 * enumerated.
 *
 * Note `dict` iteration is deterministic on its own (insertion order, 3.7+) and
 * is not flagged; only `set` / `frozenset` are hash-ordered.
 */

export type DeterminismFindingKind =
  /** Builtin `hash()` used to derive a value that must survive the process. */
  | 'hash-builtin-derivation'
  /** A draw is consumed while iterating a hash-ordered container. */
  | 'unsorted-iteration-with-draw'
  /** A self-check exists but only compares generations within one process. */
  | 'in-process-only-selfcheck'
  /** No cross-process determinism check at all. */
  | 'missing-selfcheck';

export interface DeterminismFinding {
  kind: DeterminismFindingKind;
  /** 1-indexed line in the generator source, or 0 for whole-file findings. */
  line: number;
  detail: string;
  remedy: string;
}

export interface DeterminismReport {
  ok: boolean;
  findings: DeterminismFinding[];
}

/**
 * The mandated self-check, exported so the skill and the checker cannot drift.
 * Re-executes the generator under two different hash seeds and compares output
 * bytes. Both seeds are pinned, so the check is itself reproducible.
 */
export const CROSS_PROCESS_SELFCHECK = `
def assert_deterministic(argv):
    """Re-run this generator under two different PYTHONHASHSEEDs and compare.

    An in-process double-generate does NOT catch hash-order nondeterminism:
    PYTHONHASHSEED is drawn once per process, so both generations walk any set
    in the same order and agree. See ace#1388.
    """
    import hashlib, os, subprocess, sys
    if os.environ.get("ACE_DETERMINISM_CHILD"):
        return  # we are the child; just generate
    digests = []
    for seed in ("1", "2"):
        env = dict(os.environ, PYTHONHASHSEED=seed, ACE_DETERMINISM_CHILD="1")
        subprocess.run([sys.executable, *argv], env=env, check=True)
        digests.append(hashlib.sha256(open(OUT_PATH, "rb").read()).hexdigest())
    if digests[0] != digests[1]:
        raise SystemExit(
            "NON-DETERMINISTIC: output differs across hash seeds "
            f"({digests[0][:12]} vs {digests[1][:12]}). A draw is being made "
            "while iterating a set (or a dict built from one). Sort the "
            "iteration: 'for k in sorted(d)', never 'for k in d'. ace#1388"
        )
`.trim();

const DRAW_METHODS = [
  'random', 'randint', 'randrange', 'choice', 'choices', 'shuffle', 'sample',
  'uniform', 'gauss', 'normalvariate', 'betavariate', 'expovariate',
  'triangular', 'getrandbits',
];
const DRAW_RE = new RegExp(`\\.(?:${DRAW_METHODS.join('|')})\\s*\\(`);
/** `random.foo(...)` used bare, without an instance. */
const BARE_RANDOM_RE = new RegExp(`\\brandom\\.(?:${DRAW_METHODS.join('|')})\\s*\\(`);

const SET_CALL_RE = /^(?:frozen)?set\s*\(/;
/** `{a, b}` is a set; `{a: b}` and `{}` are dicts. */
const SET_LITERAL_RE = /^\{(?![\s]*\})/;

function isSetLiteral(expr: string): boolean {
  if (!SET_LITERAL_RE.test(expr)) return false;
  // A dict literal or a dict/set comprehension with a key: value pair has a
  // top-level colon. Walk depth so `{f(a[1:2])}` is not misread.
  let depth = 0;
  for (let i = 1; i < expr.length; i++) {
    const c = expr[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { if (depth === 0) break; depth--; }
    else if (c === ':' && depth === 0) return false;
  }
  return true;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Extract the iterable of a comprehension's `for ... in <expr>` clause.
 * Regex alone cannot do this: the expression may contain brackets of its own
 * (`sorted(names)`) while the comprehension's own closing bracket ends it, so
 * the scan has to track depth and stop only at depth zero.
 */
function comprehensionIterable(code: string): string | null {
  const m = /\bfor\s+\w+(?:\s*,\s*\w+)*\s+in\s+/.exec(code);
  if (!m) return null;
  let depth = 0;
  const start = m.index + m[0].length;
  for (let i = start; i < code.length; i++) {
    const c = code[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      if (depth === 0) return code.slice(start, i).trim() || null;
      depth--;
    } else if (depth === 0 && (c === ',' || code.startsWith(' if ', i) || code.startsWith(' for ', i))) {
      return code.slice(start, i).trim() || null;
    }
  }
  return code.slice(start).trim() || null;
}

function hasDraw(line: string, rngNames: Set<string>): boolean {
  if (BARE_RANDOM_RE.test(line)) return true;
  if (!DRAW_RE.test(line)) return false;
  // Only count it when the receiver is a known RNG, so `path.choice(` in some
  // unrelated helper does not fire.
  for (const name of rngNames) {
    if (new RegExp(`\\b${name}\\s*\\.`).test(line)) return true;
  }
  return false;
}

/**
 * Collect names bound to a set-valued expression or to an RNG, by a single
 * forward pass. Deliberately shallow — see the module note on taint.
 */
function collectBindings(lines: string[]): { setNames: Set<string>; rngNames: Set<string> } {
  const setNames = new Set<string>();
  const rngNames = new Set<string>();
  for (const raw of lines) {
    const m = /^\s*([A-Za-z_]\w*)\s*=\s*(.+?)\s*$/.exec(raw.split('#')[0]);
    if (!m) continue;
    const [, name, expr] = m;
    if (/^random\.Random\s*\(|^Random\s*\(/.test(expr)) rngNames.add(name);
    if (SET_CALL_RE.test(expr) || isSetLiteral(expr)) setNames.add(name);
    // Set algebra over a known set stays a set.
    else if (/[|&^-]/.test(expr)) {
      const operands = expr.split(/[|&^-]/).map((s) => s.trim());
      if (operands.length > 1 && operands.some((o) => setNames.has(o))) setNames.add(name);
    }
  }
  return { setNames, rngNames };
}

function isHashOrdered(expr: string, setNames: Set<string>): boolean {
  const e = expr.trim();
  if (/^sorted\s*\(/.test(e)) return false;
  // enumerate(sorted(x)) / reversed(sorted(x)) are ordered; enumerate(a_set) is not.
  const wrapped = /^(?:enumerate|reversed|list|tuple)\s*\((.*)\)\s*$/.exec(e);
  if (wrapped) return isHashOrdered(wrapped[1], setNames);
  if (SET_CALL_RE.test(e) || isSetLiteral(e)) return true;
  if (setNames.has(e)) return true;
  return false;
}

/**
 * Builtin `hash(` — excluding `hashlib.`, an attribute call like `obj.hash(`,
 * and any name that merely ends in `hash` such as `_stable_hash(`.
 */
const HASH_BUILTIN_RE = /(?<![\w.])hash\s*\(/;

export function checkGeneratorDeterminism(source: string): DeterminismReport {
  const lines = source.split('\n');
  const findings: DeterminismFinding[] = [];
  const { setNames, rngNames } = collectBindings(lines);

  for (let i = 0; i < lines.length; i++) {
    const code = lines[i].split('#')[0];
    if (!HASH_BUILTIN_RE.test(code)) continue;
    findings.push({
      kind: 'hash-builtin-derivation',
      line: i + 1,
      detail:
        'builtin `hash()` is randomised per process (PEP 456), so any value ' +
        'derived from it changes between runs — including counts, ids and seeds. ' +
        'It is stable WITHIN a process, which is what makes it look safe.',
      remedy:
        'derive from a stable digest instead: ' +
        '`int.from_bytes(hashlib.blake2b(repr(x).encode(), digest_size=8).digest(), "big")`',
    });
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const code = line.split('#')[0];
    const forMatch = /^\s*for\s+.+?\s+in\s+(.+?)\s*:\s*$/.exec(code);

    // A comprehension is a one-liner: its "body" is the same line.
    const comp = forMatch ? null : comprehensionIterable(code);
    if (comp && isHashOrdered(comp, setNames) && hasDraw(code, rngNames)) {
      findings.push({
        kind: 'unsorted-iteration-with-draw',
        line: i + 1,
        detail: `comprehension draws while iterating hash-ordered \`${comp}\``,
        remedy: `iterate \`sorted(${comp})\``,
      });
      continue;
    }
    if (!forMatch) continue;

    const iterable = forMatch[1];
    if (!isHashOrdered(iterable, setNames)) continue;

    const bodyIndent = indentOf(line);
    for (let j = i + 1; j < lines.length; j++) {
      const b = lines[j];
      if (!b.trim()) continue;
      if (indentOf(b) <= bodyIndent) break;
      if (hasDraw(b.split('#')[0], rngNames)) {
        findings.push({
          kind: 'unsorted-iteration-with-draw',
          line: j + 1,
          detail:
            `draw at line ${j + 1} is consumed inside \`for ... in ${iterable.trim()}\` ` +
            `(line ${i + 1}), which iterates in hash order`,
          remedy: `iterate \`sorted(${iterable.trim()})\` so the draw sequence is fixed`,
        });
        break; // one finding per loop is enough to act on
      }
    }
  }

  // The self-check half.
  const hasCrossProcess = /PYTHONHASHSEED/.test(source);
  const claimsSelfCheck =
    /def\s+assert_deterministic|deterministic|determinism/i.test(source);
  if (!hasCrossProcess) {
    const inProcessOnly =
      claimsSelfCheck && /==\s*\w*(?:gen|generate|build|make)\w*\s*\(|\bgen\w*\(\)\s*==/i.test(source);
    findings.push(
      inProcessOnly
        ? {
            kind: 'in-process-only-selfcheck',
            line: 0,
            detail:
              'the determinism self-check compares two generations within ONE process, ' +
              'which cannot observe hash-order nondeterminism — PYTHONHASHSEED is drawn ' +
              'once per process, so both generations walk any set in the same order',
            remedy:
              're-execute across processes under two different PYTHONHASHSEED values ' +
              'and compare output bytes (CROSS_PROCESS_SELFCHECK)',
          }
        : {
            kind: 'missing-selfcheck',
            line: 0,
            detail: 'no cross-process determinism check before upload',
            remedy: 'add CROSS_PROCESS_SELFCHECK and call it before writing the run folder',
          },
    );
  }

  return { ok: findings.length === 0, findings };
}
