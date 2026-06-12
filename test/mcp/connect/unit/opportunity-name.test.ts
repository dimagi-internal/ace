// Unit tests for the opportunity-name guard — the code-enforced
// "is_test opportunity names MUST carry a run-id front prefix" preventer
// (jjackson/ace#755).
//
// Replaces SKILL.md-prose-only enforcement, which failed live on
// bednet-spot-check/20260612-1220: Phase 4 created the opp as plain
// "Bednet Spot-Check" and both Phase 6 mobile legs failed deterministically
// (`No visible element found: ".*20260612-1220.*"`) because the tile
// matchers anchor on the run-id prefix.
import { describe, it, expect } from 'vitest';
import {
  OPP_NAME_RUN_ID_PREFIX_RE,
  assertRunIdNamePrefix,
  InvalidOppNamePrefixError,
} from '../../../../mcp/connect/opportunity-name.js';

describe('OPP_NAME_RUN_ID_PREFIX_RE', () => {
  it('matches a canonical run-id front prefix with U+00B7 separator', () => {
    expect(OPP_NAME_RUN_ID_PREFIX_RE.test('20260609-0909 · Bednet Spot-Check')).toBe(true);
  });

  it('rejects an ASCII-hyphen or period stand-in for the middot', () => {
    expect(OPP_NAME_RUN_ID_PREFIX_RE.test('20260609-0909 - Bednet Spot-Check')).toBe(false);
    expect(OPP_NAME_RUN_ID_PREFIX_RE.test('20260609-0909 . Bednet Spot-Check')).toBe(false);
  });

  it('rejects a run-id SUFFIX (the old, clipped-on-tile form)', () => {
    expect(
      OPP_NAME_RUN_ID_PREFIX_RE.test('Bednet Spot-Check — bednet (run 20260609-0909)'),
    ).toBe(false);
  });
});

describe('assertRunIdNamePrefix', () => {
  it('rejects a bare display name when is_test is true (the 20260612-1220 live failure)', () => {
    expect(() => assertRunIdNamePrefix('Bednet Spot-Check', true)).toThrow(
      InvalidOppNamePrefixError,
    );
    expect(() => assertRunIdNamePrefix('Bednet Spot-Check', true)).toThrow(
      /INVALID_OPP_NAME_PREFIX/,
    );
  });

  it('names the contract, the offending value, and the issue in the error', () => {
    try {
      assertRunIdNamePrefix('Bednet Spot-Check', true);
      expect.unreachable('should have thrown');
    } catch (e) {
      const err = e as InvalidOppNamePrefixError;
      expect(err).toBeInstanceOf(InvalidOppNamePrefixError);
      expect(err.retryable).toBe(false);
      expect(err.message).toContain('"<run_id> · <display name>"');
      expect(err.message).toContain('got: "Bednet Spot-Check"');
      expect(err.message).toContain('skills/connect-opp-setup/SKILL.md');
      expect(err.message).toContain('jjackson/ace#755');
      expect(err.toJSON()).toEqual({
        error: 'invalid_opp_name_prefix',
        message: err.message,
        name: 'Bednet Spot-Check',
      });
    }
  });

  it('accepts a correctly-prefixed name when is_test is true', () => {
    expect(() =>
      assertRunIdNamePrefix('20260609-0909 · Bednet Spot-Check', true),
    ).not.toThrow();
  });

  it('does NOT validate when is_test is false', () => {
    expect(() => assertRunIdNamePrefix('Bednet Spot-Check', false)).not.toThrow();
  });

  it('does NOT validate when is_test is absent', () => {
    expect(() => assertRunIdNamePrefix('Bednet Spot-Check', undefined)).not.toThrow();
  });
});
