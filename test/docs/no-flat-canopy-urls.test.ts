/**
 * Ratchet: ACE's own files never carry a flat canopy-web artifact link
 * (dimagi-internal/canopy-web#1337; observed and filed as ace#2824).
 *
 * Every canopy-web link is https://canopy.dimagi.com/w/<workspace>/…. Flat /review/<id>,
 * /walkthrough/<id>, /ddd/<slug>, /share/<token> and legacy /w/<uuid> links depended on
 * redirects canopy-web is removing; on 2026-10-08 one went out in an external email. A
 * skill or doc that shows the flat form is how the next agent learns to write it, so this
 * scan keeps them out. Same rule as bin/canopy_url_scope.py (the send-path and wrapper
 * rails); keep the two in step.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Files that must contain flat links ON PURPOSE — each with its reason.
const ALLOW: Record<string, string> = {
  'test/hooks/email-shims.test.ts': 'controls: the send-path rail must refuse these exact flat links',
  'test/scripts/ace-canopy-web.test.ts': 'controls: the wrapper must rewrite these exact flat links',
  'test/docs/no-flat-canopy-urls.test.ts': 'this file',
  'bin/canopy_url_scope.py': 'the rule itself describes the flat forms it refuses',
  'CHANGELOG.md': 'history: past entries may quote links as they were',
};

const NON_TENANT = new Set(['about', 'guide', 'invite', 'new-workspace', 'beta-requests', 'api', 'static', 'accounts']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_RE = /https?:\/\/(canopy|canopy-web)\.dimagi\.com(\/[^\s<>"'`)\]]*)?/gi;

export function isFlat(pathPart: string | undefined): boolean {
  const segs = (pathPart ?? '/').replace(/[.,;:!?]+$/, '').replace(/^\/+/, '').split(/[/?#]/);
  const first = (segs[0] ?? '').toLowerCase();
  if (first === '') return false;
  if (first === 'w') return UUID.test(segs[1] ?? '');
  return !NON_TENANT.has(first);
}

function tracked(): string[] {
  return execSync('git ls-files', { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f && /\.(md|ts|mts|py|json|ya?ml|sh|txt|html)$/.test(f) || /^bin\//.test(f))
    .filter((f) => !f.startsWith('node_modules/'));
}

describe('no flat canopy-web links in ACE (canopy-web#1337)', () => {
  it('the classifier agrees with the rail on the controls', () => {
    expect(isFlat('/review/abc/?t=x')).toBe(true);
    expect(isFlat('/walkthrough/abc')).toBe(true);
    expect(isFlat('/ddd/slug')).toBe(true);
    expect(isFlat('/w/1be9271a-f83e-457d-8df5-1daf84295a2a?t=y')).toBe(true);
    expect(isFlat('/w/connect/review/abc?t=x')).toBe(false);
    expect(isFlat('/about')).toBe(false);
    expect(isFlat(undefined)).toBe(false);
  });

  it('no tracked file outside the allowlist carries a flat canopy-web link', () => {
    const hits: string[] = [];
    for (const f of tracked()) {
      if (ALLOW[f]) continue;
      const p = path.join(REPO, f);
      if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) continue;
      const text = fs.readFileSync(p, 'utf8');
      for (const m of text.matchAll(URL_RE)) {
        if (isFlat(m[2])) hits.push(`${f}: ${m[0]}`);
      }
    }
    expect(hits, `use https://canopy.dimagi.com/w/<workspace>/… instead:\n${hits.join('\n')}`).toEqual([]);
  });

  it('every allowlisted file still exists (a stale allowlist entry hides nothing and should go)', () => {
    for (const f of Object.keys(ALLOW)) {
      if (f === 'CHANGELOG.md') continue;
      expect(fs.existsSync(path.join(REPO, f)), f).toBe(true);
    }
  });
});
