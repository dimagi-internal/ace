/**
 * Tests for lib/redact-secrets — the pre-upload transcript scrubber.
 *
 * Security audit 2026-07-31 (D1): the upload path shipped the raw session
 * .jsonl with no redaction, so a `cat .env` in the transcript leaked every
 * credential to ace-web. These tests pin that the concrete secret shapes this
 * repo emits are scrubbed, that the JSONL stays structurally valid, and that
 * ordinary content is left alone. "An issue is not a regression test" — this
 * is the gate that keeps the class closed.
 */
import { describe, it, expect } from 'vitest';
import { redactSecrets, REDACTED } from '../../lib/redact-secrets.js';

describe('redactSecrets', () => {
  it('redacts a .env dump embedded in a JSONL tool result and keeps valid JSON', () => {
    const secret = 'sk-hunter2-do-not-leak';
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            content: `ACE_HQ_PASSWORD=${secret}\nLABS_MCP_TOKEN=labs-abc123\nOCS_API_TOKEN=ocs-xyz`,
          },
        ],
      },
    });
    const out = redactSecrets(line);
    expect(out).not.toContain(secret);
    expect(out).not.toContain('labs-abc123');
    expect(out).not.toContain('ocs-xyz');
    expect(out).toContain('ACE_HQ_PASSWORD=');
    // still parseable as JSON (the redaction stayed inside the string value)
    const parsed = JSON.parse(out);
    expect(parsed.message.content[0].content).toContain(REDACTED);
  });

  it.each([
    ['Bearer token', 'Authorization: Bearer eyJhbGciOiJI.super.secret', 'eyJhbGciOiJI.super.secret'],
    ['ApiKey user:key', 'Authorization: ApiKey ace@dimagi-ai.com:deadbeefdeadbeef', 'deadbeefdeadbeef'],
    ['session cookie', 'Cookie: sessionid_ace=abc123def456; path=/', 'abc123def456'],
    ['csrftoken', 'csrftoken=9f8e7d6c5b4a; other=1', '9f8e7d6c5b4a'],
    ['op ref', 'OCS_API_TOKEN=op://Agent-Ace/item/credential', 'op://Agent-Ace/item/credential'],
    ['aws key', 'aws_key: AKIAIOSFODNN7EXAMPLE done', 'AKIAIOSFODNN7EXAMPLE'],
    ['generic password', 'DB_PASSWORD=p@ssw0rd!', 'p@ssw0rd!'],
    ['pat token', 'ACE_WEB_PAT_TOKEN=pat_live_1234567890', 'pat_live_1234567890'],
  ])('redacts %s', (_label, input, secret) => {
    const out = redactSecrets(input);
    expect(out).not.toContain(secret);
    expect(out).toMatch(/REDACTED/);
  });

  it('redacts a PEM private key block', () => {
    const pem =
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqh...body...\n-----END PRIVATE KEY-----';
    const out = redactSecrets(`gws key: ${pem}`);
    expect(out).not.toContain('MIIEvQIBADANBgkqh');
    expect(out).toContain('[REDACTED-PRIVATE-KEY]');
  });

  it('leaves ordinary content untouched', () => {
    const clean = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Phase 6 passed. The opp slug is bednet-2026.' }] },
    });
    expect(redactSecrets(clean)).toBe(clean);
  });

  it('does not redact a bare env-var REFERENCE (no value)', () => {
    // "read ${CLAUDE_PLUGIN_DATA}/.env" names a path, carries no secret value.
    const s = 'To inspect env state, read ${CLAUDE_PLUGIN_DATA}/.env directly';
    expect(redactSecrets(s)).toBe(s);
  });

  it('is idempotent', () => {
    const once = redactSecrets('ACE_HQ_PASSWORD=secret123');
    expect(redactSecrets(once)).toBe(once);
  });

  it('scrubs a multi-line JSONL transcript and every line stays valid JSON', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'normal line' } }),
      JSON.stringify({ type: 'user', message: { content: 'LABS_MCP_TOKEN=leak-me-123' } }),
      JSON.stringify({ type: 'assistant', message: { content: 'Authorization: Bearer tok-abc' } }),
    ].join('\n');
    const out = redactSecrets(lines);
    expect(out).not.toContain('leak-me-123');
    expect(out).not.toContain('tok-abc');
    for (const line of out.split('\n')) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
