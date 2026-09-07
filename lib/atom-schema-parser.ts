/**
 * Static extraction of MCP atom registrations (`server.tool(...)`) and their
 * Zod-declared parameters, using the TypeScript compiler API.
 *
 * WHY AN AST AND NOT REGEXES (dimagi-internal/ace#2192)
 * ----------------------------------------------------
 * `docs/atom-schemas.md` is the file CLAUDE.md tells skill authors to grep
 * INSTEAD of paraphrasing an atom signature, so a wrong row there is worse
 * than a missing one. The previous text-pattern extractor had two defects with
 * one root cause — it was pattern-matching TypeScript rather than parsing it:
 *
 *   1. #2192 — the type's own argument list was `\([^)]*\)`, which cannot
 *      contain a `)`. On `patch: z.record(z.unknown()).optional().describe('…')`
 *      it consumed `z.record(z.unknown()` plus the FIRST `)`, so the
 *      modifier chain matched empty and `.optional()` / `.describe()` were
 *      never seen. 58 rows claimed **required** + no description for fields
 *      that are optional and documented. Deepening the regex by one nesting
 *      level was tried and reverted: it fixed ~30 rows and DROPPED 15 fields,
 *      because the scan resumed inside the object literal and emitted an inner
 *      field in place of the outer one — the silently-short-table failure
 *      ace#1278 calls out as worse than a blank description.
 *
 *   2. The comment-unaware bug named in CLAUDE.md § Gotchas. #757 taught the
 *      brace walkers to skip comments, but `extractAtomName` still used a bare
 *      "first quoted string" regex, so a line comment carrying an apostrophe
 *      between `server.tool(` and the atom name (`// Maestro's parser`) opened
 *      a phantom string, the name failed to parse, and the whole atom vanished
 *      from the catalog. The documented workaround was "drop the apostrophe".
 *
 * A real parser removes the class rather than re-pinning it to one more shape:
 * comments, template literals, nested calls and arbitrary paren nesting are
 * the scanner's problem, not ours. `typescript` is already a direct dependency.
 *
 * Scope note: this reads STRUCTURE, not types. It never type-checks, resolves
 * imports, or evaluates Zod — it walks one file's syntax tree. Fields whose
 * value is a shared schema const (`flags: VerificationFlagsZ`) still render a
 * row naming the const rather than expanding it; expanding would mean
 * statically evaluating arbitrary Zod composition, and a row that says "this
 * field exists, here is the schema to look up" is the honest floor (ace#1278).
 */
import * as ts from 'typescript';

export interface AtomField {
  name: string;
  /** Display type, already in final form: `z.string`, `z.coerce.number`, `HqAppZ`. */
  typeHint: string;
  optional: boolean;
  description: string;
}

export interface AtomEntry {
  name: string;
  description: string;
  fields: AtomField[];
}

/** Zod modifiers that make a field non-required. */
const OPTIONAL_MODIFIERS = new Set(['optional', 'nullable', 'nullish', 'default']);

/**
 * The repo's naming convention for a shared Zod schema constant
 * (`VerificationFlagsZ`, `HqAppZ`). A field referencing one renders a row
 * naming the const instead of being expanded — see the header note.
 */
const SHARED_SCHEMA_CONST = /^[A-Z][A-Za-z0-9_]*Z$/;

/** One `.foo(...)` link in a fluent chain, outermost-last after reversal. */
interface ChainStep {
  name: string;
  args: readonly ts.Expression[];
}

interface Decomposed {
  head: ts.Expression;
  steps: ChainStep[];
}

/**
 * Split `z.record(z.unknown()).optional().describe('…')` into its head (`z`)
 * and its TOP-LEVEL chain steps (`record`, `optional`, `describe`).
 *
 * This is the whole fix for #2192: nesting inside a step's ARGUMENTS is
 * structurally invisible here, so `z.unknown()` can never be mistaken for a
 * chain link and its closing paren can never terminate the chain early.
 */
function decompose(expr: ts.Expression): Decomposed {
  const steps: ChainStep[] = [];
  let cur: ts.Expression = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
      steps.push({ name: cur.expression.name.text, args: cur.arguments });
      cur = cur.expression.expression;
      continue;
    }
    break;
  }
  steps.reverse();
  return { head: cur, steps };
}

/**
 * The literal text of a string-ish expression, or null.
 *
 * Handles the three shapes ACE's servers actually use for prose: a plain
 * string literal, a template literal (with or without substitutions), and a
 * `+` concatenation of those with an interpolated constant
 * (`connect_list_programs`' description splices in
 * `PROGRAM_LIST_DESCRIPTION_SNIPPET_CHARS`). A non-literal operand is rendered
 * as its source text rather than dropped — a partly-symbolic contract still
 * beats a blank cell.
 */
function stringLiteralText(
  node: ts.Node | undefined,
  sf?: ts.SourceFile,
  consts?: Map<string, ts.Expression>,
): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    // `.text` is the COOKED value — the compiler has already resolved
    // source-level escapes (`\'`, `\n`, `\``), which is what the old
    // `unescapeStringLiteral` hand-rolled and got partly wrong.
    return node.text;
  }
  if (ts.isParenthesizedExpression(node)) return stringLiteralText(node.expression, sf, consts);
  // A `.describe()` written as a template with a substitution — e.g.
  // mobile_validate_recipe's `yaml`, which interpolates the allowed step-key
  // list. We cannot evaluate the expression statically, so render the literal
  // spans and keep each substitution as its `${…}` source.
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      out += `\${${sf ? span.expression.getText(sf) : span.expression.getText()}}`;
      out += span.literal.text;
    }
    return out;
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = stringLiteralText(node.left, sf, consts);
    const right = stringLiteralText(node.right, sf, consts);
    // Only a concatenation with at least one real string literal is prose; a
    // numeric `a + b` is not.
    if (left === null && right === null) return null;
    return (left ?? operandText(node.left, sf, consts)) + (right ?? operandText(node.right, sf, consts));
  }
  if (ts.isNumericLiteral(node)) return node.text;
  if (consts && ts.isIdentifier(node) && consts.has(node.text)) {
    const init = consts.get(node.text)!;
    if (init !== node) {
      const resolved = stringLiteralText(init, sf, consts);
      if (resolved !== null) return resolved;
    }
  }
  return null;
}

/**
 * Fallback rendering for a concatenation operand we could not read as prose —
 * typically a constant IMPORTED from another module, which this deliberately
 * single-file parser does not follow. Rendered as its symbol name in backticks
 * so a reader can see it is a reference and go look it up, rather than reading
 * a bare word as prose.
 */
function operandText(
  node: ts.Expression,
  sf?: ts.SourceFile,
  consts?: Map<string, ts.Expression>,
): string {
  const resolved = stringLiteralText(node, sf, consts);
  if (resolved !== null) return resolved;
  return `\`${(sf ? node.getText(sf) : node.getText()).replace(/\s+/g, ' ').trim()}\``;
}

/** Collapse a description to one table-cell-safe line. */
function normalizeProse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Render an expression as a short, single-line display string. */
function displayText(node: ts.Node, sf: ts.SourceFile): string {
  const raw = node.getText(sf).replace(/\s+/g, ' ').trim();
  return raw.length > 60 ? `${raw.slice(0, 57)}...` : raw;
}

/**
 * Top-level `const NAME = <expr>;` initializers in the file, so a field
 * declared by identifier (`server: HQ_SERVER_FIELD`) resolves to its real
 * schema instead of needing a hand-maintained alias table. The old parser
 * carried a `FIELD_ALIASES` map that had to be kept in sync by hand, with a
 * documented constraint that the aliased description contain no parentheses.
 * Both are gone.
 */
function collectTopLevelConsts(sf: ts.SourceFile): Map<string, ts.Expression> {
  const out = new Map<string, ts.Expression>();
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.initializer) {
        out.set(decl.name.text, decl.initializer);
      }
    }
  }
  return out;
}

function propertyKey(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null; // computed key — not statically nameable
}

function buildField(
  fieldName: string,
  valueExpr: ts.Expression,
  sf: ts.SourceFile,
  consts: Map<string, ts.Expression>,
): AtomField {
  let expr = valueExpr;
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;

  // A bare identifier that is NOT a shared-schema const (`HQ_SERVER_FIELD`)
  // resolves to its declaration so it renders like an inline field.
  if (
    ts.isIdentifier(expr) &&
    !SHARED_SCHEMA_CONST.test(expr.text) &&
    consts.has(expr.text)
  ) {
    expr = consts.get(expr.text)!;
  }

  const { head, steps } = decompose(expr);
  const headText = head.getText(sf).replace(/\s+/g, ' ').trim();

  let typeHint: string;
  if (steps.length === 0) {
    typeHint = displayText(head, sf);
  } else if (headText === 'z') {
    typeHint = `z.${steps[0].name}`;
  } else if (headText.startsWith('z.')) {
    // `z.coerce.number()` — the head is `z.coerce`, the first step is `number`.
    typeHint = `${headText}.${steps[0].name}`;
  } else {
    typeHint = displayText(head, sf);
  }

  const optional = steps.some((s) => OPTIONAL_MODIFIERS.has(s.name));

  // The LAST top-level `.describe()` wins, matching Zod's own semantics. A
  // `.describe()` nested inside another step's arguments (a CHILD field's
  // prose, as in `HqAppZ.extend({ description: z.string().describe('…') })`)
  // is not a step here at all, so it can never be mis-attributed to the parent.
  let description = '';
  for (const step of steps) {
    if (step.name !== 'describe') continue;
    const text = stringLiteralText(step.args[0], sf, consts);
    if (text !== null) description = normalizeProse(text);
  }

  if (!description && SHARED_SCHEMA_CONST.test(typeHint)) {
    description =
      `Shared schema \`${typeHint}\` — see its definition in the server source for the full shape.`;
  }

  return { name: fieldName, typeHint, optional, description };
}

/**
 * Resolve the argument that carries the Zod schema to the object literal whose
 * TOP-LEVEL properties are the atom's parameters.
 */
function resolveSchemaObject(
  expr: ts.Expression | undefined,
  consts: Map<string, ts.Expression>,
): ts.ObjectLiteralExpression | null {
  let cur = expr;
  for (let hops = 0; cur && hops < 4; hops++) {
    while (cur && ts.isParenthesizedExpression(cur)) cur = cur.expression;
    if (!cur) return null;
    if (ts.isObjectLiteralExpression(cur)) return cur;
    if (ts.isIdentifier(cur) && consts.has(cur.text)) {
      cur = consts.get(cur.text)!;
      continue;
    }
    // `z.object({ … })` used in the schema slot — unwrap to the literal.
    // Deliberately narrow: only a `z.*(...)` call, so an arbitrary helper call
    // in the handler slot can never be mistaken for a schema.
    if (
      ts.isCallExpression(cur) &&
      cur.arguments.length >= 1 &&
      ts.isPropertyAccessExpression(cur.expression) &&
      cur.expression.expression.getText().replace(/\s+/g, '') === 'z'
    ) {
      cur = cur.arguments[0];
      continue;
    }
    return null;
  }
  return null;
}

function extractFields(
  schema: ts.ObjectLiteralExpression,
  sf: ts.SourceFile,
  consts: Map<string, ts.Expression>,
): AtomField[] {
  const out: AtomField[] = [];
  const seen = new Set<string>();
  for (const prop of schema.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const key = propertyKey(prop.name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(buildField(key, prop.initializer, sf, consts));
      continue;
    }
    if (ts.isShorthandPropertyAssignment(prop)) {
      const key = prop.name.text;
      if (seen.has(key)) continue;
      seen.add(key);
      const init = consts.get(key);
      out.push(
        init
          ? buildField(key, init, sf, consts)
          : { name: key, typeHint: key, optional: false, description: '' },
      );
      continue;
    }
    if (ts.isSpreadAssignment(prop)) {
      // `{ ...COMMON_FIELDS, foo: z.string() }` — inline the spread source so
      // its fields are not silently absent from the table (ace#1278).
      const spread = resolveSchemaObject(prop.expression, consts);
      if (!spread) continue;
      for (const f of extractFields(spread, sf, consts)) {
        if (seen.has(f.name)) continue;
        seen.add(f.name);
        out.push(f);
      }
    }
  }
  return out;
}

/** True for a call expression of the form `<something>.server?.tool(...)`. */
function isServerToolCall(node: ts.Node, sf: ts.SourceFile): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (callee.name.text !== 'tool') return false;
  const target = callee.expression.getText(sf).replace(/\s+/g, '');
  return target === 'server' || target.endsWith('.server');
}

/**
 * Parse every `server.tool(...)` registration in one MCP server source file.
 *
 * Handles BOTH registration forms without counting commas:
 *   server.tool(name, schema, handler)
 *   server.tool(name, description, schema, handler)
 */
export function parseAtomsFromSource(src: string, fileName = 'server.ts'): AtomEntry[] {
  const sf = ts.createSourceFile(
    fileName,
    src,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const consts = collectTopLevelConsts(sf);
  const atoms: AtomEntry[] = [];

  const visit = (node: ts.Node): void => {
    if (isServerToolCall(node, sf)) {
      const args = node.arguments;
      const name = stringLiteralText(args[0], sf, consts);
      if (name && /^[a-z][a-z0-9_]*$/.test(name)) {
        // The schema is the FIRST argument after the name that resolves to an
        // object literal. Locating it by shape rather than by position handles
        // both registration forms — and, unlike a positional guess, survives a
        // description that is not a plain string literal (a `+` concatenation
        // or a template), which is what made `connect_list_programs` lose all
        // four of its parameters mid-fix.
        let description = '';
        let schema: ts.ObjectLiteralExpression | null = null;
        for (let i = 1; i < args.length; i++) {
          const obj = resolveSchemaObject(args[i], consts);
          if (obj) { schema = obj; break; }
          const prose = stringLiteralText(args[i], sf, consts);
          if (prose !== null && !description) description = normalizeProse(prose);
        }
        atoms.push({
          name,
          description,
          fields: schema ? extractFields(schema, sf, consts) : [],
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return atoms;
}
