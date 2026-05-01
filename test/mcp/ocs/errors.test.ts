import { describe, it, expect } from 'vitest';
import {
  OcsError,
  SessionExpiredError,
  OcsLoginFailedError,
  CsrfTokenMissingError,
  PipelineShapeError,
  PipelineValidationError,
  CollectionIndexingTimeoutError,
  HttpError,
} from '../../../mcp/ocs/errors.js';

describe('OcsError hierarchy', () => {
  it('HttpError carries status, path, and body', () => {
    const e = new HttpError(404, '/api/experiments/99/', 'Not Found');
    expect(e).toBeInstanceOf(OcsError);
    expect(e.status).toBe(404);
    expect(e.path).toBe('/api/experiments/99/');
    expect(e.body).toBe('Not Found');
    expect(e.message).toContain('404');
  });

  it('PipelineValidationError carries a list of validation errors', () => {
    const e = new PipelineValidationError(['node foo missing input', 'edge bar dangling']);
    expect(e).toBeInstanceOf(OcsError);
    expect(e.validationErrors).toEqual(['node foo missing input', 'edge bar dangling']);
  });

  it('PipelineShapeError identifies the invariant violation', () => {
    const e = new PipelineShapeError('Expected 1 node, found 3');
    expect(e).toBeInstanceOf(OcsError);
    expect(e.message).toContain('Expected 1 node, found 3');
  });

  it('SessionExpiredError points at the auto-login env vars and the manual fallback', () => {
    const e = new SessionExpiredError();
    expect(e.message).toMatch(/OCS_USERNAME/);
    expect(e.message).toMatch(/OCS_PASSWORD/);
    expect(e.message).toMatch(/ace:ocs-login/);
  });

  it('OcsLoginFailedError names the username and is not retryable', () => {
    const e = new OcsLoginFailedError('ace@dimagi-ai.com');
    expect(e).toBeInstanceOf(OcsError);
    expect(e.username).toBe('ace@dimagi-ai.com');
    expect(e.message).toContain('ace@dimagi-ai.com');
    expect(e.retryable).toBe(false);
  });

  it('CollectionIndexingTimeoutError names the collection', () => {
    const e = new CollectionIndexingTimeoutError(42, 300);
    expect(e.collectionId).toBe(42);
    expect(e.timeoutSec).toBe(300);
  });

  it('CsrfTokenMissingError is retryable', () => {
    const e = new CsrfTokenMissingError();
    expect(e.retryable).toBe(true);
  });
});
