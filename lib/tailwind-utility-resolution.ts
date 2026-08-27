/**
 * Tailwind utility resolution for labs workflow `render_code`.
 *
 * WHY THIS EXISTS (ace#1662)
 * --------------------------
 * connect-labs builds its Tailwind bundle by purging against **its own
 * Django templates only**. A workflow's `render_code` lives in the labs
 * DATABASE and is never scanned by the content globs, so any utility labs
 * does not itself use in a template is dropped from the shipped bundle.
 *
 * It then fails SILENTLY, because a missing utility degrades to the
 * unstyled baseline rather than erroring:
 *   - a missing `bg-*`     computes to `rgba(0, 0, 0, 0)`  (invisible bar)
 *   - a missing `text-*`   falls to the inherited near-black
 *   - a missing `border-*` computes to the default `oklch(0.922 0 0)`
 *   - a missing `h-*`      collapses the element to 0px
 *
 * On `bednet-check-2-visit/20260825-1310`, `text-rose-700` styled
 * `consent 89.7% · below the 90% floor` — the only pay-affecting figure on
 * the LLO weekly-review dashboard — and had been rendering near-black for
 * an unknown number of prior runs.
 *
 * TWO PROPERTIES THE IMPLEMENTATION MUST RESPECT
 * ---------------------------------------------
 * 1. **Check against ENUMERATED CSS RULES, never computed styles.**
 *    `text-*` and `border-*` default to `currentColor`, so a
 *    computed-style probe returns a plausible colour for a utility that
 *    does not exist and yields FALSE PASSES. That is exactly why this
 *    survived visual inspection for months. Everything here reads the
 *    deployed stylesheet's class selectors.
 *
 * 2. **`space-y-*`, `list-disc` and `mx-auto` are probe blind spots.**
 *    They are present in the bundle but produce no rendering diff on a
 *    bare probe element (`space-y-*` targets `:not(:last-child)`;
 *    `list-disc`'s value is the CSS initial; `mx-auto` computes to `0px`
 *    on a full-width block). A naive "no visual diff ⇒ missing" check
 *    emits FALSE POSITIVES on all of them. Enumeration does not, and the
 *    tests pin that.
 *
 * THE GOVERNING RULE: any utility whose EXACT string does not appear in
 * labs' own scanned templates is unavailable — arbitrary or not, colour or
 * not. The purge is per-UTILITY, not per-family (`text-slate-700` exists
 * while `bg-slate-400` and `border-slate-400` do not) and `border-*` /
 * `text-*` do not mirror `bg-*`. So: no family-level heuristics for
 * deciding availability. Families are used ONLY to decide whether a token
 * is a Tailwind utility at all.
 *
 * Pure module: no I/O, no network. The CLI over it is
 * `scripts/check-render-code-utilities.ts`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** How a token was classified against the deployed stylesheet. */
export type UtilityStatus = 'present' | 'missing' | 'ignored';

export interface ExtractedToken {
  /** The raw whitespace-delimited token as it appears in the source. */
  token: string;
  /** 1-based line number of the string literal the token came from. */
  line: number;
  /**
   * How the token was reached: a class attribute, the value of a NAMED
   * non-class attribute (`data-testid`, `title`, `id`, ...), or any other
   * string literal.
   */
  origin: 'class-attribute' | 'attribute-value' | 'string-literal';
}

export interface UtilityFinding {
  token: string;
  status: UtilityStatus;
  /** Lines (1-based, ascending, de-duplicated) the token appears on. */
  lines: number[];
  /** Why an `ignored` token was not judged. Absent for present/missing. */
  ignoredReason?: IgnoredReason;
  /** Resolving near-neighbours, best first. Only for `missing`. */
  substitutions?: string[];
  /** Prose guidance for a `missing` token with no colour near-neighbour. */
  advice?: string;
  /** Coarse shape of a `missing` token — drives the advice. */
  kind?: MissingKind;
}

export type IgnoredReason =
  /** No hyphen and not in the sheet — indistinguishable from prose. */
  | 'bare-word'
  /** Shape is not a Tailwind utility (uppercase, punctuation, digits-first). */
  | 'not-utility-shaped'
  /** Hyphenated but no prefix matches any family in the stylesheet. */
  | 'unknown-family';

export type MissingKind = 'colour' | 'arbitrary-value' | 'other';

export interface ResolutionReport {
  present: UtilityFinding[];
  missing: UtilityFinding[];
  ignored: UtilityFinding[];
  /** Count of distinct class names enumerated from the stylesheet(s). */
  stylesheetClassCount: number;
}

// ---------------------------------------------------------------------------
// 1. Parse class selectors out of a stylesheet
// ---------------------------------------------------------------------------

/**
 * Unescape a CSS identifier: `text-\[11px\]` -> `text-[11px]`,
 * `hover\:bg-gray-50` -> `hover:bg-gray-50`, `bg-black\/50` -> `bg-black/50`,
 * `p-0\.5` -> `p-0.5`.
 *
 * Tailwind escapes every character that is not valid bare in a CSS ident, so
 * a naive `.className` grep MISSES exactly the arbitrary-value and variant
 * utilities that are most likely to be purged. Handling escapes is not
 * optional here.
 */
export function unescapeCssIdent(ident: string): string {
  return ident.replace(/\\(.)/g, '$1');
}

/**
 * Return the selector preludes of a stylesheet — the text immediately
 * preceding each `{`.
 *
 * Scanning only preludes (rather than the whole file) keeps declaration
 * VALUES out of the class enumeration: minified CSS is full of things like
 * `padding:0.5rem` and `url(...)` that a whole-file regex would mistake for
 * class selectors.
 */
export function extractSelectorPreludes(css: string): string[] {
  const preludes: string[] = [];
  let buf = '';
  let i = 0;
  const n = css.length;

  while (i < n) {
    const c = css[i];

    // Comments
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    // Strings inside selectors (attribute selectors, content:)
    if (c === '"' || c === "'") {
      const quote = c;
      buf += c;
      i++;
      while (i < n) {
        if (css[i] === '\\') {
          buf += css.slice(i, i + 2);
          i += 2;
          continue;
        }
        buf += css[i];
        if (css[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // Escapes carry through verbatim — they are part of the ident.
    if (c === '\\') {
      buf += css.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === '{') {
      preludes.push(buf);
      buf = '';
      i++;
      continue;
    }
    if (c === '}' || c === ';') {
      buf = '';
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  return preludes;
}

/**
 * A class selector: a `.` followed by an ident that starts with a letter,
 * `_`, `-`, or an escape sequence. Starting-char discipline is what keeps
 * `0.5rem` from being read as a class named `5rem`.
 */
const CLASS_SELECTOR_RE = /\.(?:\\.|[A-Za-z_-])(?:\\.|[A-Za-z0-9_-])*/g;

/**
 * Enumerate every class name defined by a stylesheet, un-escaped.
 *
 * This is THE source of truth for "does this utility resolve". Pass the
 * concatenation of every stylesheet the page loads.
 */
export function parseStylesheetClassNames(css: string): Set<string> {
  const out = new Set<string>();
  for (const prelude of extractSelectorPreludes(css)) {
    const matches = prelude.match(CLASS_SELECTOR_RE);
    if (!matches) continue;
    for (const m of matches) {
      out.add(unescapeCssIdent(m.slice(1)));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. Utility families (used ONLY to decide "is this token a utility at all")
// ---------------------------------------------------------------------------

/** Strip any leading variant segments (`hover:`, `sm:`, `data-[x]:`). */
export function stripVariants(token: string): string {
  let depth = 0;
  let lastColon = -1;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (c === ':' && depth === 0) lastColon = i;
  }
  return lastColon === -1 ? token : token.slice(lastColon + 1);
}

/**
 * Derive the set of utility FAMILY prefixes (each ending in `-`) present in
 * a stylesheet. `text-rose-600` yields `text-` and `text-rose-`.
 *
 * Families are deliberately self-derived rather than hardcoded: the
 * available set is a function of labs' own templates and drifts whenever
 * labs changes its UI, so a checked-in prefix list would go stale in the
 * same silent direction as the bug it guards.
 */
export function deriveUtilityFamilies(classNames: Iterable<string>): Set<string> {
  const families = new Set<string>();
  for (const raw of classNames) {
    let base = stripVariants(raw);
    if (base.startsWith('-')) base = base.slice(1);
    // Stop the family scan at the first arbitrary-value bracket: the inside
    // of `min-w-[52px]` is a value, not a family.
    const bracket = base.indexOf('[');
    const scan = bracket === -1 ? base : base.slice(0, bracket);
    let idx = scan.indexOf('-');
    while (idx !== -1) {
      families.add(base.slice(0, idx + 1));
      idx = scan.indexOf('-', idx + 1);
    }
  }
  return families;
}

// ---------------------------------------------------------------------------
// 3. Extract candidate utility tokens from render_code source
// ---------------------------------------------------------------------------

/** A token that could plausibly be a Tailwind class name. */
const UTILITY_SHAPE_RE = /^-?[a-z][a-z0-9]*(?:[-:/.[\]#%()a-z0-9_]*)$/;

/**
 * Pull every whitespace-delimited token out of every string literal in the
 * source, tagging class-attribute strings so a caller can report where a
 * miss lives.
 *
 * Scanning ALL string literals (not just `class=` / `className=`) is
 * required, not belt-and-braces: real render_code passes utilities around as
 * plain JS values —
 *
 *   var borderClass = p.belowConsent ? 'border-amber-300' : 'border-gray-200';
 *   tone={p.belowConsent ? 'font-semibold text-red-700' : 'text-gray-800'}
 *   className={'mt-0.5 text-sm ' + (props.tone || 'text-gray-800')}
 *
 * `text-rose-700`, the miss that started ace#1662, reached the DOM through
 * exactly that third form.
 */
/**
 * JS keywords after which a quote DOES open a string literal, even though
 * the preceding character is a word character (`return 'text-red-700'`).
 */
const PREFIX_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'new', 'delete',
  'void', 'instanceof', 'await', 'yield', 'throw',
]);

export function extractUtilityTokens(source: string): ExtractedToken[] {
  const out: ExtractedToken[] = [];
  const n = source.length;
  let i = 0;
  let line = 1;

  const advance = (to: number) => {
    for (let k = i; k < to && k < n; k++) if (source[k] === '\n') line++;
    i = to;
  };

  const emit = (content: string, startLine: number, origin: ExtractedToken['origin']) => {
    let ln = startLine;
    for (const piece of content.split('\n')) {
      for (const token of piece.split(/\s+/)) {
        if (token) out.push({ token, line: ln, origin });
      }
      ln++;
    }
  };

  /**
   * Does the quote at `q` actually OPEN a string literal?
   *
   * render_code is JSX, and JSX text nodes are full of apostrophes
   * (`the opportunity's data`, `this worker's rate`). Treating those as
   * string starts swallows the JSX that follows — including real
   * `className="..."` attributes — so utilities inside the swallowed region
   * are never checked. That silently RE-CREATES the ace#1662 blind spot
   * inside the checker meant to close it.
   *
   * Heuristic: a real opening quote never directly follows an identifier
   * character or a closing bracket, whereas a JSX-text apostrophe almost
   * always follows a word character. The keyword list covers `return 'x'`
   * and friends, where the preceding character IS a word character.
   */
  const opensStringLiteral = (q: number): boolean => {
    if (source[q] !== "'" && source[q] !== '"' && source[q] !== '`') return false;
    let j = q - 1;
    while (j >= 0 && /\s/.test(source[j])) j--;
    if (j < 0) return true;
    const prev = source[j];
    if (!/[A-Za-z0-9_$)\]]/.test(prev)) return true;
    let k = j;
    while (k >= 0 && /[A-Za-z]/.test(source[k])) k--;
    const word = source.slice(k + 1, j + 1);
    return PREFIX_KEYWORDS.has(word);
  };

  /**
   * JSX attributes that hold something other than classes and must not be
   * linted as utilities (ace#1699).
   *
   * `data-*` and `aria-*` are matched by prefix; they contain a hyphen, so
   * they can never be a JS identifier and the match is unambiguous. The rest
   * is a short, closed list of attribute names — deliberately not "any
   * identifier before an `=`", because `var cardBorder = 'border-slate-300'`
   * has exactly that shape and IS a utility the lint must keep catching
   * (it is one of the seven ace#1662 ground-truth misses).
   */
  const NON_CLASS_ATTRS = new Set([
    'title', 'id', 'alt', 'href', 'src', 'type', 'name', 'placeholder',
    'role', 'key', 'htmlFor', 'target', 'rel', 'value', 'label',
  ]);

  /**
   * How to treat a string literal that opens at `q`.
   *
   * A `data-testid` cannot hold utilities, and linting it is a false positive
   * that BLOCKS an upload — test-id first segments routinely match a Tailwind
   * family (`row-count`, `grid-toggle`, `text-filter`). ACE's own
   * `demo-narrative` requires a `testid:` selector on every scene action, so a
   * render_code a DDD walkthrough can drive must carry them (ace#1699).
   *
   * Everything else stays `string-literal` and IS classified:
   * `cond ? 'text-rose-700' : ''` and `var cardBorder = 'border-slate-300'`
   * are the shapes ace#1662 exists to catch.
   */
  /**
   * CSS property names whose VALUES are CSS keywords, never class names.
   *
   * A string literal sitting as the value of one of these keys is inline
   * styling — `alignItems: 'flex-end'` — and can never be a Tailwind class, so
   * linting it is a false positive that BLOCKS a correct upload. `flex-end` is
   * the canonical case: it is a valid `align-items` value and Tailwind spells
   * the equivalent utility `items-end`, so it can never resolve against any
   * stylesheet and the check can never pass on it. The tool's own remedy for a
   * miss — "use an inline style prop" — is already what such code does
   * (ace#1744).
   *
   * This is deliberately a CLOSED list of CSS property names rather than "any
   * camelCase key before a colon". `className` and `tone` are also object keys
   * that hold utilities (`{ className: 'text-red-700' }`,
   * `tone={p.bad ? 'text-red-700' : 'text-gray-800'}`), and those must keep
   * being linted — they are the ace#1662 shapes. Same reasoning as
   * NON_CLASS_ATTRS above: name the exceptions, never the general shape.
   */
  const CSS_KEYWORD_PROPS = new Set([
    'alignItems', 'alignSelf', 'alignContent', 'justifyContent', 'justifyItems',
    'justifySelf', 'flexDirection', 'flexWrap', 'display', 'position', 'float',
    'clear', 'overflow', 'overflowX', 'overflowY', 'textAlign', 'textTransform',
    'textDecoration', 'verticalAlign', 'whiteSpace', 'wordBreak', 'overflowWrap',
    'visibility', 'cursor', 'pointerEvents', 'boxSizing', 'objectFit',
    'backgroundRepeat', 'backgroundSize', 'backgroundPosition', 'borderStyle',
    'fontStyle', 'fontWeight', 'fontVariantNumeric', 'listStyleType',
    'resize', 'userSelect', 'writingMode', 'tableLayout', 'captionSide',
    'mixBlendMode', 'isolation', 'objectPosition', 'transformOrigin',
  ]);

  /**
   * Is the string opening at `q` the value of an inline-style CSS property?
   * Matches the object-property shape `<cssProp>: '<value>'`, which is how
   * every inline style in render_code is written.
   */
  const isCssKeywordValue = (q: number): boolean => {
    let j = q - 1;
    while (j >= 0 && /\s/.test(source[j])) j--;
    if (j < 0 || source[j] !== ':') return false;
    j--;
    while (j >= 0 && /\s/.test(source[j])) j--;
    const end = j + 1;
    while (j >= 0 && /[A-Za-z]/.test(source[j])) j--;
    const name = source.slice(j + 1, end);
    return CSS_KEYWORD_PROPS.has(name);
  };

  const originFor = (q: number): ExtractedToken['origin'] => {
    if (isClassAttribute(q)) return 'class-attribute';
    if (isCssKeywordValue(q)) return 'attribute-value';
    // JSX attribute shape only: <name>="..." with no space around the `=`.
    let j = q - 1;
    while (j >= 0 && /[{(]/.test(source[j])) j--;
    if (j < 0 || source[j] !== '=') return 'string-literal';
    j--;
    const end = j + 1;
    while (j >= 0 && /[A-Za-z0-9_:-]/.test(source[j])) j--;
    const name = source.slice(j + 1, end);
    if (!name || (j >= 0 && !/[\s{]/.test(source[j]))) return 'string-literal';
    if (/^(data|aria)-/.test(name) || NON_CLASS_ATTRS.has(name)) return 'attribute-value';
    return 'string-literal';
  };

  /** Is the string that starts at `q` the value of a class attribute? */
  const isClassAttribute = (q: number): boolean => {
    let j = q - 1;
    // Skip whitespace and the JSX-expression opener, but NOT the `=` we are
    // looking for.
    while (j >= 0 && /[\s{(]/.test(source[j])) j--;
    if (j < 0 || source[j] !== '=') return false;
    j--;
    while (j >= 0 && /\s/.test(source[j])) j--;
    const end = j + 1;
    while (j >= 0 && /[A-Za-z]/.test(source[j])) j--;
    const name = source.slice(j + 1, end);
    return name === 'class' || name === 'className';
  };

  /** Consume a quoted string starting at `i` (which points at the quote). */
  const readQuoted = (origin: ExtractedToken['origin']) => {
    const quote = source[i];
    const startLine = line;
    let j = i + 1;
    let content = '';
    while (j < n) {
      if (source[j] === '\\') {
        content += source[j + 1] ?? '';
        j += 2;
        continue;
      }
      if (source[j] === quote) break;
      content += source[j];
      j++;
    }
    emit(content, startLine, origin);
    advance(Math.min(j + 1, n));
  };

  /**
   * Consume a template literal starting at `i` (pointing at the backtick).
   * `${ ... }` interpolations are handed back to the main scanner so string
   * literals nested inside them are found too — the `${cond ? 'bg-x' : ''}`
   * form is common in render_code.
   */
  const readTemplate = (origin: ExtractedToken['origin']) => {
    advance(i + 1);
    let content = '';
    let startLine = line;
    while (i < n) {
      const c = source[i];
      if (c === '\\') {
        content += source[i + 1] ?? '';
        advance(i + 2);
        continue;
      }
      if (c === '`') {
        emit(content, startLine, origin);
        advance(i + 1);
        return;
      }
      if (c === '$' && source[i + 1] === '{') {
        emit(content, startLine, origin);
        content = '';
        advance(i + 2);
        scanCode(1);
        startLine = line;
        continue;
      }
      if (c === '\n') line++;
      content += c;
      i++;
    }
    emit(content, startLine, origin);
  };

  /**
   * Scan code. `stopDepth` of 0 runs to end of input; 1 returns at the `}`
   * that closes the interpolation this call was entered for.
   */
  function scanCode(stopDepth: number) {
    let depth = stopDepth;
    while (i < n) {
      const c = source[i];
      if (c === '\n') {
        line++;
        i++;
        continue;
      }
      if (c === '/' && source[i + 1] === '/') {
        const nl = source.indexOf('\n', i);
        advance(nl === -1 ? n : nl);
        continue;
      }
      if (c === '/' && source[i + 1] === '*') {
        const close = source.indexOf('*/', i + 2);
        advance(close === -1 ? n : close + 2);
        continue;
      }
      if ((c === '"' || c === "'") && opensStringLiteral(i)) {
        readQuoted(originFor(i));
        continue;
      }
      if (c === '`' && opensStringLiteral(i)) {
        readTemplate(originFor(i));
        continue;
      }
      if (c === '{') {
        depth++;
        i++;
        continue;
      }
      if (c === '}') {
        depth--;
        i++;
        if (stopDepth > 0 && depth === 0) return;
        continue;
      }
      i++;
    }
  }

  scanCode(0);
  return out;
}

// ---------------------------------------------------------------------------
// 4. Classify
// ---------------------------------------------------------------------------

const TAILWIND_PALETTES = [
  'slate', 'gray', 'zinc', 'neutral', 'stone',
  'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal',
  'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
];

/**
 * Palettes to try when substituting a missing colour, nearest hue first.
 * Ordered by visual proximity so a substitution preserves design intent —
 * `text-rose-700` -> `text-red-700` is the swap the ace#1662 fix actually
 * used on the consent-floor figure.
 */
const PALETTE_NEIGHBOURS: Record<string, string[]> = {
  slate: ['gray', 'zinc', 'neutral', 'stone'],
  gray: ['slate', 'zinc', 'neutral', 'stone'],
  zinc: ['neutral', 'gray', 'slate', 'stone'],
  neutral: ['zinc', 'gray', 'stone', 'slate'],
  stone: ['neutral', 'zinc', 'gray', 'slate'],
  red: ['rose', 'orange', 'pink'],
  rose: ['red', 'pink', 'fuchsia'],
  orange: ['amber', 'red', 'yellow'],
  amber: ['orange', 'yellow'],
  yellow: ['amber', 'lime', 'orange'],
  lime: ['green', 'yellow'],
  green: ['emerald', 'lime', 'teal'],
  emerald: ['green', 'teal'],
  teal: ['emerald', 'cyan', 'green'],
  cyan: ['sky', 'teal', 'blue'],
  sky: ['blue', 'cyan'],
  blue: ['sky', 'indigo'],
  indigo: ['blue', 'violet', 'purple'],
  violet: ['purple', 'indigo'],
  purple: ['violet', 'fuchsia', 'indigo'],
  fuchsia: ['purple', 'pink'],
  pink: ['rose', 'fuchsia'],
};

const SHADE_SCALE = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

interface ColourParts {
  prefix: string;
  palette: string;
  shade: number;
  suffix: string;
}

/** Split `text-rose-700` / `bg-emerald-600/50` into its colour parts. */
export function parseColourUtility(base: string): ColourParts | null {
  const m = base.match(/^(.*-)([a-z]+)-(\d{1,3})(\/\d+)?$/);
  if (!m) return null;
  const [, prefix, palette, shadeStr, suffix] = m;
  if (!TAILWIND_PALETTES.includes(palette)) return null;
  const shade = Number(shadeStr);
  if (!SHADE_SCALE.includes(shade)) return null;
  return { prefix, palette, shade, suffix: suffix ?? '' };
}

/**
 * Name resolving near-neighbours for a missing utility, best first.
 *
 * Same palette / nearest shade comes first (`bg-emerald-600` ->
 * `bg-emerald-500`), then the same shade in a neighbouring palette
 * (`text-rose-700` -> `text-red-700`). Both are substitutions the ace#1662
 * repair actually used.
 *
 * Returns `[]` for anything that is not a colour utility — a geometric or
 * arbitrary-value utility has no safe near-neighbour (`h-28` is not `h-24`),
 * so the honest answer there is an inline `style` prop, carried in `advice`.
 */
export function suggestSubstitutions(token: string, available: Set<string>): string[] {
  const variantPrefix = token.slice(0, token.length - stripVariants(token).length);
  let base = stripVariants(token);
  const negative = base.startsWith('-');
  if (negative) base = base.slice(1);

  const parts = parseColourUtility(base);
  if (!parts) return [];

  const candidates: string[] = [];
  const rebuild = (palette: string, shade: number) =>
    `${variantPrefix}${negative ? '-' : ''}${parts.prefix}${palette}-${shade}${parts.suffix}`;

  // 1. Same palette, nearest shade (closest first, lighter wins a tie).
  const byDistance = SHADE_SCALE.filter((s) => s !== parts.shade).sort(
    (a, b) => Math.abs(a - parts.shade) - Math.abs(b - parts.shade) || a - b,
  );
  for (const shade of byDistance) candidates.push(rebuild(parts.palette, shade));

  // 2. Same shade in a neighbouring palette.
  for (const palette of PALETTE_NEIGHBOURS[parts.palette] ?? []) {
    candidates.push(rebuild(palette, parts.shade));
  }

  const seen = new Set<string>();
  const resolving: string[] = [];
  for (const c of candidates) {
    if (seen.has(c) || !available.has(c)) continue;
    seen.add(c);
    resolving.push(c);
  }
  // Prefer a same-shade hue swap over a shade shift when both resolve: it
  // preserves contrast, which is what the load-bearing red needed.
  const sameShade = resolving.filter((c) => c.endsWith(`-${parts.shade}${parts.suffix}`));
  const rest = resolving.filter((c) => !sameShade.includes(c));
  return [...sameShade, ...rest].slice(0, 4);
}

function classifyMissingKind(base: string): MissingKind {
  if (base.includes('[')) return 'arbitrary-value';
  if (parseColourUtility(base)) return 'colour';
  return 'other';
}

function adviceFor(kind: MissingKind, substitutions: string[]): string {
  if (substitutions.length > 0) {
    return `Substitute a resolving near-neighbour: ${substitutions.join(' | ')}.`;
  }
  if (kind === 'colour') {
    return 'No resolving near-neighbour in the deployed bundle. Pick a colour labs itself uses, or set the colour with an inline style prop.';
  }
  return 'Geometric utility with no safe near-neighbour (a different value is a different design). Drop the class and set the property with an inline style prop, e.g. className="relative w-full" style={{ height: 112 }}.';
}

/**
 * Classify every utility token in `source` against the class names
 * enumerated from the deployed stylesheet(s).
 *
 * Classification rules, and why each is drawn where it is:
 *
 *  - EXACT MATCH in the stylesheet -> `present`. Per-utility, never
 *    per-family: `text-slate-700` resolving tells you nothing about
 *    `bg-slate-400`.
 *  - Utility-shaped, hyphenated, and SOME prefix of it is a family the
 *    stylesheet defines -> `missing`. The family test only answers "is this
 *    a Tailwind utility"; availability is always the exact-string test.
 *  - Bare word with no hyphen and no exact match -> `ignored:bare-word`. A
 *    missing `flex` is indistinguishable from the English word "flex" in a
 *    prose string, and render_code is full of prose. Deliberately
 *    under-reports rather than drowning the check in false positives; the
 *    hyphen-free utilities are layout primitives labs' own templates use on
 *    every page, so the residual exposure is small. Documented, not silent.
 *  - Anything else -> `ignored` with the reason recorded.
 */
export function classifyUtilities(source: string, css: string): ResolutionReport {
  const available = parseStylesheetClassNames(css);
  const families = deriveUtilityFamilies(available);
  const tokens = extractUtilityTokens(source);

  const order: string[] = [];
  const lines = new Map<string, number[]>();
  for (const t of tokens) {
    // The value of a named non-class attribute is not a class (ace#1699).
    if (t.origin === 'attribute-value') continue;
    if (!lines.has(t.token)) {
      lines.set(t.token, []);
      order.push(t.token);
    }
    const arr = lines.get(t.token)!;
    if (!arr.includes(t.line)) arr.push(t.line);
  }

  const present: UtilityFinding[] = [];
  const missing: UtilityFinding[] = [];
  const ignored: UtilityFinding[] = [];

  for (const token of order) {
    const at = lines.get(token)!.sort((a, b) => a - b);

    if (available.has(token)) {
      present.push({ token, status: 'present', lines: at });
      continue;
    }

    if (!UTILITY_SHAPE_RE.test(token)) {
      ignored.push({ token, status: 'ignored', lines: at, ignoredReason: 'not-utility-shaped' });
      continue;
    }

    let base = stripVariants(token);
    if (base.startsWith('-')) base = base.slice(1);

    if (!base.includes('-') || base.endsWith('-')) {
      ignored.push({ token, status: 'ignored', lines: at, ignoredReason: 'bare-word' });
      continue;
    }

    const bracket = base.indexOf('[');
    const scan = bracket === -1 ? base : base.slice(0, bracket);
    let familyHit = false;
    for (let idx = scan.indexOf('-'); idx !== -1; idx = scan.indexOf('-', idx + 1)) {
      if (families.has(base.slice(0, idx + 1))) {
        familyHit = true;
        break;
      }
    }
    if (!familyHit) {
      ignored.push({ token, status: 'ignored', lines: at, ignoredReason: 'unknown-family' });
      continue;
    }

    const kind = classifyMissingKind(base);
    const substitutions = suggestSubstitutions(token, available);
    missing.push({
      token,
      status: 'missing',
      lines: at,
      kind,
      substitutions,
      advice: adviceFor(kind, substitutions),
    });
  }

  return { present, missing, ignored, stylesheetClassCount: available.size };
}

// ---------------------------------------------------------------------------
// 4b. Stylesheet discovery (pure: HTML in, absolute URLs out)
// ---------------------------------------------------------------------------

/**
 * Pull every `<link rel="stylesheet">` target out of a page, resolved
 * against `base`.
 *
 * The check must read EVERY stylesheet the page loads, not just the one
 * whose filename looks like Tailwind: labs serves the utility bundle and a
 * vendors bundle, and a utility defined in either one resolves at runtime.
 * Reading a subset makes real utilities look missing.
 */
export function extractStylesheetHrefs(html: string, base: string): string[] {
  const out: string[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/rel\s*=\s*["'][^"']*stylesheet/i.test(tag)) continue;
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    try {
      out.push(new URL(href, base).toString());
    } catch {
      // A malformed href is not worth failing the whole discovery over; the
      // caller's enumeration floor catches a genuinely empty result.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5. Report rendering
// ---------------------------------------------------------------------------

export interface RenderOptions {
  /** Also list every PRESENT utility, not just the misses. */
  verbose?: boolean;
  /** Include the substitution column / advice lines. */
  substitute?: boolean;
  /** Label for the source under test (a path, a workflow id). */
  sourceLabel?: string;
}

export function renderResolutionReport(report: ResolutionReport, opts: RenderOptions = {}): string {
  const out: string[] = [];
  const label = opts.sourceLabel ? ` ${opts.sourceLabel}` : '';
  out.push(`render_code utility check${label}`);
  out.push(
    `  stylesheet classes enumerated: ${report.stylesheetClassCount}` +
      `  ·  utilities checked: ${report.present.length + report.missing.length}` +
      `  ·  ignored: ${report.ignored.length}`,
  );
  out.push('');

  if (opts.verbose) {
    for (const f of report.present) {
      out.push(`PRESENT   ${f.token}`);
    }
    if (report.present.length) out.push('');
  }

  if (report.missing.length === 0) {
    out.push('OK — every utility resolves against the deployed stylesheet.');
    return out.join('\n');
  }

  for (const f of report.missing) {
    out.push(`MISSING   ${f.token}  (line${f.lines.length > 1 ? 's' : ''} ${f.lines.join(', ')})`);
    if (opts.substitute !== false) {
      out.push(`            ${f.advice}`);
    }
  }
  out.push('');
  out.push(
    `FAIL — ${report.missing.length} utilit${report.missing.length === 1 ? 'y does' : 'ies do'} not resolve. ` +
      'Uploading this render_code would render them as the unstyled baseline, silently.',
  );
  return out.join('\n');
}
