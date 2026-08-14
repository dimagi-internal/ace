/**
 * dimagi-internal/ace#1156 — `selector_map_currency` validated whatever
 * `ACE_CONNECT_APK_VERSION` named and was therefore structurally incapable of
 * detecting a STALE pin.
 *
 * The state that shipped a green preflight (spark-facilitator/20260731-0656):
 *
 *   .env.tpl (repo)                  2.63.2
 *   client.ts DEFAULT_APK_VERSION    2.63.2
 *   newest map on disk               connect-2.63.2.yaml
 *   installed .env on that machine   2.63.0     <- /ace:update never touches it
 *   CommCare on the AVD              2.63.0
 *   selector_map_currency            PASS
 *
 * `connect-2.63.0.yaml` is fully populated and internally consistent, so the
 * probe passed on it: it verifies internal consistency with whatever it is
 * pointed at. The fallback path would have been RIGHT (newest map wins) —
 * setting the env var is what broke it. A pin that can only ever DOWNGRADE the
 * check is worse than no pin.
 *
 * Near-miss, not a loss, only because an agent stalled: new selector rows were
 * about to be written into a map the runtime does not load by default — the
 * #591/#593 selector-drift failure re-entered through the front door with a
 * green doctor.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const url = (p: string) => new URL(`../${p}`, import.meta.url);
const read = (p: string) => readFileSync(url(p), 'utf-8');

/** `DEFAULT_APK_VERSION` — the version the runtime actually loads. */
function codeDefault(): string {
  const m = /export const DEFAULT_APK_VERSION = '([^']+)'/.exec(read('mcp/mobile/client.ts'));
  expect(m, 'DEFAULT_APK_VERSION not found in mcp/mobile/client.ts').toBeTruthy();
  return m![1];
}

function tplPin(): string {
  const m = /^ACE_CONNECT_APK_VERSION=(.+)$/m.exec(read('.env.tpl'));
  expect(m, 'ACE_CONNECT_APK_VERSION not found in .env.tpl').toBeTruthy();
  return m![1].trim();
}

function newestMapVersion(): string {
  const versions = readdirSync(url('mcp/mobile/selectors'))
    .map((f) => /^connect-(.+)\.yaml$/.exec(f)?.[1])
    .filter((v): v is string => Boolean(v))
    .sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
    );
    return versions[versions.length - 1];
}

describe('APK pin currency (#1156)', () => {
  it('.env.tpl pins exactly the version the code defaults to', () => {
    // They agree today and nothing enforced it — which is how a machine ends
    // up pinned a version behind the runtime.
    expect(tplPin()).toBe(codeDefault());
  });

  it('the code default is the newest selector map on disk', () => {
    // A code default older than the newest map means the calibrated map is
    // dead weight; newer means the runtime loads a map that does not exist.
    expect(codeDefault()).toBe(newestMapVersion());
  });

  it('CLAUDE.md does not advertise a stale default APK', () => {
    const claude = read('CLAUDE.md');
    const m = /default APK ([0-9]+\.[0-9]+\.[0-9]+)/.exec(claude);
    expect(m, 'CLAUDE.md no longer states a default APK — update this test if that was deliberate').toBeTruthy();
    expect(m![1]).toBe(codeDefault());
  });
});

describe('ace-doctor selector_map_currency cross-checks the pin (#1156)', () => {
  const doctor = () => read('bin/ace-doctor');

  it('resolves the code default and the newest map, not just the pin', () => {
    expect(doctor()).toMatch(/PF_SEL_CODE_DEFAULT=/);
    expect(doctor()).toMatch(/PF_SEL_NEWEST_MAP=/);
  });

  it('reports all three values in the preflight YAML so the disagreement is visible', () => {
    const body = doctor();
    expect(body).toMatch(/^\s+pin:/m);
    expect(body).toMatch(/^\s+code_default:/m);
    expect(body).toMatch(/^\s+newest_map:/m);
  });

  it('FAILS a stale pin and names the one command that fixes it', () => {
    const body = doctor();
    // /ace:update does not touch the installed .env — only /ace:setup
    // --force-env does, and nothing forces that. Naming the wrong command
    // here is what left the machine a version behind.
    expect(body).toMatch(/ace:setup --force-env/);
    expect(body).toMatch(/PF_SEL_STATUS="fail"[\s\S]{0,400}stale/i);
  });
});
