/**
 * Secret redaction for session transcripts before they leave the machine.
 *
 * Security audit 2026-07-31 (finding D1): `skills/upload-transcript` POSTs the
 * raw Claude Code session `.jsonl` to ace-web with ZERO redaction. That log
 * contains the full stdout of every Bash tool call — and CLAUDE.md itself tells
 * the agent to `cat $CLAUDE_PLUGIN_DATA/.env` to inspect env state, which puts
 * `ACE_HQ_PASSWORD`, `LABS_MCP_TOKEN`, `OCS_API_TOKEN*`, `ACE_WEB_PAT_TOKEN`, the
 * SA-key contents, and live `~/.ace/*-session.json` cookies verbatim into the
 * artifact. Opt-in consent to publish a WORK RECORD is not consent to publish
 * CREDENTIALS, so we scrub secret-shaped strings before the upload.
 *
 * Design notes:
 *   - Operates on the raw text (works line-by-line on JSONL or on a whole blob).
 *   - Replacement tokens contain NO `"` / `\` / control chars, so redacting a
 *     value INSIDE a JSON string leaves the JSON structurally valid.
 *   - Value-matchers stop at the first `"`, whitespace, `,`, `}` or `\` so they
 *     never eat past the end of the JSON string they sit in.
 *   - This is defense-in-depth, not a proof: it targets the concrete secret
 *     shapes this repo actually emits. The real fix for a NEW secret shape is to
 *     add a pattern here (with a fixture) — see the test.
 */

export const REDACTED = '[REDACTED]';

/** Value characters that terminate a secret value inside JSON or a shell line. */
const VAL = `[^\\s"'\\\\,}{;&|]+`;

/**
 * Env var / config keys whose VALUE is always a secret. Kept explicit (not just
 * the generic name rule below) so a rename in `.env.tpl` that drops the
 * password/token/key suffix is still covered. Mirrors the `.env.tpl` key set.
 */
export const SECRET_ENV_KEYS = [
  'ACE_HQ_PASSWORD',
  'ACE_HQ_API_KEY',
  'ACE_HQ_US_API_KEY',
  'ACE_HQ_EU_API_KEY',
  'ACE_HQ_INDIA_API_KEY',
  'OCS_PASSWORD',
  'OCS_API_TOKEN',
  'LABS_MCP_TOKEN',
  'ACE_WEB_PAT_TOKEN',
  'ACE_E2E_AUTH_TOKEN',
  'ACE_E2E_PIN',
  'ACE_E2E_BACKUP_CODE',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'ANTHROPIC_API_KEY',
];

interface Rule {
  readonly name: string;
  readonly re: RegExp;
  readonly replace: (m: string, ...g: string[]) => string;
}

const RULES: Rule[] = [
  // PEM private keys (any BEGIN…END PRIVATE KEY block; also matches \n-escaped
  // forms inside a JSON string because [\s\S] spans the literal backslash-n).
  {
    name: 'pem-private-key',
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: () => '[REDACTED-PRIVATE-KEY]',
  },
  // Authorization headers: `Authorization: Bearer <t>`, `ApiKey user:key`, Basic.
  {
    name: 'authorization-header',
    re: new RegExp(`((?:authorization"?\\s*[:=]\\s*"?)?(?:Bearer|ApiKey|Basic|Token)\\s+)${VAL}(?::${VAL})?`, 'gi'),
    replace: (_m, pre: string) => `${pre}${REDACTED}`,
  },
  // Session / CSRF cookies.
  {
    name: 'session-cookie',
    re: new RegExp(`((?:sessionid[a-z_]*|csrftoken|csrfmiddlewaretoken)\\s*=\\s*)${VAL}`, 'gi'),
    replace: (_m, pre: string) => `${pre}${REDACTED}`,
  },
  // 1Password secret references (reveal vault structure).
  {
    name: 'op-ref',
    re: /op:\/\/[^\s"'\\,}{]+/g,
    replace: () => '[REDACTED-OP-REF]',
  },
  // AWS access key ids.
  {
    name: 'aws-akid',
    re: /\bAKIA[0-9A-Z]{16}\b/g,
    replace: () => '[REDACTED-AWS-KEY]',
  },
  // Explicit ACE secret env keys: `KEY=value` or `"KEY": "value"`.
  {
    name: 'secret-env-key',
    re: new RegExp(`\\b(${SECRET_ENV_KEYS.join('|')})("?\\s*[:=]\\s*"?)${VAL}`, 'g'),
    replace: (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`,
  },
  // Generic secret-named assignments: password / token / secret / api_key / key.
  {
    name: 'generic-secret-assignment',
    re: new RegExp(
      `\\b([A-Za-z0-9_]*(?:password|passwd|secret|api[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?token|[_-]?token))("?\\s*[:=]\\s*"?)${VAL}`,
      'gi',
    ),
    replace: (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`,
  },
];

/**
 * Redact secret-shaped substrings from `text`. Returns the scrubbed string.
 * Idempotent (running twice yields the same output).
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.re, rule.replace as (substring: string, ...args: unknown[]) => string);
  }
  return out;
}

/** Names of the active rules — exported for coverage/reporting. */
export const REDACTION_RULE_NAMES = RULES.map((r) => r.name);
