#!/usr/bin/env npx tsx
/**
 * Scrub secrets from a session transcript before upload.
 *
 * Security audit 2026-07-31 (D1). `skills/upload-transcript` calls this
 * between resolving the transcript path and the POST to ace-web, so the
 * bytes that leave the machine have credential-shaped strings replaced with
 * `[REDACTED]`. Pure wrapper over `lib/redact-secrets.ts` (which is unit
 * tested); this file only does the file I/O.
 *
 *   npx tsx scripts/redact-transcript.ts <in.jsonl> <out.jsonl>
 *
 * Exit 0 on success (prints the number of lines that changed to stderr),
 * non-zero on I/O error. Never prints transcript content.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { redactSecrets } from '../lib/redact-secrets.js';

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: redact-transcript.ts <in.jsonl> <out.jsonl>');
  process.exit(2);
}

const raw = readFileSync(inPath, 'utf8');
const redacted = redactSecrets(raw);
writeFileSync(outPath, redacted, 'utf8');

// Count changed lines for an operator-visible signal — never echo content.
let changed = 0;
const a = raw.split('\n');
const b = redacted.split('\n');
for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changed++;
console.error(`[redact-transcript] scrubbed ${changed} line(s) of ${a.length}`);
