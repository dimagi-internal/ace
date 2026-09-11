/**
 * ace#2373 — the threshold-coherence brief, its gate, and the Phase 1 handoff
 * must all recognise an ACCURACY-CONDITIONED GPS dedup radius as coherent.
 *
 * The #984 fix read "dedup radius vs accepted GPS accuracy" as two scalars and
 * declared any radius at or below the worst accepted accuracy meaningless. The
 * Targeting PDD author then resolved the problem without moving either number
 * (v1.1 §6 [FIXED]: the 15 m test runs only where both readings beat 15 m,
 * identifiers otherwise) — and every ACE surface classified her rule as the
 * very incoherence it avoids, one step from licensing a builder to "raise or
 * tie" a [FIXED] author decision.
 *
 * The classification itself is executable (`lib/gps-dedup-coherence.ts`,
 * `test/lib/gps-dedup-coherence.test.ts`). This file pins the PROSE to it:
 *
 *  - the component's controls table and the eval's quoted controls are fed
 *    through the helper, so a table that states a verdict the helper does not
 *    produce fails — the positive control (v1.1 → coherent) and the negative
 *    control (v1.0 → incoherent) are both asserted against the documented
 *    wording, not a paraphrase;
 *  - the brief paragraph may not regress to the unqualified scalar rule, and
 *    may never instruct a builder to move a [FIXED] threshold;
 *  - Phase 1's handoff carries the condition (`duplicate_gps_rule`) instead of
 *    the bare `duplicate_gps_radius_m` scalar that dropped it.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  classifyGpsDedupCoherence,
  parseGpsDedupWording,
  readGpsDedupRule,
} from '../../lib/gps-dedup-coherence';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

const LIBRARY = read('skills/_app-component-library.md');
const EVAL = read('skills/pdd-to-deliver-app-eval/SKILL.md');
const DELIVER = read('skills/pdd-to-deliver-app/SKILL.md');
const IDEA = read('skills/idea-to-pdd/SKILL.md');
const TEMPLATE = read('templates/pdd-template.md');

/** The GPS tolerance both §6 controls are stated against. */
const TOLERANCE_M = 50;

function section(doc: string, heading: string): string {
  const start = doc.indexOf(heading);
  expect(start, `missing ${heading}`).toBeGreaterThan(-1);
  const rest = doc.slice(start + heading.length);
  const next = rest.search(/\n#{2,3} /);
  return next === -1 ? rest : rest.slice(0, next);
}

const COMPONENT = section(LIBRARY, '### threshold-coherence-flag');

/** The `> ` brief paragraph, de-quoted and on one line. */
function briefParagraph(): string {
  const i = COMPONENT.indexOf('**Brief paragraph (verbatim):**');
  expect(i, 'threshold-coherence-flag has no verbatim brief paragraph').toBeGreaterThan(-1);
  const lines = COMPONENT.slice(i).split('\n').slice(1);
  const quoted: string[] = [];
  for (const l of lines) {
    if (l.startsWith('>')) quoted.push(l.replace(/^>\s?/, ''));
    else if (quoted.length > 0) break;
  }
  expect(quoted.length).toBeGreaterThan(0);
  return oneLine(quoted.join(' '));
}

/** The eval's `threshold_coherence` bullet, up to the next criterion bullet. */
function evalCriterion(): string {
  const start = EVAL.indexOf('**`threshold_coherence`**');
  expect(start, 'pdd-to-deliver-app-eval has no threshold_coherence criterion').toBeGreaterThan(-1);
  const end = EVAL.indexOf('**`fixed_instrument_fidelity`**', start);
  expect(end).toBeGreaterThan(start);
  return oneLine(EVAL.slice(start, end));
}

describe('component controls table executes to the verdicts it states (ace#2373)', () => {
  const BEGIN = '<!-- gps-dedup-controls:begin -->';
  const END = '<!-- gps-dedup-controls:end -->';

  function rows(): { wording: string; verdict: string }[] {
    const s = COMPONENT.indexOf(BEGIN);
    const e = COMPONENT.indexOf(END);
    expect(s, 'threshold-coherence-flag must carry a delimited gps-dedup-controls table').toBeGreaterThan(-1);
    expect(e).toBeGreaterThan(s);
    const out: { wording: string; verdict: string }[] = [];
    for (const line of COMPONENT.slice(s, e).split('\n')) {
      const m = line.match(/^\|\s*(v1\.\d)[^:]*:\s*"(.+)"\s*\|\s*\*\*(coherent|incoherent)\*\*/);
      if (m) out.push({ wording: m[2], verdict: m[3] });
    }
    return out;
  }

  it('pins both Targeting PDD §6 wordings — one positive and one negative control', () => {
    const r = rows();
    expect(r).toHaveLength(2);
    expect(r.map((x) => x.verdict).sort()).toEqual(['coherent', 'incoherent']);
  });

  it('POSITIVE: the v1.1 [FIXED] accuracy-conditioned wording classifies coherent through the helper', () => {
    const row = rows().find((x) => x.verdict === 'coherent')!;
    expect(row.wording).toMatch(/where both readings have accuracy better than 15m/);
    expect(row.wording).toMatch(/relies on identifiers alone/);
    const rule = parseGpsDedupWording(row.wording)!;
    expect(classifyGpsDedupCoherence(rule, TOLERANCE_M).verdict).toBe('coherent');
  });

  it('NEGATIVE: the v1.0 unconditioned wording against 50 m classifies incoherent through the helper', () => {
    const row = rows().find((x) => x.verdict === 'incoherent')!;
    expect(row.wording).toMatch(/same GPS point \(< 15m\)/);
    const rule = parseGpsDedupWording(row.wording)!;
    expect(classifyGpsDedupCoherence(rule, TOLERANCE_M).verdict).toBe('incoherent');
  });
});

describe('threshold-coherence-flag brief paragraph', () => {
  it('no longer states the unqualified scalar rule that shipped the defect', () => {
    expect(briefParagraph()).not.toContain(
      '(a dedup radius at or below the worst accepted accuracy is meaningless)',
    );
  });

  it('restricts incoherence to the UNCONDITIONED radius and names the conditioned radius coherent', () => {
    const b = briefParagraph();
    expect(b).toMatch(/UNCONDITIONED dedup radius at or below the worst accepted accuracy is meaningless/);
    expect(b).toMatch(/BOTH readings report accuracy better than the radius/);
    expect(b).toMatch(/identifiers deciding the rest/);
    expect(b).toMatch(/accuracy-conditioned radius and is coherent by construction/);
    expect(b).toMatch(/do not flag it/);
  });

  it('never licenses a builder to move a [FIXED] threshold — and every "raise"/"tie" is negated', () => {
    const b = briefParagraph();
    expect(b).toMatch(/NEVER change a threshold the PDD marks `\[FIXED\]`/);
    expect(b).toMatch(/the value is the PM's or the author's/);
    // Any mention of #984's remedy must sit inside a prohibition, never an instruction.
    for (const m of b.matchAll(/\b(raise|tie)\b/gi)) {
      const before = b.slice(Math.max(0, m.index! - 40), m.index!);
      expect(before, `"${m[0]}" in the brief must be negated: …${before}${m[0]}`).toMatch(/\bnot toward\b|\bnever\b|\bnot\b/i);
    }
  });

  it('records #984\'s "raise or tie" as one resolution, not the answer, with the author\'s choice on record', () => {
    const c = oneLine(COMPONENT);
    expect(c).toMatch(/ace#2373/);
    expect(c).toMatch(/not ACE's to impose/);
    expect(c).toContain('lib/gps-dedup-coherence.ts');
  });
});

describe('pdd-to-deliver-app-eval § threshold_coherence', () => {
  it('classifies the dedup pair with the helper, not by comparing two scalars', () => {
    const c = evalCriterion();
    expect(c).toContain('lib/gps-dedup-coherence.ts');
    expect(c).toContain('readGpsDedupRule');
    expect(c).toContain('parseGpsDedupWording');
    expect(c).toContain('classifyGpsDedupCoherence');
    expect(c).toMatch(/accuracy-conditioned radius\*\*[^.]*is `coherent`/);
    expect(c).toMatch(/no `\[WARN\]` and no deduction/);
    expect(c).toMatch(/Only an \*\*unconditioned\*\* radius at or below the worst accepted accuracy is `incoherent`/);
  });

  it('does not read a bare duplicate_gps_radius_m scalar as unconditioned', () => {
    const c = evalCriterion();
    expect(c).toMatch(/`bare-scalar` source/);
    expect(c).toMatch(/cannot say whether the radius is conditioned/);
    expect(c).toMatch(/`unclear` verdict is not a defect/);
  });

  it('quotes both controls, and each executes to the verdict the criterion states', () => {
    const c = evalCriterion();
    const pos = c.match(/v1\.1 §6 \[FIXED\] \*"([^"]+)"\* → `(\w+)`/);
    const neg = c.match(/v1\.0 \*"([^"]+)"\* → `(\w+)`/);
    expect(pos, 'the eval must quote the v1.1 control').not.toBeNull();
    expect(neg, 'the eval must quote the v1.0 control').not.toBeNull();
    expect(pos![2]).toBe('coherent');
    expect(neg![2]).toBe('incoherent');
    expect(classifyGpsDedupCoherence(parseGpsDedupWording(pos![1])!, TOLERANCE_M).verdict).toBe(pos![2]);
    expect(classifyGpsDedupCoherence(parseGpsDedupWording(neg![1])!, TOLERANCE_M).verdict).toBe(neg![2]);
  });

  it('makes moving a [FIXED] or author-attributed threshold a BLOCKER', () => {
    expect(evalCriterion()).toMatch(
      /A build that CHANGED a `\[FIXED\]` or author-attributed threshold to resolve a conflict it noticed → `\[BLOCKER\]` → `fail`/,
    );
  });
});

describe('Phase 1 handoff carries the whole dedup rule (ace#2373)', () => {
  it('the PDD template declares duplicate_gps_rule, and its one-line example classifies coherent', () => {
    const row = TEMPLATE.split('\n').find((l) => l.startsWith('| duplicate_gps_rule |'));
    expect(row, 'templates/pdd-template.md § Program Parameters must carry a duplicate_gps_rule row').toBeDefined();
    const example = row!.match(/`(radius_m=[^`]+)`/);
    expect(example, 'the row must show the one-line value form').not.toBeNull();
    const rule = readGpsDedupRule({ duplicate_gps_rule: example![1].replace('<n>', '15') })!;
    expect(classifyGpsDedupCoherence(rule, TOLERANCE_M).verdict).toBe('coherent');
    expect(row).toMatch(/Do not emit a bare `duplicate_gps_radius_m` scalar/);
    expect(row).toMatch(/never raise or tie the radius/);
  });

  it('idea-to-pdd lists duplicate_gps_rule in the canonical key list', () => {
    const i = IDEA.indexOf('**Program Parameters** — the typed handoff table.');
    expect(i).toBeGreaterThan(-1);
    expect(oneLine(IDEA.slice(i, i + 1500))).toMatch(/`duplicate_gps_rule`/);
  });

  it("idea-to-pdd Step 7.5's program_parameters example carries the condition and classifies coherent", () => {
    const i = IDEA.indexOf('7.5. **Write the `products.pdd` block');
    expect(i).toBeGreaterThan(-1);
    // The fence is indented under the numbered step; dedent by its own margin.
    const fence = IDEA.slice(i).match(/```yaml\n([ \t]*)(program_parameters:[\s\S]*?)\n[ \t]*```/);
    expect(fence, 'Step 7.5 must carry a program_parameters YAML example').not.toBeNull();
    const margin = new RegExp(`^${fence![1]}`, 'gm');
    const params = parseYaml(fence![2].replace(margin, '')).program_parameters as Record<string, unknown>;
    expect(params.duplicate_gps_radius_m, 'the example must not emit the bare scalar').toBeUndefined();
    const rule = readGpsDedupRule(params);
    expect(rule, 'the example must carry duplicate_gps_rule').not.toBeNull();
    expect(rule!.source).toBe('structured');
    expect(classifyGpsDedupCoherence(rule!, TOLERANCE_M).verdict).toBe('coherent');
  });

  it('idea-to-pdd forbids the bare scalar and forbids raising or tying the radius', () => {
    const t = oneLine(IDEA);
    expect(t).toMatch(/\*\*Do not emit `duplicate_gps_radius_m`\*\*/);
    expect(t).toMatch(/never raise the radius or tie it to the tolerance/);
  });

  it("pdd-to-deliver-app's brief checklist carries the rule whole and points at the helper", () => {
    const i = DELIVER.indexOf('- `threshold-coherence-flag` —');
    expect(i).toBeGreaterThan(-1);
    const item = oneLine(DELIVER.slice(i, DELIVER.indexOf('\n     - `', i + 10)));
    expect(item).toContain('program_parameters.duplicate_gps_rule');
    expect(item).toContain('lib/gps-dedup-coherence.ts');
    expect(item).toMatch(/no `\[FIXED\]` or author-attributed threshold is ever moved/);
  });

  it('every mention of the bare duplicate_gps_radius_m scalar in skills/ and templates/ is a prohibition or a record', () => {
    const files = [
      'skills/_app-component-library.md',
      'skills/pdd-to-deliver-app-eval/SKILL.md',
      'skills/pdd-to-deliver-app/SKILL.md',
      'skills/idea-to-pdd/SKILL.md',
      'templates/pdd-template.md',
    ];
    for (const f of files) {
      const text = oneLine(read(f));
      for (const m of text.matchAll(/duplicate_gps_radius_m/g)) {
        const around = text.slice(Math.max(0, m.index! - 160), m.index! + 160);
        expect(around, `${f}: bare-scalar mention must be negated or historical`).toMatch(
          /\bbare\b|[Dd]o not emit|cannot|retired|held `duplicate_gps_radius_m/,
        );
      }
    }
  });
});
