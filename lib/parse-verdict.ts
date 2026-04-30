/**
 * Parse a verdict YAML file (or string) and validate it against the
 * canonical schema in `lib/verdict-schema.ts`.
 *
 * Used by the verdict-file validator preventer test and by future
 * `/ace:doctor verdicts <opp>` tooling. Skill prompt files cannot import
 * this module (they're Markdown), but every code path that reads or writes
 * a verdict YAML can.
 */

import { parse as parseYaml } from 'yaml';
import { validateVerdict, type VerdictValidationResult } from './verdict-schema.js';

export interface ParsedVerdictResult extends VerdictValidationResult {
  /** The parsed YAML value (any shape) — present even when validation fails. */
  parsed?: unknown;
  /** YAML parse error if the source could not be parsed. */
  parseError?: string;
}

export function parseVerdictYaml(source: string): ParsedVerdictResult {
  let parsed: unknown;
  try {
    parsed = parseYaml(source);
  } catch (e) {
    return {
      ok: false,
      errors: [`yaml parse: ${(e as Error).message}`],
      parseError: (e as Error).message,
    };
  }
  const v = validateVerdict(parsed);
  return { ...v, parsed };
}
