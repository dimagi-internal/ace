import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

// ace#2894: `form-submit.yaml`'s POST_SUBMIT frame is "the screen after
// finalize". On a plain (non-score-gated) Deliver form that is the FORM LIST
// with no toast — finalize writes the visit to the local outbox and does not
// sync (ace#1066). A frame NAMED `*-confirmation` is captioned as a
// confirmation downstream (training deck, FLW guide) while it shows a form
// list: right claim, wrong picture. The fix is the name, not a toast wait —
// awaiting "form sent to server" on the plain path would time out on every
// plain submit, because that toast never renders there.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const STATIC_DIR = join(ROOT, 'mcp/mobile/recipes/static');

function walk(dir: string, ext: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p, ext) : p.endsWith(ext) ? [p] : [];
  });
}

/** Every `SCREENSHOT_NAME_POST_SUBMIT: "<name>"` binding, plus the doc example form. */
function postSubmitBindings(text: string): string[] {
  return [
    ...[...text.matchAll(/SCREENSHOT_NAME_POST_SUBMIT\s*:\s*["']?([A-Za-z0-9_${}.-]+)/g)].map((m) => m[1]),
    // prose like "`deliver-final-review` / `deliver-submitted-confirmation`"
    ...[...text.matchAll(/`[a-z0-9-]+-final-review`\s*\/\s*`([a-z0-9-]+)`/g)].map((m) => m[1]),
  ];
}

describe('form-submit POST_SUBMIT is never named a confirmation (ace#2894)', () => {
  const sources = [
    ...walk(STATIC_DIR, '.yaml'),
    ...walk(join(ROOT, 'skills'), '.md'),
    ...walk(join(ROOT, 'playbook'), '.md'),
  ];

  it('no recipe or skill binds POST_SUBMIT to a *-confirmation name', () => {
    const offenders: string[] = [];
    for (const f of sources) {
      for (const name of postSubmitBindings(readFileSync(f, 'utf8'))) {
        if (/confirm/i.test(name)) offenders.push(`${f.slice(ROOT.length)}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the parameter doc itself does not promise a confirmation frame', () => {
    const text = readFileSync(join(STATIC_DIR, 'form-submit.yaml'), 'utf8');
    const doc = text.slice(text.indexOf('${SCREENSHOT_NAME_POST_SUBMIT} —'));
    expect(doc.slice(0, 200)).not.toMatch(/after submit confirmation/);
    expect(doc).toMatch(/Daily Visits/);
  });

  it('the plain path does NOT await the sent-to-server toast (it never renders there)', () => {
    const text = readFileSync(join(STATIC_DIR, 'form-submit.yaml'), 'utf8');
    const steps = parseYaml(text.split(/^---$/m)[1]) as Array<Record<string, unknown>>;
    // Top-level steps run on EVERY path. The toast wait belongs only inside
    // the score-gated `form-nav-finish` branch.
    const topLevelToastWaits = steps.filter(
      (s) => 'extendedWaitUntil' in s && JSON.stringify(s).includes('sent to server'),
    );
    expect(topLevelToastWaits).toEqual([]);
    expect(JSON.stringify(steps)).toContain('sent to server'); // still on the score-gated branch
  });
});
