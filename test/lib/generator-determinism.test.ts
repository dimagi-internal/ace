/**
 * ace#1388 — a hand-authored generator that claims determinism but consumes
 * its RNG draws while iterating a hash-ordered set.
 *
 * The shape under test is the one that actually shipped: `random.Random(SEED)`
 * is seeded correctly, so every "is it seeded?" review passes, while the draw
 * ORDER moves with PYTHONHASHSEED.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkGeneratorDeterminism,
  CROSS_PROCESS_SELFCHECK,
} from '../../lib/generator-determinism';

/** The spark-facilitator generator's shape, reduced to the defect. */
const SHIPPED = `
import random
SEED = 20260814
rng = random.Random(SEED)
facilitators = {"peter", "rhoda", "grace", "samuel"}

def build():
    records = []
    for name in facilitators:
        for week in range(8):
            if rng.random() < 0.7:
                records.append({"who": name, "week": week, "n": rng.randint(1, 5)})
    return records
`;

const FIXED = `
import random
SEED = 20260814
rng = random.Random(SEED)
facilitators = {"peter", "rhoda", "grace", "samuel"}

def build():
    records = []
    for name in sorted(facilitators):
        for week in range(8):
            if rng.random() < 0.7:
                records.append({"who": name, "week": week, "n": rng.randint(1, 5)})
    return records

${CROSS_PROCESS_SELFCHECK}
`;

describe('builtin hash() — the actual cause of ace#1388', () => {
  // The ticket blamed set iteration. The generator contains no set() at all.
  // Measured 2026-08-14: replacing ONLY the hash() calls with a blake2b digest
  // took the record count from 232/237/221 across PYTHONHASHSEED 1/2/3 to a
  // byte-identical 224 every time.
  const REAL = [
    'import random, json',
    'PYTHONHASHSEED',
    'def week_plan(u, week):',
    '    h  = (hash((u, week)) >> 3) % 100   # how many records',
    '    k  = (hash((week, u)) >> 5) % 100   # what kind',
    '    return h, k',
  ].join('\n');

  it('flags every hash() site, one finding each', () => {
    const hits = checkGeneratorDeterminism(REAL).findings.filter(
      (f) => f.kind === 'hash-builtin-derivation',
    );
    expect(hits.map((f) => f.line)).toEqual([4, 5]);
  });

  it('explains why it looks safe, since that is why it shipped', () => {
    const f = checkGeneratorDeterminism(REAL).findings.find(
      (f) => f.kind === 'hash-builtin-derivation',
    )!;
    expect(f.detail).toContain('WITHIN a process');
    expect(f.detail).toContain('PEP 456');
    expect(f.remedy).toContain('blake2b');
  });

  it('catches hash() feeding an RNG seed, the entity-id shape', () => {
    const src = 'PYTHONHASHSEED\nE = {u: random.Random(hash(c) & 0xFFFFFFFF) for u, c in X}\n';
    expect(
      checkGeneratorDeterminism(src).findings.some((f) => f.kind === 'hash-builtin-derivation'),
    ).toBe(true);
  });

  it('does not fire on hashlib, a method call, or a name ending in hash', () => {
    const clean = [
      'PYTHONHASHSEED',
      'import hashlib',
      'd = hashlib.blake2b(b"x").digest()',
      'v = obj.hash(key)',
      'w = _stable_hash((u, week))',
      'z = my_hash(k)',
    ].join('\n');
    expect(
      checkGeneratorDeterminism(clean).findings.filter(
        (f) => f.kind === 'hash-builtin-derivation',
      ),
    ).toEqual([]);
  });

  it('ignores hash() inside a comment', () => {
    const src = 'PYTHONHASHSEED\n# never use hash((u, week)) here\nx = 1\n';
    expect(checkGeneratorDeterminism(src).findings).toEqual([]);
  });
});

describe('checkGeneratorDeterminism — hash-ordered iteration', () => {
  it('flags a draw consumed inside hash-ordered iteration', () => {
    const { ok, findings } = checkGeneratorDeterminism(SHIPPED);
    expect(ok).toBe(false);
    const f = findings.find((x) => x.kind === 'unsorted-iteration-with-draw');
    expect(f, 'the set-iteration draw must be flagged').toBeTruthy();
    expect(f!.detail).toContain('facilitators');
    expect(f!.remedy).toContain('sorted(facilitators)');
  });

  it('points at the DRAW line, not just the loop header', () => {
    const { findings } = checkGeneratorDeterminism(SHIPPED);
    const f = findings.find((x) => x.kind === 'unsorted-iteration-with-draw')!;
    const drawLine = SHIPPED.split('\n')[f.line - 1];
    expect(drawLine).toMatch(/rng\.random\(\)/);
  });

  it('accepts the sorted + cross-process-checked version', () => {
    expect(checkGeneratorDeterminism(FIXED)).toEqual({ ok: true, findings: [] });
  });
});

describe('the in-process self-check is a finding, not compliance', () => {
  // Measured 2026-08-14: two generations in one process are byte-identical over
  // this exact defect, because PYTHONHASHSEED is drawn once per process.
  const IN_PROCESS = `
import random
rng = random.Random(1)
names = {"a", "b", "c"}

def generate():
    return [(n, rng.randint(0, 9)) for n in sorted(names)]

# determinism check
assert generate() == generate(), "not deterministic"
`;

  it('reports a green-over-live-bug check rather than treating it as satisfied', () => {
    const { ok, findings } = checkGeneratorDeterminism(IN_PROCESS);
    expect(ok).toBe(false);
    const f = findings.find((x) => x.kind === 'in-process-only-selfcheck');
    expect(f, 'an in-process-only check must be named as such').toBeTruthy();
    expect(f!.detail).toContain('ONE process');
    expect(f!.remedy).toContain('PYTHONHASHSEED');
  });

  it('reports a plain missing check differently from a misleading one', () => {
    const bare = 'import random\nrng = random.Random(1)\nout = [rng.random()]\n';
    const kinds = checkGeneratorDeterminism(bare).findings.map((f) => f.kind);
    expect(kinds).toContain('missing-selfcheck');
    expect(kinds).not.toContain('in-process-only-selfcheck');
  });
});

describe('what is and is not hash-ordered', () => {
  const wrap = (iter: string) =>
    `import random\nrng = random.Random(1)\nPYTHONHASHSEED\nfor k in ${iter}:\n    x = rng.random()\n`;
  const flags = (iter: string) =>
    checkGeneratorDeterminism(wrap(iter)).findings.some(
      (f) => f.kind === 'unsorted-iteration-with-draw',
    );

  it('flags sets and set() calls', () => {
    expect(flags('{"a", "b"}')).toBe(true);
    expect(flags('set(names)')).toBe(true);
    expect(flags('frozenset(names)')).toBe(true);
  });

  it('does NOT flag dicts — insertion order is deterministic since 3.7', () => {
    expect(flags('{"a": 1, "b": 2}')).toBe(false);
    expect(flags('cohorts.items()')).toBe(false);
  });

  it('does not flag ordered iteration', () => {
    expect(flags('sorted(names)')).toBe(false);
    expect(flags('range(10)')).toBe(false);
    expect(flags('enumerate(sorted(names))')).toBe(false);
    expect(flags('[1, 2, 3]')).toBe(false);
  });

  it('sees through enumerate/list wrappers to an unsorted set', () => {
    expect(flags('enumerate(set(names))')).toBe(true);
    expect(flags('list({"a", "b"})')).toBe(true);
  });

  it('follows set algebra through a binding', () => {
    const src = [
      'import random',
      'PYTHONHASHSEED',
      'rng = random.Random(1)',
      'all_names = set(roster)',
      'dropped = all_names - retained',
      'for n in dropped:',
      '    x = rng.random()',
    ].join('\n');
    expect(
      checkGeneratorDeterminism(src).findings.some(
        (f) => f.kind === 'unsorted-iteration-with-draw',
      ),
    ).toBe(true);
  });

  it('ignores a loop over a set that makes no draw', () => {
    const src = 'PYTHONHASHSEED\nfor k in {"a", "b"}:\n    total += 1\n';
    expect(checkGeneratorDeterminism(src).findings).toEqual([]);
  });

  it('does not fire on a non-RNG receiver that happens to have .choice(', () => {
    const src = 'PYTHONHASHSEED\nfor k in {"a", "b"}:\n    menu.choice(k)\n';
    expect(checkGeneratorDeterminism(src).findings).toEqual([]);
  });

  it('flags a comprehension too — the shipped generator used one', () => {
    const src =
      'import random\nPYTHONHASHSEED\nrng = random.Random(1)\n' +
      'out = [(k, rng.randint(0, 9)) for k in facil_set]\n' +
      'facil_set = set(roster)\n';
    // binding appears after use; collectBindings is a whole-file pass, so it holds
    expect(
      checkGeneratorDeterminism(src).findings.some(
        (f) => f.kind === 'unsorted-iteration-with-draw',
      ),
    ).toBe(true);
  });
});

describe('the exported self-check snippet', () => {
  it('varies the hash seed across processes and compares bytes', () => {
    expect(CROSS_PROCESS_SELFCHECK).toContain('PYTHONHASHSEED');
    expect(CROSS_PROCESS_SELFCHECK).toContain('subprocess.run');
    expect(CROSS_PROCESS_SELFCHECK).toMatch(/for seed in \("1", "2"\)/);
    expect(CROSS_PROCESS_SELFCHECK).toContain('sha256');
  });

  it('fails loud rather than warning', () => {
    expect(CROSS_PROCESS_SELFCHECK).toContain('raise SystemExit');
    expect(CROSS_PROCESS_SELFCHECK).toContain('NON-DETERMINISTIC');
  });

  it('names the cause and the remedy in the failure message', () => {
    expect(CROSS_PROCESS_SELFCHECK).toContain('iterating a set');
    expect(CROSS_PROCESS_SELFCHECK).toContain('sorted(d)');
  });

  it('guards against infinite re-exec', () => {
    expect(CROSS_PROCESS_SELFCHECK).toContain('ACE_DETERMINISM_CHILD');
  });
});

describe('the skill carries the contract (ace#1388)', () => {
  const skill = readFileSync(
    join(__dirname, '../../skills/demo-data-setup/SKILL.md'),
    'utf8',
  );

  it('documents the hand-authored escape hatch at all', () => {
    expect(skill).toMatch(/Hand-authoring a generator/);
  });

  it('names all three obligations', () => {
    expect(skill).toMatch(/builtin `hash\(\)`/);
    expect(skill).toMatch(/sorted\(d\)/i);
    expect(skill).toMatch(/CROSS-PROCESS/i);
  });

  it('warns that the in-process check is a false green', () => {
    expect(skill).toMatch(/does not work/i);
    // The claim wraps across blockquote lines, so normalise before matching.
    const flat = skill.replace(/[`\n>]+/g, ' ').replace(/\s+/g, ' ');
    expect(flat).toContain('PYTHONHASHSEED is drawn once per process');
    expect(flat).toContain('green check over a live bug is worse than no check');
  });

  it('points at the shared snippet rather than restating it', () => {
    expect(skill).toContain('CROSS_PROCESS_SELFCHECK');
    expect(skill).toContain('lib/generator-determinism.ts');
  });
});
