/**
 * Guard for ace#1743 — a test may not name a shared OS resource with a
 * fixed literal.
 *
 * `npm test` is the `clean-install` gate, and it was going red for reasons
 * unrelated to the diff. Three earlier fixes in this family (#1883/#1797,
 * #1912, #1942) each removed one piece of state that leaked between vitest
 * WORKERS. The two that survived them leaked between whole `npm test`
 * INVOCATIONS instead, and both had the same shape: a name that looks
 * private in the source but is global on the box.
 *
 *   1. `session-lock-e2e.test.ts` spawned its daemon on the hardcoded TCP
 *      port 60100. Two concurrent suites raced for it; the loser's daemon
 *      died on EADDRINUSE, never printed LISTENING, and the test sat until
 *      the vitest ceiling — failing at exactly 30004ms, a 6x overshoot that
 *      reads as a slow shutdown path and is nothing of the kind.
 *      `cleanupSessionDaemons` also SIGKILLs every pid on the lock's ports,
 *      so the winner could shoot the loser's daemon, and `TEST_PORT + 1`
 *      was an unowned port that could have belonged to anything.
 *
 *   2. `session-lock.test.ts` wrote its "the real ~/.ace/sessions survives
 *      an all:true reap" sentinel at a FIXED name in the REAL shared dir —
 *      the one directory the test-isolation setup cannot redirect, because
 *      using the real one IS the claim. Every concurrent runner wrote,
 *      asserted on, and then deleted that one path in its own `finally`.
 *
 * Measured on main @ 0.13.1241, two concurrent full suites, 10 pairs = 20
 * suite runs: 10 of 20 red (9 x the sentinel race, 2 x the port race).
 * With both fixed: 0 of 20.
 *
 * The rules below are the ratchet. Rule 1 is a pure text scan. Rule 2
 * follows single-line `const` aliases out of `os.homedir()`, so it sees
 * `sentinel` even though only `realDir` names the home directory.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Opt-out for a literal that is test DATA rather than a real bind — e.g. a
 * fake `ps` command line fed to a regex. Put it on the same line.
 */
const ALLOW_MARKER = 'hygiene:allow-fixed-port';

function walkTestFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'eval') continue;
      walkTestFiles(full, out);
    } else if (entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

const TEST_FILES = [
  ...walkTestFiles(path.join(REPO_ROOT, 'test')),
  ...walkTestFiles(path.join(REPO_ROOT, 'lib')),
];

const rel = (f: string) => path.relative(REPO_ROOT, f);

describe('no test binds a fixed TCP port', () => {
  it('finds test files to scan (guard is not inert)', () => {
    expect(TEST_FILES.length).toBeGreaterThan(100);
  });

  it('every `.listen(<literal>)` in a test uses port 0 (ephemeral) or a variable', () => {
    const offenders: string[] = [];
    for (const file of TEST_FILES) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (line.includes(ALLOW_MARKER)) return;
        // A bare numeric first argument to a listen call — port 60100,
        // port 5037, and so on. Written without an inline example so this
        // scanner does not flag its own comment.
        for (const m of line.matchAll(/\.listen\(\s*([0-9][0-9_]*)/g)) {
          if (Number(m[1].replace(/_/g, '')) !== 0) {
            offenders.push(`${rel(file)}:${i + 1}  ${line.trim()}`);
          }
        }
      });
    }
    expect(
      offenders,
      'A hardcoded port is shared mutable state across every process on the ' +
        'box: two concurrent `npm test` runs collide on EADDRINUSE and the ' +
        'loser goes red on code it did not touch (ace#1743). Bind port 0 and ' +
        'have the listener report the assigned port back, or mark a ' +
        `data-only literal with \`${ALLOW_MARKER}\`.\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

describe('no test writes a fixed-name file into the real home directory', () => {
  const WRITE_CALLS = ['writeFileSync', 'appendFileSync', 'copyFileSync', 'createWriteStream'];

  /**
   * Collect the single-line `const X = ...` identifiers whose right-hand
   * side reaches `os.homedir()`, directly or through another such alias.
   */
  function homedirAliases(src: string): Map<string, string> {
    const decls = [...src.matchAll(/^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*(.+)$/gm)].map((m) => ({
      name: m[1],
      rhs: m[2],
    }));
    const found = new Map<string, string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const d of decls) {
        if (found.has(d.name)) continue;
        const reachesHome =
          /\bhomedir\(\)/.test(d.rhs) ||
          [...found.keys()].some((k) => new RegExp(`\\b${k}\\b`).test(d.rhs));
        if (reachesHome) {
          found.set(d.name, d.rhs);
          changed = true;
        }
      }
    }
    return found;
  }

  function homedirWrites(src: string): { name: string; rhs: string }[] {
    const hits: { name: string; rhs: string }[] = [];
    for (const [name, rhs] of homedirAliases(src)) {
      const written = WRITE_CALLS.some((fn) => new RegExp(`${fn}\\(\\s*${name}\\b`).test(src));
      if (written) hits.push({ name, rhs });
    }
    return hits;
  }

  it('still detects at least one home-directory write (guard is not inert)', () => {
    const total = TEST_FILES.reduce(
      (n, f) => n + homedirWrites(fs.readFileSync(f, 'utf8')).length,
      0,
    );
    // session-lock.test.ts's ace#1704 sentinel is the one legitimate case.
    // If this hits zero, either it moved or the alias tracking rotted.
    expect(total).toBeGreaterThan(0);
  });

  it('every such path carries process.pid, so concurrent runners cannot collide', () => {
    const offenders: string[] = [];
    for (const file of TEST_FILES) {
      const src = fs.readFileSync(file, 'utf8');
      for (const hit of homedirWrites(src)) {
        if (!/process\.pid/.test(hit.rhs)) {
          offenders.push(`${rel(file)}  const ${hit.name} = ${hit.rhs.trim()}`);
        }
      }
    }
    expect(
      offenders,
      '`~/` is shared by every ACE session and every concurrent `npm test` ' +
        'on the machine. A fixed filename there is one path they all write, ' +
        'assert on and delete — the second runner goes red between the ' +
        "first's cleanup and its own assertion (ace#1743). Interpolate " +
        `\`process.pid\` into the name.\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
