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

// ace#2821: the "skip email" confirmation differs by APK. 2.64.0 shows
// "Skip email?" with NO (negative_button — a recorded ANTI-TARGET) / YES;
// CommCare 2.66 shows "Protect your account" with SKIP (negative_button) /
// ADD EMAIL. The recipe must probe for the 2.66 SKIP before falling back to
// YES, and must never tap `negative_button` by id alone (that is NO on 2.64.0).
describe('email-skip confirmation handles 2.64.0 YES and 2.66 SKIP (ace#2821)', () => {
  const file = 'connect-register-from-otp.yaml';
  const NEG = 'org.commcare.dalvik:id/negative_button';

  /** The commands of the top-level runFlow that taps personalid_email_skip_button. */
  function emailBlock(): Array<Record<string, any>> {
    let found: Array<Record<string, any>> | null = null;
    walk(steps(file), (m) => {
      const rf = m.runFlow as Record<string, any> | undefined;
      const cmds = rf?.commands as Array<Record<string, any>> | undefined;
      if (!found && cmds?.[0]?.tapOn?.id === 'org.commcare.dalvik:id/personalid_email_skip_button') found = cmds;
    });
    expect(found, 'email-skip block not found').not.toBeNull();
    return found!;
  }

  it('waits for either confirmation shape before probing', () => {
    const wait = emailBlock().find((c) => c.extendedWaitUntil?.visible?.text);
    expect(wait?.extendedWaitUntil.visible.text).toMatch(/YES/);
    expect(wait?.extendedWaitUntil.visible.text).toMatch(/SKIP/);
  });

  it('probes the 2.66 SKIP, then taps SKIP or YES on the probe result — in that order', () => {
    const cmds = emailBlock();
    const probeIdx = cmds.findIndex(
      (c) =>
        c.runFlow?.optional === true &&
        c.runFlow.commands[0]?.extendedWaitUntil?.visible?.id === NEG &&
        c.runFlow.commands[0]?.extendedWaitUntil?.visible?.text === 'SKIP',
    );
    const skipIdx = cmds.findIndex((c) => c.runFlow?.commands?.some((x: any) => x.tapOn?.text === 'SKIP'));
    const yesIdx = cmds.findIndex((c) => c.runFlow?.commands?.some((x: any) => x.tapOn?.text === 'YES'));
    expect(probeIdx).toBeGreaterThan(-1);
    expect(skipIdx).toBeGreaterThan(probeIdx);
    expect(yesIdx).toBeGreaterThan(probeIdx);
    // The two taps are gated on opposite values of the same probe flag.
    const skipWhen = String(cmds[skipIdx].runFlow.when.true);
    const yesWhen = String(cmds[yesIdx].runFlow.when.true);
    const flag = skipWhen.match(/output\.(\w+)/)?.[1];
    expect(flag).toBeTruthy();
    expect(yesWhen).toContain(`!output.${flag}`);
    expect(skipWhen).not.toContain('!');
  });

  it('never taps negative_button without text SKIP (it is NO on 2.64.0)', () => {
    const bad: string[] = [];
    walk(steps(file), (m) => {
      const t = m.tapOn as Record<string, unknown> | undefined;
      if (t?.id === NEG && t.text !== 'SKIP') bad.push(JSON.stringify(t));
    });
    expect(bad).toEqual([]);
  });
});
