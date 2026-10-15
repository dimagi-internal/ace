// The registration recipes run on EVERY `mobile_ensure_avd_running`, on both
// backends, so their cost is paid on every cold boot.
//
// A `runFlow: when: visible:` / `notVisible:` guard that does not match costs
// Maestro's fixed optional-lookup timeout — 7000 ms minus the time since the
// last tap (`Orchestra.optionalLookupTimeoutMs` / `adjustedToLatestInteraction`
// in maestro-orchestra; no CLI flag or recipe key changes it). Before
// 2026-10-15 these two recipes carried ~10 misses per walk: ~65-70 s of a
// ~3 min sign-up, measured on both the Mac and the leased emulator. They now
// PROBE optional screens (an `optional: true` runFlow around an
// `extendedWaitUntil` with an explicit short timeout, then `when: true:`),
// and this test keeps the 7 s guard from creeping back.
//
// The union waits list RAW ids (a `${SELECTOR:...}` placeholder only resolves
// as a whole value, not inside an `a|b|c` regex), so the second test pins each
// CommCare id in them to a row of the active selector map.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, parseAllDocuments } from 'yaml';

const STATIC = path.join(__dirname, '../../../mcp/mobile/recipes/static');
const RECIPES = ['connect-register-to-otp.yaml', 'connect-register-from-otp.yaml'];
const MAP = parseYaml(
  fs.readFileSync(path.join(__dirname, '../../../mcp/mobile/selectors/connect-2.64.0.yaml'), 'utf8'),
).selectors as Record<string, { type: string; value: string }>;

function walk(node: unknown, visit: (m: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) node.forEach((n) => walk(n, visit));
  else if (node && typeof node === 'object') {
    visit(node as Record<string, unknown>);
    Object.values(node).forEach((v) => walk(v, visit));
  }
}

function steps(file: string): unknown {
  const docs = parseAllDocuments(fs.readFileSync(path.join(STATIC, file), 'utf8'));
  return docs[docs.length - 1].toJS();
}

describe('registration recipes probe optional screens instead of 7 s guards', () => {
  for (const file of RECIPES) {
    it(`${file} has no runFlow when: visible/notVisible guard`, () => {
      const guards: string[] = [];
      walk(steps(file), (m) => {
        const rf = m.runFlow as Record<string, unknown> | undefined;
        const when = rf?.when as Record<string, unknown> | undefined;
        if (when && ('visible' in when || 'notVisible' in when)) guards.push(JSON.stringify(when));
      });
      expect(guards).toEqual([]);
    });

    it(`${file}: every probe has an explicit short window`, () => {
      const windows: number[] = [];
      walk(steps(file), (m) => {
        const rf = m.runFlow as Record<string, unknown> | undefined;
        if (rf?.optional !== true) return;
        const first = (rf.commands as Array<Record<string, any>>)[0];
        windows.push(Number(first?.extendedWaitUntil?.timeout));
      });
      expect(windows.length).toBeGreaterThan(0);
      for (const w of windows) expect(w).toBeLessThanOrEqual(3000);
    });

    it(`${file}: raw CommCare ids in union waits match the selector map`, () => {
      const mapIds = new Set(Object.values(MAP).filter((e) => e.type === 'id').map((e) => e.value));
      const raw: string[] = [];
      walk(steps(file), (m) => {
        const w = m.extendedWaitUntil as Record<string, any> | undefined;
        const id = w?.visible?.id;
        if (typeof id === 'string' && id.includes('|')) {
          for (const part of id.split('|')) if (part.startsWith('org.commcare.dalvik:id/')) raw.push(part);
        }
      });
      expect(raw.length).toBeGreaterThan(0);
      // take_photo_button has no map row (it is a raw-id branch by design — see
      // the photo-capture block's comment); everything else must be mapped.
      const unmapped = raw.filter((id) => !mapIds.has(id) && !id.endsWith('/take_photo_button'));
      expect(unmapped).toEqual([]);
    });
  }
});
