/**
 * Fixture loader for per-skill tests.
 *
 * Fixtures live under `test/fixtures/<name>/` and may include:
 *
 * - The artifact under review (e.g. `pdd.md`, `learn-app.json`)
 * - An `inputs/` subdirectory of upstream artifacts
 * - An `expected/` subdirectory with expected QA results / verdict shapes
 *
 * `ACE-Test-001` and similar are well-formed fixtures. `ACE-Bad-*`
 * are adversarial fixtures with deliberate defects; their `expected/`
 * directories document what QA should catch.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_ROOT = join(__dirname, '..', 'fixtures');

/** Absolute path to a file inside a fixture. */
export function fixturePath(name: string, ...parts: string[]): string {
  return join(FIXTURES_ROOT, name, ...parts);
}

/** Read a fixture file as utf-8 text. */
export function loadFixtureText(name: string, file: string): string {
  return readFileSync(fixturePath(name, file), 'utf-8');
}

/** Read a fixture file as parsed YAML. */
export function loadFixtureYaml<T = unknown>(name: string, file: string): T {
  return parseYaml(loadFixtureText(name, file)) as T;
}

/** Check whether a fixture file exists. */
export function fixtureExists(name: string, file: string): boolean {
  return existsSync(fixturePath(name, file));
}

/**
 * Load an expected QA result from `<fixture>/expected/<filename>`.
 *
 * Adversarial fixtures use these to document what QA should catch:
 * verdict, specific failure check ids, expected failure count.
 */
export function loadExpectedQAResult(fixtureName: string, qaResultFile: string): unknown {
  return loadFixtureYaml(fixtureName, join('expected', qaResultFile));
}
