import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveSelectorsInYaml,
  injectAceEnvVars,
} from '../../../mcp/mobile/recipe-resolver.js';
import { TEST_PHONE } from '../../fixtures/test-phone.js';

describe('resolveSelectorsInYaml', () => {
  it('substitutes id-typed selectors with id matchers', () => {
    const yaml = `
- extendedWaitUntil:
    visible:
      \${SELECTOR:learn-home-start-tile}
    timeout: 30000
`;
    const r = resolveSelectorsInYaml(yaml, '2.62.0');
    expect(r.unresolved).toEqual([]);
    // learn-home-start-tile is a text-type selector per the live map.
    expect(r.yaml).toContain('text: "Start"');
  });

  it('substitutes resource-id selectors with id matchers', () => {
    const yaml = `
- tapOn:
    \${SELECTOR:form-nav-next}
`;
    const r = resolveSelectorsInYaml(yaml, '2.62.0');
    expect(r.unresolved).toEqual([]);
    expect(r.yaml).toContain('id: "org.commcare.dalvik:id/nav_btn_next"');
  });

  it('flags unverified selectors as `unverified` but still resolves them', () => {
    // form-submit is intentionally unverified per the current map.
    const yaml = `
- tapOn:
    \${SELECTOR:form-submit}
`;
    const r = resolveSelectorsInYaml(yaml, '2.62.0');
    expect(r.unresolved).toEqual([]);
    expect(r.unverified).toContain('form-submit');
    expect(r.yaml).toContain('text: "Submit"');
  });

  it('records unresolved placeholders and emits a comment marker', () => {
    const yaml = `
- tapOn:
    \${SELECTOR:does-not-exist}
`;
    const r = resolveSelectorsInYaml(yaml, '2.62.0');
    expect(r.unresolved).toEqual(['does-not-exist']);
    expect(r.yaml).toContain('# UNRESOLVED does-not-exist');
  });

  it('throws when the selector map for the APK version is missing', () => {
    expect(() => resolveSelectorsInYaml('- noop: true\n', '0.0.0')).toThrow(
      /selector map not found/,
    );
  });

  // ── Value-position placeholders (#650) ────────────────────────────
  // `"${SELECTOR:name}"` (inside quotes) resolves to just the bare value,
  // leaving the author's `id:`/`text:` key intact — the form that is
  // raw-YAML-valid beside `below:`/`childOf:` siblings.
  it('resolves a VALUE-position placeholder to the bare quoted value', () => {
    const yaml = `
- tapOn:
    id: "\${SELECTOR:form-nav-next}"
`;
    const r = resolveSelectorsInYaml(yaml, '2.62.0');
    expect(r.unresolved).toEqual([]);
    // bare value substituted inside the author's quotes — NOT a nested `id: "id: ..."`.
    expect(r.yaml).toContain('id: "org.commcare.dalvik:id/nav_btn_next"');
    expect(r.yaml).not.toContain('id: "id:');
  });

  it('keeps a VALUE-position placeholder valid + scoped beside below/childOf siblings', () => {
    const yaml = `
- tapOn:
    id: "\${SELECTOR:form-nav-next}"
    below:
      text: \${OPP_NAME}
    retryTapIfNoChange: true
`;
    const r = resolveSelectorsInYaml(yaml, '2.62.0');
    expect(r.unresolved).toEqual([]);
    expect(r.yaml).toContain('id: "org.commcare.dalvik:id/nav_btn_next"');
    // siblings preserved verbatim (scoping intact after resolution)
    expect(r.yaml).toContain('below:');
    expect(r.yaml).toContain('text: ${OPP_NAME}');
    expect(r.yaml).toContain('retryTapIfNoChange: true');
  });

  it('VALUE position carries the `unverified` flag like key position', () => {
    const yaml = `- assertVisible:\n    text: "\${SELECTOR:form-submit}"\n`;
    const r = resolveSelectorsInYaml(yaml, '2.62.0');
    expect(r.unresolved).toEqual([]);
    expect(r.unverified).toContain('form-submit');
    expect(r.yaml).toContain('text: "Submit"');
  });

  it('VALUE position records unresolved + emits a quoted comment marker', () => {
    const yaml = `- assertVisible:\n    id: "\${SELECTOR:does-not-exist}"\n`;
    const r = resolveSelectorsInYaml(yaml, '2.62.0');
    expect(r.unresolved).toEqual(['does-not-exist']);
    expect(r.yaml).toContain('"# UNRESOLVED does-not-exist"');
  });
});

describe('injectAceEnvVars', () => {
  let savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'ACE_E2E_PIN',
    'ACE_E2E_PHONE',
    'ACE_E2E_PHONE_LOCAL',
    'ACE_E2E_COUNTRY_CODE',
    'ACE_E2E_BACKUP_CODE',
    'ACE_E2E_NAME',
  ] as const;

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('injects each ACE_E2E_* var as its short Maestro name', () => {
    process.env.ACE_E2E_PIN = '111111';
    process.env.ACE_E2E_PHONE = TEST_PHONE;
    process.env.ACE_E2E_BACKUP_CODE = '222222';

    const out = injectAceEnvVars({});
    expect(out.PIN).toBe('111111');
    expect(out.PHONE).toBe(TEST_PHONE);
    expect(out.BACKUP_CODE).toBe('222222');
    // Unset vars don't appear in output.
    expect(out.NAME).toBeUndefined();
  });

  it('caller-provided env wins over auto-injection', () => {
    process.env.ACE_E2E_PIN = '111111';
    const out = injectAceEnvVars({ PIN: '999999' });
    expect(out.PIN).toBe('999999');
  });

  it('passes through arbitrary caller-provided keys', () => {
    const out = injectAceEnvVars({ OPP_NAME: 'turmeric', SCREENSHOT_NAME: 'journey-learn-01' });
    expect(out.OPP_NAME).toBe('turmeric');
    expect(out.SCREENSHOT_NAME).toBe('journey-learn-01');
  });

  it('returns an empty-ish dict when neither caller nor env supply values', () => {
    const out = injectAceEnvVars({});
    expect(Object.keys(out)).toEqual([]);
  });
});
