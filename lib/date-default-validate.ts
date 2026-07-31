//
// Pure static check: does the CommCare DATE widget's default value (today)
// satisfy a field's `validate` (constraint) expression?
//
// Why this exists: dimagi-internal/ace#1081. The `connect-2.63.2` selector
// map has no calibrated date-widget row (no picker / spinner / calendar
// selector), so a Maestro smoke recipe CANNOT drive a date question to any
// value other than the widget default — which is today. That is fine for
// `. <= today()` / `. >= today()` constraints (today satisfies both), but a
// strictly-future/past constraint like
//
//   next_meeting_date  (kind: date, required)
//     validate: . > today() and . <= date(today() + 30)
//
// blocks the walk on that screen (`today() > today()` is false), and the
// recipe author has to either guess a selector (banned by "close the loop to
// the source of truth") or leave the branch unwalked. On
// spark-facilitator/20260730-1718 this silently rerouted the Deliver smoke to
// the non-payable branch and the gap surfaced on the emulator in Phase 6.
//
// This module shifts the discovery to Phase 3: `app-test-cases` runs it over
// every smoke-walked form's fields and fails loud NAMING THE FIELD when the
// widget default cannot satisfy the constraint — instead of burning Phase 6
// wall-clock. Same family as `lib/constraint-locality.ts`: the class is 100%
// mechanically detectable, so it is a parser, not a rubric line.
//
// Scope: a tiny, deliberately-conservative evaluator for the XPath-ish
// constraint dialect Nova emits on date fields. `.` and `today()` both
// evaluate to "today" (day-offset 0); `date(x)` is a cast passthrough;
// integer day arithmetic (`today() + 30`) is supported; comparisons and
// `and` / `or` / `not()` compose. ANYTHING else — node refs (`/data/foo`,
// `#form/...`), unknown functions (`now()`, `format-date(...)`), malformed
// syntax — yields `unverifiable`, never a pass and never a crash: the caller
// must surface it as "cannot statically verify", because a wrong `satisfied`
// here recreates the Phase-6 discovery this check exists to prevent.
//

export type DateDefaultVerdict = 'satisfied' | 'violated' | 'unverifiable';

export interface DateDefaultEvaluation {
  verdict: DateDefaultVerdict;
  /** Present when `verdict: 'unverifiable'` — what stopped static evaluation. */
  reason?: string;
}

/**
 * Evaluate a `validate` expression with `.` bound to the date widget's
 * default (today). Dates are modelled as integer day-offsets from today
 * (`today()` = 0, `today() + 30` = 30), which is exact for the
 * day-granularity arithmetic these constraints use.
 */
export function evaluateValidateWithTodayDefault(expr: string): DateDefaultEvaluation {
  const trimmed = (expr ?? '').trim();
  if (trimmed === '') {
    return { verdict: 'unverifiable', reason: 'empty validate expression' };
  }
  try {
    const value = new Parser(tokenize(trimmed)).parseFull();
    if (value.t !== 'bool') {
      return {
        verdict: 'unverifiable',
        reason: 'expression does not evaluate to a boolean',
      };
    }
    return { verdict: value.v ? 'satisfied' : 'violated' };
  } catch (e) {
    return {
      verdict: 'unverifiable',
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

// ── Field-level batch check ─────────────────────────────────────────────

/** One field row, as read from Nova `get_form` / the run-form-walk output. */
export interface DateFieldInput {
  /** Field id (the question's short name, e.g. `next_meeting_date`). */
  id: string;
  /** Nova field kind — only `date` rows are checked. */
  kind: string;
  required?: boolean;
  /** The field's `validate` (constraint) expression, when it has one. */
  validate?: string;
  label?: string;
}

export interface DateDefaultViolation {
  fieldId: string;
  validate: string;
  /**
   * `violated`     — today does NOT satisfy the constraint: the smoke walk
   *                  cannot advance past this screen (no calibrated
   *                  date-widget selector exists — ace#1081).
   * `unverifiable` — the expression could not be statically evaluated;
   *                  surface it for a human, do not assume it passes.
   */
  verdict: 'violated' | 'unverifiable';
  reason?: string;
}

export interface DateDefaultReport {
  /** Required `kind: date` fields examined. */
  dateFieldsChecked: number;
  violations: DateDefaultViolation[];
}

/**
 * Check every REQUIRED `kind: date` field in a smoke-walked form: the date
 * widget defaults to today, so a required date whose `validate` rejects
 * today stalls the recipe on that screen. A field with no `validate` is
 * always satisfiable (today is a valid date) and is counted but never
 * flagged.
 */
export function checkDateDefaultValidate(fields: DateFieldInput[]): DateDefaultReport {
  const violations: DateDefaultViolation[] = [];
  let dateFieldsChecked = 0;

  for (const f of fields) {
    if (f.kind !== 'date' || !f.required) continue;
    dateFieldsChecked++;
    const validate = f.validate?.trim();
    if (!validate) continue; // no constraint — the default always satisfies
    const evaluation = evaluateValidateWithTodayDefault(validate);
    if (evaluation.verdict === 'satisfied') continue;
    violations.push({
      fieldId: f.id,
      validate,
      verdict: evaluation.verdict,
      ...(evaluation.reason !== undefined ? { reason: evaluation.reason } : {}),
    });
  }

  return { dateFieldsChecked, violations };
}

/** One-line-per-violation human summary for a QA gate brief. */
export function formatDateDefaultValidateReport(report: DateDefaultReport): string {
  if (report.violations.length === 0) {
    return (
      `date-default-validate: PASS (${report.dateFieldsChecked} required date ` +
      `field(s) checked; the widget default (today) satisfies every constraint)`
    );
  }
  const violated = report.violations.filter((v) => v.verdict === 'violated');
  const unverifiable = report.violations.filter((v) => v.verdict === 'unverifiable');
  const lines = report.violations.map((v) =>
    v.verdict === 'violated'
      ? `  [BLOCKER] ${v.fieldId}: default (today) violates \`${v.validate}\` — ` +
        'no calibrated date-widget selector exists to pick another date (ace#1081)'
      : `  [WARN] ${v.fieldId}: cannot statically verify \`${v.validate}\`` +
        `${v.reason ? ` (${v.reason})` : ''} — confirm by hand that today satisfies it`,
  );
  const header =
    violated.length > 0
      ? `date-default-validate: FAIL (${violated.length} of ${report.dateFieldsChecked} ` +
        `required date field(s) reject the widget default` +
        (unverifiable.length > 0 ? `; ${unverifiable.length} unverifiable` : '') +
        ')'
      : `date-default-validate: WARN (${unverifiable.length} of ${report.dateFieldsChecked} ` +
        'required date field(s) carry a constraint this checker cannot statically verify)';
  return [header, ...lines].join('\n');
}

// ── Expression evaluator ────────────────────────────────────────────────
//
// Values are numbers (dates as day-offsets from today; plain numerics as
// themselves) or booleans. Every unsupported construct throws, which the
// public entry point converts to `unverifiable`.

type Value = { t: 'num'; v: number } | { t: 'bool'; v: boolean };

type Token =
  | { k: 'num'; v: number }
  | { k: 'ident'; v: string }
  | { k: 'self' } // a bare `.` (the node the constraint is bound to)
  | { k: 'op'; v: string } // <= >= != < > = + - *
  | { k: 'lparen' }
  | { k: 'rparen' }
  | { k: 'comma' };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    // Numbers: 30, 0.5, .5
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^[0-9]*\.?[0-9]+/.exec(src.slice(i))!;
      tokens.push({ k: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (c === '.') {
      // `..` (parent ref) is a path construct — unsupported.
      if (src[i + 1] === '.') throw new Error("unsupported path reference '..'");
      tokens.push({ k: 'self' });
      i++;
      continue;
    }
    // Identifiers / function names (XPath names may contain hyphens, e.g.
    // format-date; keep the hyphen so the error names the real function).
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(src.slice(i))!;
      tokens.push({ k: 'ident', v: m[0] });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '!=') {
      tokens.push({ k: 'op', v: two });
      i += 2;
      continue;
    }
    if ('<>=+-*'.includes(c)) {
      tokens.push({ k: 'op', v: c });
      i++;
      continue;
    }
    if (c === '(') {
      tokens.push({ k: 'lparen' });
      i++;
      continue;
    }
    if (c === ')') {
      tokens.push({ k: 'rparen' });
      i++;
      continue;
    }
    if (c === ',') {
      tokens.push({ k: 'comma' });
      i++;
      continue;
    }
    // `/data/...` node refs, `#form/...`, quotes, brackets, `@` — all
    // outside the supported dialect.
    throw new Error(`unsupported token '${c}' in validate expression`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  parseFull(): Value {
    const v = this.parseOr();
    if (this.pos < this.tokens.length) {
      throw new Error('unexpected trailing tokens in validate expression');
    }
    return v;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private peekIdent(name: string): boolean {
    const t = this.peek();
    return t?.k === 'ident' && t.v === name;
  }

  private next(): Token {
    const t = this.tokens[this.pos++];
    if (!t) throw new Error('unexpected end of validate expression');
    return t;
  }

  private parseOr(): Value {
    let left = this.parseAnd();
    while (this.peekIdent('or')) {
      this.pos++;
      const right = this.parseAnd();
      left = { t: 'bool', v: asBool(left, 'or') || asBool(right, 'or') };
    }
    return left;
  }

  private parseAnd(): Value {
    let left = this.parseComparison();
    while (this.peekIdent('and')) {
      this.pos++;
      const right = this.parseComparison();
      left = { t: 'bool', v: asBool(left, 'and') && asBool(right, 'and') };
    }
    return left;
  }

  private parseComparison(): Value {
    const left = this.parseAdditive();
    const t = this.peek();
    if (t?.k !== 'op' || !['<', '<=', '>', '>=', '=', '!='].includes(t.v)) {
      return left;
    }
    this.pos++;
    const right = this.parseAdditive();
    if (t.v === '=' || t.v === '!=') {
      if (left.t !== right.t) throw new Error(`type mismatch around '${t.v}'`);
      const eq = left.v === right.v;
      return { t: 'bool', v: t.v === '=' ? eq : !eq };
    }
    const l = asNum(left, t.v);
    const r = asNum(right, t.v);
    switch (t.v) {
      case '<':
        return { t: 'bool', v: l < r };
      case '<=':
        return { t: 'bool', v: l <= r };
      case '>':
        return { t: 'bool', v: l > r };
      default:
        return { t: 'bool', v: l >= r };
    }
  }

  private parseAdditive(): Value {
    let left = this.parseMultiplicative();
    for (;;) {
      const t = this.peek();
      if (t?.k !== 'op' || (t.v !== '+' && t.v !== '-')) return left;
      this.pos++;
      const right = this.parseMultiplicative();
      const v = t.v === '+' ? asNum(left, '+') + asNum(right, '+') : asNum(left, '-') - asNum(right, '-');
      left = { t: 'num', v };
    }
  }

  private parseMultiplicative(): Value {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t?.k === 'op' && t.v === '*') {
        this.pos++;
        left = { t: 'num', v: asNum(left, '*') * asNum(this.parseUnary(), '*') };
      } else if (t?.k === 'ident' && (t.v === 'div' || t.v === 'mod')) {
        const op = t.v;
        this.pos++;
        const r = asNum(this.parseUnary(), op);
        const l = asNum(left, op);
        left = { t: 'num', v: op === 'div' ? l / r : l % r };
      } else {
        return left;
      }
    }
  }

  private parseUnary(): Value {
    const t = this.peek();
    if (t?.k === 'op' && t.v === '-') {
      this.pos++;
      return { t: 'num', v: -asNum(this.parseUnary(), 'unary -') };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Value {
    const t = this.next();
    if (t.k === 'num') return { t: 'num', v: t.v };
    if (t.k === 'self') return { t: 'num', v: 0 }; // `.` = the default, today
    if (t.k === 'lparen') {
      const v = this.parseOr();
      this.expectRparen();
      return v;
    }
    if (t.k === 'ident') {
      const nextTok = this.peek();
      if (nextTok?.k !== 'lparen') {
        throw new Error(`unsupported reference '${t.v}'`);
      }
      this.pos++; // consume '('
      const args: Value[] = [];
      if (this.peek()?.k !== 'rparen') {
        args.push(this.parseOr());
        while (this.peek()?.k === 'comma') {
          this.pos++;
          args.push(this.parseOr());
        }
      }
      this.expectRparen();
      return this.callFunction(t.v, args);
    }
    throw new Error('unexpected token in validate expression');
  }

  private expectRparen(): void {
    const t = this.next();
    if (t.k !== 'rparen') throw new Error("expected ')'");
  }

  private callFunction(name: string, args: Value[]): Value {
    switch (name) {
      case 'today':
        if (args.length !== 0) throw new Error('today() takes no arguments');
        return { t: 'num', v: 0 };
      case 'date':
        // Cast passthrough: date(today() + 30) is already a day-offset.
        if (args.length !== 1) throw new Error('date() takes exactly one argument');
        return { t: 'num', v: asNum(args[0], 'date()') };
      case 'not':
        if (args.length !== 1) throw new Error('not() takes exactly one argument');
        return { t: 'bool', v: !asBool(args[0], 'not()') };
      case 'true':
        if (args.length !== 0) throw new Error('true() takes no arguments');
        return { t: 'bool', v: true };
      case 'false':
        if (args.length !== 0) throw new Error('false() takes no arguments');
        return { t: 'bool', v: false };
      default:
        // now(), format-date(), selected(), regex(), … — anything whose
        // semantics this checker does not model exactly.
        throw new Error(`unsupported function '${name}()'`);
    }
  }
}

function asNum(v: Value, ctx: string): number {
  if (v.t !== 'num') throw new Error(`expected a number/date operand for '${ctx}'`);
  return v.v;
}

function asBool(v: Value, ctx: string): boolean {
  if (v.t !== 'bool') throw new Error(`expected a boolean operand for '${ctx}'`);
  return v.v;
}
