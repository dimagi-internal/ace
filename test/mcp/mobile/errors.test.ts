import { describe, it, expect } from 'vitest';
import {
  MobileError, AvdBootError, RecipeValidationError, AdbError, MaestroError
} from '../../../mcp/mobile/errors.js';

describe('mobile errors', () => {
  it('AvdBootError carries avd name + remediation', () => {
    const err = new AvdBootError('ACE_Pixel_API_34', 'timeout after 90s');
    expect(err).toBeInstanceOf(MobileError);
    expect(err.code).toBe('AVD_BOOT_FAILED');
    expect(err.remediation).toMatch(/ace:mobile-bootstrap/);
    expect(err.message).toContain('ACE_Pixel_API_34');
  });

  it('RecipeValidationError includes the offending YAML path', () => {
    const err = new RecipeValidationError('/tmp/bad.yaml', 'unknown step type');
    expect(err.code).toBe('RECIPE_INVALID');
    expect(err.message).toContain('/tmp/bad.yaml');
  });

  it('AdbError and MaestroError carry exit codes', () => {
    expect(new AdbError('install', 1, 'INSTALL_FAILED_VERSION_DOWNGRADE').exitCode).toBe(1);
    expect(new MaestroError('flow.yaml', 2, 'TIMEOUT').exitCode).toBe(2);
  });
});
