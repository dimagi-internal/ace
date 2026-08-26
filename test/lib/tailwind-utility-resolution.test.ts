import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseStylesheetClassNames,
  extractSelectorPreludes,
  unescapeCssIdent,
  deriveUtilityFamilies,
  stripVariants,
  extractUtilityTokens,
  classifyUtilities,
  suggestSubstitutions,
  parseColourUtility,
  renderResolutionReport,
  extractStylesheetHrefs,
} from '../../lib/tailwind-utility-resolution.js';

// ace#1662 — connect-labs purges its Tailwind bundle against its own Django
// templates, so any utility used only inside a workflow's DB-stored
// `render_code` is silently dropped from the shipped CSS and degrades to
// the unstyled baseline. `text-rose-700` styled the only pay-affecting
// figure on the LLO weekly-review dashboard and rendered near-black for an
// unknown number of runs.
//
// The fixtures below are REAL, not invented:
//   labs-deployed-subset.css   verbatim rules from the deployed bundle
//                              (tailwind.328bc8e5ac1d.css, fetched
//                              2026-08-26), chosen so the six resolving and
//                              seven non-resolving utilities from the issue
//                              are pinned exactly.
//   render-code-prefix.jsx     the pre-fix render_code shape from workflow
//                              5230 (+ the two sizing misses from 5227).

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => fs.readFileSync(path.join(here, '../fixtures/tailwind', name), 'utf8');

const DEPLOYED_CSS = fixture('labs-deployed-subset.css');
const PREFIX_RENDER_CODE = fixture('render-code-prefix.jsx');

/** Verbatim from the ace#1662 probe output. */
const RESOLVES = [
  'text-red-700',
  'text-red-800',
  'bg-emerald-500',
  'border-gray-300',
  'border-slate-200',
  'border-red-300',
];
const NO_OP = [
  'text-rose-700',
  'text-rose-800',
  'bg-emerald-600',
  'border-slate-300',
  'border-rose-300',
];
/** Present in the bundle, but invisible to a rendering-diff probe. */
const PROBE_BLIND_SPOTS = ['space-y-1', 'space-y-6', 'list-disc', 'mx-auto'];

describe('parseStylesheetClassNames', () => {
  it('enumerates the class selectors of the deployed bundle subset', () => {
    const classes = parseStylesheetClassNames(DEPLOYED_CSS);
    for (const c of RESOLVES) expect(classes.has(c)).toBe(true);
    for (const c of NO_OP) expect(classes.has(c)).toBe(false);
  });

  it('un-escapes arbitrary-value, variant and opacity selectors', () => {
    // `.text-\[11px\]`, `.hover\:bg-gray-50:hover`, `.bg-black\/50` — the
    // escaped forms are precisely the ones most likely to be purged, so a
    // parser that misses them under-reports the risky utilities.
    const classes = parseStylesheetClassNames(DEPLOYED_CSS);
    expect(classes.has('text-[11px]')).toBe(true);
    expect(classes.has('text-[10px]')).toBe(true);
    expect(classes.has('hover:bg-gray-50')).toBe(true);
    expect(classes.has('bg-black/50')).toBe(true);
  });

  it('reads a class nested inside :where(... > :not(:last-child))', () => {
    // `space-y-*` never appears as a bare `.space-y-1{...}` rule.
    const classes = parseStylesheetClassNames(DEPLOYED_CSS);
    expect(classes.has('space-y-1')).toBe(true);
    expect(classes.has('space-y-6')).toBe(true);
  });

  it('does not mistake a declaration VALUE for a class selector', () => {
    // Minified CSS is full of `padding:0.5rem`; scanning the whole file
    // rather than the selector preludes invents a class named `5rem`.
    const classes = parseStylesheetClassNames('.p-2{padding:0.5rem;background:url(a.b/c.svg)}');
    expect([...classes]).toEqual(['p-2']);
  });

  it('extractSelectorPreludes / unescapeCssIdent behave on their own', () => {
    expect(extractSelectorPreludes('.a{x:1}@media(min-width:40rem){.b{y:2}}')).toEqual([
      '.a',
      '@media(min-width:40rem)',
      '.b',
    ]);
    expect(unescapeCssIdent('text-\\[11px\\]')).toBe('text-[11px]');
    expect(unescapeCssIdent('hover\\:bg-gray-50')).toBe('hover:bg-gray-50');
  });
});

describe('deriveUtilityFamilies', () => {
  it('derives families at every hyphen boundary, ignoring variants', () => {
    const families = deriveUtilityFamilies(['text-rose-600', 'hover:bg-gray-50', '-mt-1', 'min-w-[52px]']);
    expect(families.has('text-')).toBe(true);
    expect(families.has('text-rose-')).toBe(true);
    expect(families.has('bg-')).toBe(true);
    expect(families.has('mt-')).toBe(true);
    expect(families.has('min-')).toBe(true);
    expect(families.has('min-w-')).toBe(true);
  });

  it('stripVariants keeps brackets intact', () => {
    expect(stripVariants('hover:bg-gray-50')).toBe('bg-gray-50');
    expect(stripVariants('sm:hover:text-red-700')).toBe('text-red-700');
    expect(stripVariants('min-w-[52px]')).toBe('min-w-[52px]');
    expect(stripVariants('data-[open]:bg-white')).toBe('bg-white');
  });
});

describe('extractUtilityTokens', () => {
  it('finds utilities in JS string literals, not just class attributes', () => {
    // The ace#1662 miss reached the DOM through a ternary inside a
    // concatenation — a class-attribute-only scan never sees it.
    const src = [
      "var cardBorder = 'border-slate-300';",
      "var el = <div className={'rounded border ' + (bad ? 'text-rose-700' : 'text-gray-800')} />;",
      'var t = `relative h-28 ${flag ? "min-w-[52px]" : ""}`;',
    ].join('\n');
    const tokens = extractUtilityTokens(src).map((t) => t.token);
    expect(tokens).toContain('border-slate-300');
    expect(tokens).toContain('text-rose-700');
    expect(tokens).toContain('h-28');
    expect(tokens).toContain('min-w-[52px]');
  });

  it('tags class-attribute strings distinctly from bare string literals', () => {
    const tokens = extractUtilityTokens('<div className="mx-auto">{fn("x")}</div>');
    const mx = tokens.find((t) => t.token === 'mx-auto');
    expect(mx?.origin).toBe('class-attribute');
    expect(tokens.find((t) => t.token === 'x')?.origin).toBe('string-literal');
  });

  // ── ace#1699: a named non-class attribute is not a class ────────────────
  //
  // `data-testid="row-count"` was linted as a utility, reported MISSING, and
  // BLOCKED the upload with a remedy ("use an inline style prop") that is
  // meaningless for a test id. demo-narrative § 3b requires a `testid:`
  // selector on every scene action, so a render_code a DDD walkthrough can
  // drive must carry them.
  it('does not lint data-* / aria-* / title attribute values as utilities (#1699)', () => {
    const src = '<span data-testid="row-count" aria-label="grid-cols-99" title="w-1/2" className="p-4" />';
    const tokens = extractUtilityTokens(src);
    const byToken = (t: string) => tokens.find((x) => x.token === t)?.origin;
    expect(byToken('row-count')).toBe('attribute-value');
    expect(byToken('grid-cols-99')).toBe('attribute-value');
    expect(byToken('w-1/2')).toBe('attribute-value');
    expect(byToken('p-4')).toBe('class-attribute');

    const report = classifyUtilities(src, DEPLOYED_CSS);
    const seen = [...report.present, ...report.missing, ...report.ignored].map((f) => f.token);
    expect(seen).not.toContain('row-count');
    expect(seen).not.toContain('grid-cols-99');
  });

  it('still lints a utility assigned to a VARIABLE, not just a class attribute (#1699 guard)', () => {
    // `var cardBorder = 'border-slate-300'` has the same `<name> = "<value>"`
    // shape as a JSX attribute and is one of the seven ace#1662 ground-truth
    // misses — narrowing by "anything before an =" would have lost it.
    const tokens = extractUtilityTokens("var cardBorder = 'border-slate-300';");
    expect(tokens.find((t) => t.token === 'border-slate-300')?.origin).toBe('string-literal');
  });

  it('does not let an apostrophe in JSX text swallow the classes that follow', () => {
    // render_code is JSX and its prose is full of possessives. Treating
    // `worker's` as an opening quote eats the rest of the file, so every
    // later utility goes unchecked — silently re-creating the very blind
    // spot this lint exists to close.
    const src = [
      "<div>",
      "  <p>This worker's consent rate is below the floor.</p>",
      '  <span className="text-rose-700">89.7%</span>',
      '</div>',
    ].join('\n');
    expect(extractUtilityTokens(src).map((t) => t.token)).toContain('text-rose-700');
  });

  it('still reads a string literal after a keyword', () => {
    expect(extractUtilityTokens("function f(){ return 'text-rose-700'; }").map((t) => t.token)).toContain(
      'text-rose-700',
    );
  });

  it('records the line each token appears on', () => {
    const tokens = extractUtilityTokens('var a = 1;\nvar b = "mx-auto";\n');
    expect(tokens.find((t) => t.token === 'mx-auto')?.line).toBe(2);
  });
});

describe('classifyUtilities — the ace#1662 ground truth', () => {
  const report = classifyUtilities(PREFIX_RENDER_CODE, DEPLOYED_CSS);
  const missing = report.missing.map((f) => f.token);
  const present = report.present.map((f) => f.token);

  it('reports exactly the seven utilities the run found non-resolving', () => {
    expect(missing.sort()).toEqual(
      ['bg-emerald-600', 'border-rose-300', 'border-slate-300', 'h-28', 'min-w-[52px]', 'text-rose-700', 'text-rose-800'].sort(),
    );
  });

  it('reports every utility the run found resolving as PRESENT', () => {
    for (const c of RESOLVES) {
      expect(present, `${c} must be PRESENT`).toContain(c);
      expect(missing, `${c} must not be reported missing`).not.toContain(c);
    }
  });

  it('never flags the probe blind spots space-y-*, list-disc, mx-auto', () => {
    // These read `nDiff=0` on a bare probe element while `inCss=True`:
    // `space-y-*` targets `:not(:last-child)` and a probe reads the last
    // child; `list-disc`'s value is the CSS initial; `mx-auto` computes to
    // `0px` on a full-width block. A "no rendering diff ⇒ missing" check
    // emits four false positives on this file alone; enumeration must not.
    for (const c of PROBE_BLIND_SPOTS) {
      expect(missing, `${c} is a probe blind spot, not a miss`).not.toContain(c);
      expect(present, `${c} must be PRESENT`).toContain(c);
    }
  });

  it('does not apply family-level heuristics: a sibling tells you nothing', () => {
    // The purge is per-UTILITY. `text-slate-700` resolves while
    // `border-slate-300` does not, and `border-*` does not mirror `bg-*`.
    expect(present).toContain('text-slate-700');
    expect(missing).toContain('border-slate-300');
    expect(present).toContain('bg-emerald-500');
    expect(missing).toContain('bg-emerald-600');
  });

  it('does not treat arbitrary values as categorically unavailable', () => {
    // `text-[11px]` and `text-[10px]` ship; `min-w-[52px]` does not. The
    // rule is the exact string, not the shape.
    expect(present).toContain('text-[11px]');
    expect(present).toContain('text-[10px]');
    expect(missing).toContain('min-w-[52px]');
  });

  it('ignores hyphenated non-utilities such as data-testid values', () => {
    expect(missing).not.toContain('consent-floor-note');
    expect(missing).not.toContain('period-select');
  });

  it('classifies the shape of each miss', () => {
    const kind = (t: string) => report.missing.find((f) => f.token === t)?.kind;
    expect(kind('text-rose-700')).toBe('colour');
    expect(kind('min-w-[52px]')).toBe('arbitrary-value');
    expect(kind('h-28')).toBe('other');
  });

  it('reports where each miss lives so it can be fixed without a search', () => {
    const f = report.missing.find((m) => m.token === 'text-rose-700')!;
    expect(f.lines.length).toBeGreaterThan(0);
    expect(PREFIX_RENDER_CODE.split('\n')[f.lines[0] - 1]).toContain('text-rose-700');
  });
});

describe('suggestSubstitutions', () => {
  const available = parseStylesheetClassNames(DEPLOYED_CSS);

  it('names the substitution the ace#1662 repair actually used, first', () => {
    expect(suggestSubstitutions('text-rose-700', available)[0]).toBe('text-red-700');
    expect(suggestSubstitutions('text-rose-800', available)[0]).toBe('text-red-800');
    expect(suggestSubstitutions('border-rose-300', available)[0]).toBe('border-red-300');
    expect(suggestSubstitutions('border-slate-300', available)[0]).toBe('border-gray-300');
  });

  it('offers both halves of the split fix for border-slate-300', () => {
    // The run split it: `border-gray-300` on the card, `border-slate-200`
    // on the panels.
    expect(suggestSubstitutions('border-slate-300', available)).toEqual(
      expect.arrayContaining(['border-gray-300', 'border-slate-200']),
    );
  });

  it('offers a same-palette shade shift when the hue swap has no home', () => {
    expect(suggestSubstitutions('bg-emerald-600', available)).toContain('bg-emerald-500');
  });

  it('never proposes a candidate that is itself absent', () => {
    for (const token of NO_OP) {
      for (const s of suggestSubstitutions(token, available)) {
        expect(available.has(s), `${s} proposed for ${token} but absent`).toBe(true);
      }
    }
  });

  it('offers nothing for a geometric utility — a different value is a different design', () => {
    expect(suggestSubstitutions('h-28', available)).toEqual([]);
    expect(suggestSubstitutions('min-w-[52px]', available)).toEqual([]);
  });

  it('parseColourUtility only accepts real palettes and shades', () => {
    expect(parseColourUtility('text-rose-700')).toMatchObject({ prefix: 'text-', palette: 'rose', shade: 700 });
    expect(parseColourUtility('grid-cols-5')).toBeNull();
    expect(parseColourUtility('text-rose-701')).toBeNull();
  });
});

describe('extractStylesheetHrefs', () => {
  it('resolves every stylesheet link on the page against the page URL', () => {
    // labs serves the utility bundle AND a vendors bundle; a utility defined
    // in either resolves at runtime, so reading a subset makes real
    // utilities look missing.
    const html = [
      '<link rel="stylesheet" href="/static/bundles/css/tailwind.328bc8e5ac1d.css">',
      '<link rel="stylesheet" href="/static/bundles/css/vendors.16259889f268.css">',
      '<link rel="icon" href="/static/favicon.ico">',
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Work+Sans">',
    ].join('\n');
    expect(extractStylesheetHrefs(html, 'https://labs.connect.dimagi.com/labs/workflow/')).toEqual([
      'https://labs.connect.dimagi.com/static/bundles/css/tailwind.328bc8e5ac1d.css',
      'https://labs.connect.dimagi.com/static/bundles/css/vendors.16259889f268.css',
      'https://fonts.googleapis.com/css2?family=Work+Sans',
    ]);
  });

  it('ignores non-stylesheet links', () => {
    expect(extractStylesheetHrefs('<link rel="preload" href="/a.css">', 'https://x.test/')).toEqual([]);
  });
});

describe('renderResolutionReport', () => {
  it('fails loudly with the misses and their substitutions', () => {
    const out = renderResolutionReport(classifyUtilities(PREFIX_RENDER_CODE, DEPLOYED_CSS));
    expect(out).toContain('MISSING   text-rose-700');
    expect(out).toContain('text-red-700');
    expect(out).toMatch(/FAIL — 7 utilities do not resolve/);
  });

  it('reports OK when every utility resolves', () => {
    const clean = '<div className="mx-auto max-w-6xl p-6 text-red-700" />';
    const out = renderResolutionReport(classifyUtilities(clean, DEPLOYED_CSS));
    expect(out).toContain('OK — every utility resolves');
    expect(out).not.toContain('MISSING');
  });
});
